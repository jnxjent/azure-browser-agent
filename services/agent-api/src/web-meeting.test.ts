import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GraphWebMeetingClient,
  toJapanLocalDateTime,
  type GraphCallRequest,
  type GraphCallResponse,
} from "./graph-web-meeting.js";
import {
  WebMeetingNotRequestedError,
  describeWebMeeting,
  ensureWebMeeting,
} from "./web-meeting-service.js";
import { WebMeetingStore } from "./web-meeting-store.js";

/**
 * 通常テストはGraphをモック化する。実カレンダーへの作成と受信箱の確認は、
 * テスト用アカウントと後片付けを定めた実機テスト（メモ9.2）で別に行う。
 */

const temporaryDirectories: string[] = [];
const OWNER = { userId: "user-1", threadId: "thread-1" };
const SCHEDULE = {
  subject: "打ち合わせ",
  start: "2026-10-01T10:00:00+09:00",
  end: "2026-10-01T11:00:00+09:00",
};
const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_example/0";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "web-meeting-"));
  temporaryDirectories.push(directory);
  return join(directory, "web-meetings.json");
}

interface FakeGraphOptions {
  joinUrlOnCreate?: string | undefined;
  eventJoinUrl?: string | undefined;
  joinMeetingIdSettings?: Record<string, unknown> | undefined;
  failCreate?: boolean;
  failDetails?: boolean;
}

function fakeGraph(options: FakeGraphOptions = {}) {
  const calls: GraphCallRequest[] = [];
  const call = async (request: GraphCallRequest): Promise<GraphCallResponse> => {
    calls.push(request);
    if (request.method === "POST" && request.url.endsWith("/me/events")) {
      if (options.failCreate) return { status: 503, body: { error: "unavailable" } };
      return {
        status: 201,
        body: {
          id: "event-1",
          ...(options.joinUrlOnCreate === undefined
            ? {}
            : { onlineMeeting: { joinUrl: options.joinUrlOnCreate } }),
        },
      };
    }
    if (request.method === "PATCH") return { status: 200, body: { id: "event-1" } };
    if (request.method === "GET" && request.url.includes("/me/events/")) {
      return {
        status: 200,
        body: options.eventJoinUrl === undefined
          ? {}
          : { onlineMeeting: { joinUrl: options.eventJoinUrl } },
      };
    }
    if (request.method === "GET" && request.url.includes("/me/onlineMeetings")) {
      if (options.failDetails) return { status: 500, body: {} };
      return {
        status: 200,
        body: {
          value: [
            {
              joinWebUrl: options.joinUrlOnCreate ?? options.eventJoinUrl ?? JOIN_URL,
              ...(options.joinMeetingIdSettings === undefined
                ? {}
                : { joinMeetingIdSettings: options.joinMeetingIdSettings }),
            },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  };
  return { calls, client: new GraphWebMeetingClient(call) };
}

function countCreateCalls(calls: GraphCallRequest[]): number {
  return calls.filter((call) => call.method === "POST" && call.url.endsWith("/me/events")).length;
}

async function requestedStore(): Promise<WebMeetingStore> {
  const store = new WebMeetingStore(await temporaryStorePath());
  await store.setRequested(OWNER, true);
  return store;
}

describe("ensureWebMeeting", () => {
  it("refuses to create a meeting that was never requested, without calling Graph", async () => {
    const store = new WebMeetingStore(await temporaryStorePath());
    const { calls, client } = fakeGraph({ joinUrlOnCreate: JOIN_URL });
    await assert.rejects(
      ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE }),
      WebMeetingNotRequestedError,
    );
    assert.equal(calls.length, 0);
  });

  it("sends no attendees, so Teams sends no invitation", async () => {
    const store = await requestedStore();
    const { calls, client } = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    const created = calls.find((call) => call.method === "POST")?.body as Record<string, unknown>;
    assert.deepEqual(created.attendees, []);
    assert.equal(created.isOnlineMeeting, true);
    assert.equal(created.onlineMeetingProvider, "teamsForBusiness");
    assert.equal(
      (created.start as Record<string, unknown>).dateTime,
      "2026-10-01T10:00:00",
    );
  });

  it("stores the transaction ID before creating and the event ID after, then resumes", async () => {
    const path = await temporaryStorePath();
    const store = new WebMeetingStore(path);
    await store.setRequested(OWNER, true);
    const failing = fakeGraph({ failCreate: true });
    await assert.rejects(
      ensureWebMeeting({
        store,
        client: failing.client,
        owner: OWNER,
        schedule: SCHEDULE,
        newTransactionId: () => "fixed-transaction",
      }),
    );
    const afterFailure = await store.get(OWNER);
    assert.equal(afterFailure?.transactionId, "fixed-transaction");
    assert.equal(afterFailure?.eventId, undefined);
    assert.equal(afterFailure?.status, "failed");

    // A restart must not create a second meeting: the same transaction ID is resent.
    const restarted = new WebMeetingStore(path);
    const succeeding = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    const record = await ensureWebMeeting({
      store: restarted,
      client: succeeding.client,
      owner: OWNER,
      schedule: SCHEDULE,
      newTransactionId: () => "a-different-transaction",
    });
    const created = succeeding.calls.find((call) => call.method === "POST")
      ?.body as Record<string, unknown>;
    assert.equal(created.transactionId, "fixed-transaction");
    assert.equal(record.eventId, "event-1");
    assert.equal(record.status, "ready");
    assert.equal(record.revision, 1);
  });

  it("creates only one meeting when the action is repeated", async () => {
    const store = await requestedStore();
    const { calls, client } = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    assert.equal(countCreateCalls(calls), 1);
  });

  it("resumes from a created meeting whose details could not be read", async () => {
    const store = await requestedStore();
    const failing = fakeGraph({ joinUrlOnCreate: JOIN_URL, failDetails: true });
    await assert.rejects(
      ensureWebMeeting({ store, client: failing.client, owner: OWNER, schedule: SCHEDULE }),
    );
    const partial = await store.get(OWNER);
    assert.equal(partial?.eventId, "event-1");
    assert.equal(partial?.joinUrl, JOIN_URL);
    assert.equal(partial?.status, "failed");

    const succeeding = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    const record = await ensureWebMeeting({
      store,
      client: succeeding.client,
      owner: OWNER,
      schedule: SCHEDULE,
    });
    assert.equal(countCreateCalls(succeeding.calls), 0);
    assert.equal(record.meetingId, "123456789");
    assert.equal(record.status, "ready");
  });

  it("reads the event again when the creation response carries no join URL", async () => {
    const store = await requestedStore();
    const { calls, client } = fakeGraph({
      eventJoinUrl: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    const record = await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    assert.ok(calls.some((call) => call.method === "GET" && call.url.includes("/me/events/")));
    assert.equal(record.joinUrl, JOIN_URL);
  });

  it("reuses the same meeting when the time changes, and marks older cards stale", async () => {
    const store = await requestedStore();
    const { calls, client } = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    const first = await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    const moved = await ensureWebMeeting({
      store,
      client,
      owner: OWNER,
      schedule: { ...SCHEDULE, start: "2026-10-01T13:00:00+09:00", end: "2026-10-01T14:00:00+09:00" },
    });
    assert.equal(countCreateCalls(calls), 1);
    assert.ok(calls.some((call) => call.method === "PATCH"));
    assert.equal(moved.revision, first.revision + 1);
    assert.equal(moved.joinUrl, first.joinUrl);
    assert.equal(moved.meetingId, first.meetingId);
  });

  it("stays unfinished while details are missing, so a retry can still fill them in", async () => {
    const store = await requestedStore();
    const withoutSettings = fakeGraph({ joinUrlOnCreate: JOIN_URL });
    const pending = await ensureWebMeeting({
      store,
      client: withoutSettings.client,
      owner: OWNER,
      schedule: SCHEDULE,
    });
    // Graph's online-meeting lookup can lag event creation; marking this "ready"
    // would make every later retry short-circuit and never fill in the details.
    assert.equal(pending.status, "created_pending_details");
    assert.equal(pending.meetingId, undefined);

    const late = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    const filled = await ensureWebMeeting({
      store,
      client: late.client,
      owner: OWNER,
      schedule: SCHEDULE,
    });
    assert.equal(countCreateCalls(late.calls), 0);
    assert.equal(filled.status, "ready");
    assert.equal(filled.meetingId, "123456789");
    assert.equal(filled.passcode, "abc123");
  });

  it("refuses details that belong to a different meeting, and an empty lookup", async () => {
    const mismatched = await requestedStore();
    // A lookup answering with someone else's meeting must never reach the copy text.
    const otherClient = new GraphWebMeetingClient(async (request) =>
      request.method === "GET" && request.url.includes("/me/onlineMeetings")
        ? {
            status: 200,
            body: {
              value: [
                {
                  joinWebUrl: "https://teams.microsoft.com/l/meetup-join/someone-else",
                  joinMeetingIdSettings: { joinMeetingId: "999", passcode: "leak" },
                },
              ],
            },
          }
        : { status: 201, body: { id: "event-1", onlineMeeting: { joinUrl: JOIN_URL } } },
    );
    await assert.rejects(
      ensureWebMeeting({ store: mismatched, client: otherClient, owner: OWNER, schedule: SCHEDULE }),
    );
    assert.equal((await mismatched.get(OWNER))?.meetingId, undefined);

    const empty = await requestedStore();
    const emptyClient = new GraphWebMeetingClient(async (request) =>
      request.method === "GET" && request.url.includes("/me/onlineMeetings")
        ? { status: 200, body: { value: [] } }
        : { status: 201, body: { id: "event-1", onlineMeeting: { joinUrl: JOIN_URL } } },
    );
    await assert.rejects(
      ensureWebMeeting({ store: empty, client: emptyClient, owner: OWNER, schedule: SCHEDULE }),
    );
  });

  it("escapes a quote in the join URL instead of breaking out of the OData filter", async () => {
    const store = await requestedStore();
    const quoted = "https://teams.microsoft.com/l/meetup-join/a'b";
    const { calls, client } = fakeGraph({
      joinUrlOnCreate: quoted,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    const lookup = calls.find((call) => call.url.includes("/me/onlineMeetings"));
    const filter = decodeURIComponent(lookup?.url.split("$filter=")[1] ?? "");
    assert.ok(filter.includes("a''b"), filter);
  });

  it("separates a passcode that is not required from one it could not read", async () => {
    const notRequired = await requestedStore();
    const withoutPasscode = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", isPasscodeRequired: false, passcode: null },
    });
    const relaxed = await ensureWebMeeting({
      store: notRequired,
      client: withoutPasscode.client,
      owner: OWNER,
      schedule: SCHEDULE,
    });
    assert.equal(relaxed.passcodeAvailability, "not_required");
    assert.equal(relaxed.passcode, undefined);

    const unreadable = await requestedStore();
    const withoutSettings = fakeGraph({ joinUrlOnCreate: JOIN_URL });
    const missing = await ensureWebMeeting({
      store: unreadable,
      client: withoutSettings.client,
      owner: OWNER,
      schedule: SCHEDULE,
    });
    assert.equal(missing.passcodeAvailability, "unavailable");
    assert.equal(missing.meetingId, undefined);

    const relaxedView = describeWebMeeting(relaxed);
    const missingView = describeWebMeeting(missing);
    assert.equal(relaxedView.complete, true);
    assert.equal(missingView.complete, false);
    assert.notDeepEqual(relaxedView.notes, missingView.notes);
  });
});

describe("describeWebMeeting", () => {
  it("returns copy text and never claims the meeting was registered", async () => {
    const store = await requestedStore();
    const { client } = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    const view = describeWebMeeting(
      await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE }),
    );
    assert.equal(view.registered, false);
    assert.ok(view.copyText?.includes("参加URL: "));
    assert.ok(view.copyText?.includes("会議ID: 123456789"));
    assert.ok(view.notes.some((note) => note.includes("末尾")));
    assert.ok(view.notes.some((note) => note.includes("古いWEB会議情報")));
    assert.ok(view.notes.some((note) => note.includes("Teams側に残ります")));
  });

  it("flags a rescheduled meeting so the Teams event can still be updated", async () => {
    const store = await requestedStore();
    const { client } = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    const record = await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });

    const unchanged = describeWebMeeting(record, SCHEDULE);
    assert.equal(unchanged.scheduleChanged, false);

    const moved = { ...SCHEDULE, start: "2026-10-01T13:00:00+09:00", end: "2026-10-01T14:00:00+09:00" };
    const stale = describeWebMeeting(record, moved);
    // Without this the card shows a complete meeting, hides every action, and the
    // Teams event silently keeps the old time.
    assert.equal(stale.scheduleChanged, true);
    assert.equal(stale.complete, true);
    assert.equal(stale.copyText, undefined);
    assert.ok(stale.notes.some((note) => note.includes("Teams側の予定は以前のまま")));

    const renamed = describeWebMeeting(record, { ...SCHEDULE, subject: "別の件名" });
    assert.equal(renamed.scheduleChanged, true);
    assert.equal(renamed.copyText, undefined);
  });

  it("reports nothing for a conversation that never requested a web meeting", () => {
    const view = describeWebMeeting(undefined);
    assert.equal(view.requested, false);
    assert.equal(view.copyText, undefined);
    assert.equal(view.registered, false);
  });
});

describe("WebMeetingStore", () => {
  it("keeps the meeting when the user later says a web meeting is not needed", async () => {
    const store = await requestedStore();
    const { client } = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    await store.setRequested(OWNER, false);
    const record = await store.get(OWNER);
    // The meeting is not deleted behind the user's back; it is reported as still there.
    assert.equal(record?.requested, false);
    assert.equal(record?.eventId, "event-1");
    assert.equal(record?.joinUrl, JOIN_URL);
  });

  it("keeps one thread's meeting out of another thread's card", async () => {
    const path = await temporaryStorePath();
    const store = new WebMeetingStore(path);
    await store.setRequested(OWNER, true);
    await store.setRequested({ userId: "user-2", threadId: "thread-1" }, true);
    const { client } = fakeGraph({
      joinUrlOnCreate: JOIN_URL,
      joinMeetingIdSettings: { joinMeetingId: "123456789", passcode: "abc123" },
    });
    await ensureWebMeeting({ store, client, owner: OWNER, schedule: SCHEDULE });
    assert.equal((await store.get({ userId: "user-2", threadId: "thread-1" }))?.eventId, undefined);
    assert.equal(await store.get({ userId: "user-1", threadId: "thread-2" }), undefined);
  });

  it("rejects a stored passcode that is not marked as required", async () => {
    const store = new WebMeetingStore(await temporaryStorePath());
    await assert.rejects(
      store.mutate(OWNER, (current) => ({
        ...current,
        passcode: "abc",
        passcodeAvailability: "not_required",
      })),
      TypeError,
    );
  });
});

describe("toJapanLocalDateTime", () => {
  it("converts an instant to the local time Graph expects", () => {
    assert.equal(toJapanLocalDateTime("2026-10-01T10:00:00+09:00"), "2026-10-01T10:00:00");
    assert.equal(toJapanLocalDateTime("2026-10-01T01:00:00Z"), "2026-10-01T10:00:00");
    assert.throws(() => toJapanLocalDateTime("2026-10-01T10:00:00"), TypeError);
  });
});
