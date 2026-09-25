import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BookableAvailabilitySlot } from "@azure-browser-agent/agent-core";
import { createRun } from "@azure-browser-agent/agent-core";
import {
  buildShowCandidatesResponse,
  isAvailabilityRefreshRequest,
  hasExplicitSearchPeriod,
  getReopenableBookingProposal,
  isRunSuperseded,
  isWebMeetingFacilityQuery,
  readNumberedCandidateSelection,
  buildEarliestCandidatesRun,
  isEarliestMeetingRequest,
  inheritAvailabilityPreferences,
  buildRoomOnlyChangeTask,
  formatFacilityChoiceMessage,
  formatUnavailableFacilityChoiceMessage,
  getCompanyWideAvailability,
  inferFacilityScope,
  cleanFacilityChoiceReply,
  isFreshAvailabilityRequest,
  isAuthorizedRequest,
  isRunOwnerRequest,
  isWebMeetingEnabled,
  isParticipantChoiceCancellationRequest,
  isShowCandidatesRequest,
  matchOfferedOrganizations,
  parseFacilityPreferenceTable,
  resolveFacilityWithPreference,
  resolveAutomaticFacilityForSlot,
  resolveEarliestPreferredFacility,
  resizePendingConversationDuration,
  readRequestedDurationChange,
  resizeBookableAvailability,
  restrictSlotToFacilityType,
  resolveTimeOnlySelection,
  type PendingBookingConversation,
} from "./server.js";

const START = "2026-08-24T00:30:00.000Z";

it("selects a numbered candidate with a WEB request without treating WEB as a room", () => {
  assert.equal(readNumberedCandidateSelection("では上記１で。WEB会議も設定して"), 1);
  assert.equal(readNumberedCandidateSelection("では、1で"), 1);
  assert.equal(readNumberedCandidateSelection("では候補2で、Teams会議も作成して"), 2);
  assert.equal(readNumberedCandidateSelection("では1で。会議室はアクトで"), undefined);
  assert.equal(readNumberedCandidateSelection("では1で。WEB会議は不要"), undefined);
  assert.equal(isWebMeetingFacilityQuery("WEB会議"), true);
  assert.equal(isWebMeetingFacilityQuery("Teams会議"), true);
  assert.equal(isWebMeetingFacilityQuery("有玉大会議室"), false);
});

it("recognizes re-search after a passed meeting without mistaking room changes for a refresh", () => {
  for (const prompt of ["最短の会議開始時間が過ぎたので、再度候補を挙げて", "もう一度候補を出して", "候補を再検索して"]) {
    assert.equal(isAvailabilityRefreshRequest(prompt), true);
  }
  assert.equal(isAvailabilityRefreshRequest("アクトの別の会議室に変更して"), false);
  assert.equal(hasExplicitSearchPeriod("髙田部長、鈴木清彦部長、私で最短で打ち合わせ可能な日程を挙げて"), false);
  for (const prompt of ["今週の最短", "9/24の候補", "来月の最短", "２週間以内で最短"]) assert.equal(hasExplicitSearchPeriod(prompt), true);
});

it("permits reopening a manual confirmation or retrying a failed handoff, but not active or finished runs", () => {
  const run = createRun({ userId: "test", threadId: "reopen", site: "desknets", mode: "write", prompt: "再表示" });
  const proposal = { title: "相談", start: "2099-09-18T01:00:00Z", end: "2099-09-18T02:00:00Z",
    participantIds: ["本人"], facilityId: "会議室", emailNotificationWillBeSent: false, selfNotificationSuppressed: false as const };
  run.result = { summary: "prepared", evidence: [], approvalRequest: proposal };
  run.status = "awaiting_approval";
  assert.equal(getReopenableBookingProposal(run), proposal);
  run.result = { summary: "manual confirmation", evidence: [], manualActionRequest: proposal };
  run.status = "awaiting_user_input";
  assert.equal(getReopenableBookingProposal(run), proposal);
  run.approval = { requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() };
  run.status = "failed";
  assert.equal(getReopenableBookingProposal(run), proposal);
  for (const status of ["queued", "running", "completed", "cancelled"] as const) {
    run.status = status;
    assert.equal(getReopenableBookingProposal(run), undefined);
  }
  run.status = "awaiting_user_input";
  run.result = { summary: "needs participant input", evidence: [] };
  assert.equal(getReopenableBookingProposal(run), undefined);
});

it("rejects an older card after a later run in the same user and thread", () => {
  const make = (userId: string, threadId: string) => createRun({
    userId, threadId, site: "desknets", mode: "read", prompt: "test",
  });
  const old = make("user-1", "thread-1");
  const otherUser = make("user-2", "thread-1");
  const otherThread = make("user-1", "thread-2");
  const latest = make("user-1", "thread-1");
  const runs = [old, otherUser, otherThread, latest];
  assert.equal(isRunSuperseded(old, runs), true);
  assert.equal(isRunSuperseded(latest, runs), false);
  assert.equal(isRunSuperseded(otherUser, runs), false);
  assert.equal(isRunSuperseded(otherThread, runs), false);
});

it("room-only replies inherit selected time, people, title and email without a new interpretation", () => {
  const selected = {start:"2099-09-18T01:00:00Z",end:"2099-09-18T01:30:00Z",durationMinutes:30,participantIds:["本人","髙田"],availableFacilityIds:["有玉小会議室"]};
  const saved = {context:{date:"2099-09-18",durationMinutes:30,title:"相談",participantIds:selected.participantIds,availability:[selected]},selectedSlot:selected,facilityId:"有玉大会議室",sendEmail:false};
  const task = buildRoomOnlyChangeTask("会議室を有玉小会議室に変えて",saved);
  assert.equal(task?.selectedStart,selected.start);
  assert.equal(task?.selectedEnd,selected.end);
  assert.equal(task?.title,"相談");
  assert.equal(task?.sendEmail,false);
  assert.equal(task?.facilityScope,"有玉");
  assert.equal(task?.facilityOnlyChange,true);
  for (const prompt of ["有玉の会議室", "有玉の会議室で", "有玉の会議室にして", "では、有玉の会議室でお願いします"]) {
    assert.equal(buildRoomOnlyChangeTask(prompt,saved)?.facilityQuery,"有玉",prompt);
  }
  assert.equal(buildRoomOnlyChangeTask("有玉小会議室",saved)?.facilityQuery,"有玉小会議室");
  const alternative = buildRoomOnlyChangeTask("会議室を、アクトの別会議室に変えて",saved);
  assert.equal(alternative?.facilityQuery,"アクト");
  assert.equal(alternative?.excludePreviousFacility,true);
  assert.equal(buildRoomOnlyChangeTask("明日の10時にして、会議室を有玉小会議室に変えて",saved),undefined);
  assert.equal(buildRoomOnlyChangeTask("会議室を有玉小会議室に変えて",undefined),undefined);
  assert.deepEqual(saved.context.participantIds,["本人","髙田"]);
  const fullWidth = "有玉大会議室　ＡＥＲ～アリア～";
  const choice = buildRoomOnlyChangeTask(fullWidth, {...saved,
    context:{...saved.context,availability:[{...selected,availableFacilityIds:[fullWidth]}]},
    awaitingFacilityChoice:{selectedStart:selected.start,selectedEnd:selected.end,title:"相談",sendEmail:false,facilityScope:"有玉",excludedFacilities:[]},
  });
  assert.equal(choice?.facilityQuery,fullWidth);
  assert.equal(choice?.facilityOnlyChange,true);
});

describe("earliest candidate choices", () => {
  it("retains earliest mode and company-wide fallback during model-generated duration refinements", () => {
    const task = {type:"find_availability" as const,date:"2099-09-21",endDate:"2099-09-27",durationMinutes:30,
      participants:[{name:"鈴木清彦",organization:"経営企画部"}]};
    const previous = {...task,selectionMode:"earliest" as const,participantIds:["鈴木清彦"],availability:[],
      participants:[{name:"鈴木清彦",organization:"経営企画部",organizationFallback:true}]};
    const next = inheritAvailabilityPreferences(task,previous,"打ち合わせ時間は３０分でいい");
    assert.equal(next.selectionMode,"earliest");
    assert.equal(next.participants[0]?.organizationFallback,true);
    assert.equal(inheritAvailabilityPreferences(task,previous,"経営企画部の鈴木清彦さんで").participants[0]?.organizationFallback,undefined);
    assert.equal(task.participants[0]?.organization,"経営企画部");
  });
  it("recognizes the reported duration refinement as an earliest search", () => {
    assert.equal(isEarliestMeetingRequest("打ち合わせ時間は３０分でいい。その前提で、もっと前に空きはある？"), true);
    assert.equal(isEarliestMeetingRequest("もっと早い候補は？"), true);
    assert.equal(isEarliestMeetingRequest("会議室を変えて"), false);
  });
  const makeRun = (availability: BookableAvailabilitySlot[]) => ({
    ...createRun({ userId: "test", threadId: "earliest-test", site: "desknets", mode: "read", prompt: "最短の日程をあげて" }),
    result: { summary: "availability", evidence: [], pendingBooking: {
      date: "2099-09-21", endDate: "2099-09-27", durationMinutes: 60,
      participantIds: ["本人", "髙田", "鈴木清彦"], availability,
      allFacilityAvailability: availability,
    } },
  });
  it("offers five chronological choices, labels only the first, and does not book automatically", () => {
    const slots = Array.from({ length: 7 }, (_, index) => ({
      start: `2099-09-${21 + index}T01:00:00.000Z`, end: `2099-09-${21 + index}T02:00:00.000Z`,
      durationMinutes: 60, participantIds: ["本人", "髙田", "鈴木清彦"],
      availableFacilityIds: ["アクトミーティングルームC"],
    }));
    const source = makeRun([...slots].reverse().concat(slots[0]!));
    const run = buildEarliestCandidatesRun(source);
    assert.deepEqual(run.result?.availability, slots.slice(0, 5));
    assert.deepEqual(run.result?.pendingBooking?.availability, slots.slice(0, 5));
    assert.equal((run.result?.assistantMessage?.match(/＜最短＞/g) ?? []).length, 1);
    assert.match(run.result!.assistantMessage!, /1\. ＜最短＞/);
    assert.equal(run.result?.approvalRequest, undefined);
    assert.equal(run.result?.booking, undefined);
    assert.equal(run.input.mode, "read");
    assert.equal(source.result.pendingBooking.availability.length, 8);
  });
  it("does not invent five choices when fewer or none are available", () => {
    const candidate = { start: "2099-09-21T01:00:00Z", end: "2099-09-21T02:00:00Z",
      durationMinutes: 60, participantIds: ["本人"], availableFacilityIds: ["アクト大会議室"] };
    assert.equal(buildEarliestCandidatesRun(makeRun([candidate])).result?.availability?.length, 1);
    const empty = buildEarliestCandidatesRun(makeRun([{ ...candidate, availableFacilityIds: [] }]));
    assert.deepEqual(empty.result?.availability, []);
    assert.doesNotMatch(empty.result!.assistantMessage!, /＜最短＞/);
  });
});
const END = "2026-08-24T01:00:00.000Z";

function slot(availableFacilityIds: string[]): BookableAvailabilitySlot {
  return {
    start: START,
    end: END,
    participantIds: ["u1"],
    durationMinutes: 30,
    availableFacilityIds,
  };
}

describe("isAuthorizedRequest", () => {
  it("allows local development when AGENT_API_KEY is unset or blank", () => {
    assert.equal(isAuthorizedRequest(undefined, undefined), true);
    assert.equal(isAuthorizedRequest(undefined, "  "), true);
  });

  it("accepts a matching Bearer API key", () => {
    assert.equal(isAuthorizedRequest("Bearer test-secret", "test-secret"), true);
    assert.equal(isAuthorizedRequest("bearer test-secret", "test-secret"), true);
  });

  it("rejects missing, malformed, and incorrect credentials", () => {
    assert.equal(isAuthorizedRequest(undefined, "test-secret"), false);
    assert.equal(isAuthorizedRequest("Basic test-secret", "test-secret"), false);
    assert.equal(isAuthorizedRequest("Bearer wrong-secret", "test-secret"), false);
    assert.equal(isAuthorizedRequest(["Bearer test-secret"], "test-secret"), false);
  });
});

describe("restrictSlotToFacilityType", () => {
  const mixed = slot([
    "アクト応接室",
    "アクト会議室A",
    "アクトミーティングルームB",
  ]);

  it("keeps meeting rooms but excludes reception rooms", () => {
    assert.deepEqual(
      restrictSlotToFacilityType(mixed, "meeting_room").availableFacilityIds,
      ["アクト会議室A", "アクトミーティングルームB"],
    );
  });

  it("keeps only reception rooms when requested", () => {
    assert.deepEqual(
      restrictSlotToFacilityType(mixed, "reception_room").availableFacilityIds,
      ["アクト応接室"],
    );
  });

  it("lets a location-scoped request select only an actual free meeting room", () => {
    const available = slot([
      "有玉応接室 STELLA",
      "有玉大会議室 AER",
      "アクト大会議室",
    ]);
    const meetingRooms = restrictSlotToFacilityType(available, "meeting_room");
    assert.equal(
      resolveAutomaticFacilityForSlot(
        "有玉",
        meetingRooms,
        undefined,
        undefined,
        {},
        {},
      ),
      "有玉大会議室 AER",
    );
  });
});

describe("getCompanyWideAvailability", () => {
  it("retains another location for a later room change", () => {
    const filtered = slot(["アクト会議室A"]);
    const companyWide = slot(["アクト会議室A", "有玉会議室"]);
    assert.equal(
      getCompanyWideAvailability({
        date: "2026-09-14",
        durationMinutes: 30,
        participantIds: ["u1"],
        availability: [filtered],
        allFacilityAvailability: [companyWide],
      })[0]?.availableFacilityIds.includes("有玉会議室"),
      true,
    );
  });
});

describe("resizeBookableAvailability", () => {
  it("extends a selected 30-minute slot only when the same room stays free", () => {
    const first = slot(["アクト会議室A", "有玉会議室"]);
    const second = {
      ...slot(["アクト会議室A"]),
      start: END,
      end: "2026-08-24T01:30:00.000Z",
    };
    const resized = resizeBookableAvailability([first, second], 60)
      .find((candidate) => candidate.start === START);
    assert.equal(resized?.end, "2026-08-24T01:30:00.000Z");
    assert.deepEqual(resized?.availableFacilityIds, ["アクト会議室A"]);
  });

  it("does not offer an extension when the selected room becomes occupied", () => {
    const first = slot(["アクト会議室A"]);
    const second = {
      ...slot(["有玉会議室"]),
      start: END,
      end: "2026-08-24T01:30:00.000Z",
    };
    assert.equal(
      resizeBookableAvailability([first, second], 60)
        .some((candidate) => candidate.start === START),
      false,
    );
  });

  it("applies a duration refinement to the saved thread before resolving its time", () => {
    const sixtyMinuteSlot = {
      ...slot(["アクトミーティングルームC", "アクト第2会議室"]),
      end: "2026-08-24T01:30:00.000Z",
      durationMinutes: 60,
    };
    const conversation = resizePendingConversationDuration({
      context: {
        date: "2026-08-24",
        endDate: "2026-08-24",
        durationMinutes: 60,
        participantIds: ["u1"],
        availability: [sixtyMinuteSlot],
        allFacilityAvailability: [sixtyMinuteSlot],
      },
    }, 30);
    assert.equal(conversation.context.durationMinutes, 30);
    assert.equal(conversation.context.availability[0]?.end, END);
    assert.equal(
      resolveTimeOnlySelection(
        "では8/24の9:30開始で。会議時間は30分でいい。",
        conversation.context,
      )?.end,
      END,
    );
  });
});

describe("readRequestedDurationChange", () => {
  it("does not mistake clock minutes for a requested meeting duration", () => {
    assert.equal(readRequestedDurationChange(undefined, "16時30分開始で"), undefined);
    assert.equal(readRequestedDurationChange(undefined, "16時開始で1時間半"), 90);
    assert.equal(readRequestedDurationChange(undefined, "60分"), 60);
  });
  it("keeps a duration embedded in the same time-selection reply", () => {
    assert.equal(
      readRequestedDurationChange(undefined, "では9/16 15:30開始で。会議時間は30分でいい。"),
      30,
    );
  });
});

describe("isWebMeetingEnabled", () => {
  it("stays off unless the flag is explicitly set to true", () => {
    // Off by default: no web meeting is requested, created or displayed until the
    // delegated scopes have been consented to and the flag is turned on.
    assert.equal(isWebMeetingEnabled(undefined), false);
    assert.equal(isWebMeetingEnabled(""), false);
    assert.equal(isWebMeetingEnabled("false"), false);
    assert.equal(isWebMeetingEnabled("1"), false);
    assert.equal(isWebMeetingEnabled("TRUE"), false);
    assert.equal(isWebMeetingEnabled("true"), true);
    assert.equal(isWebMeetingEnabled(" true "), true);
  });
});

describe("isRunOwnerRequest", () => {
  const run = {
    input: {
      userId: "user-1",
      threadId: "thread-1",
      site: "desknets" as const,
      mode: "write" as const,
      prompt: "confirm",
    },
  };

  it("requires the same user and chat thread when API authentication is enabled", () => {
    assert.equal(isRunOwnerRequest({ headers: {
      "x-user-id": "user-1",
      "x-chat-thread-id": "thread-1",
    } }, run, "secret"), true);
    assert.equal(isRunOwnerRequest({ headers: {
      "x-user-id": "another-user",
      "x-chat-thread-id": "thread-1",
    } }, run, "secret"), false);
    assert.equal(isRunOwnerRequest({ headers: {
      "x-user-id": "user-1",
      "x-chat-thread-id": "another-thread",
    } }, run, "secret"), false);
  });

  it("preserves unauthenticated loopback development", () => {
    assert.equal(isRunOwnerRequest({ headers: {} }, run, undefined), true);
  });
});

describe("resolveTimeOnlySelection", () => {
  it("resolves the reported full-width reply with the saved duration and participants", () => {
    const candidate = {
      ...slot(["アクトミーティングルームC"]),
      start: "2026-09-16T07:00:00.000Z", end: "2026-09-16T08:00:00.000Z", durationMinutes: 60,
    };
    const context = {
      date: "2026-09-16", endDate: "2026-09-22", durationMinutes: 60,
      participantIds: ["u1"], availability: [candidate],
    };
    for (const reply of ["では９/１６, １６時開始で", "9/16 午後4時で", "9/16 16:00で"]) {
      assert.deepEqual(resolveTimeOnlySelection(reply, context), candidate, reply);
    }
    assert.deepEqual(resolveTimeOnlySelection("60分", context, {
      date: "2026-09-16", startTime: "16:00", endTime: null,
    }), candidate);
  });
  const afternoonSlot = {
    ...slot(["アクト会議室A"]),
    start: "2026-09-14T06:00:00.000Z",
    end: "2026-09-14T07:00:00.000Z",
  };
  const context = {
    date: "2026-09-14",
    endDate: "2026-09-14",
    durationMinutes: 60,
    participantIds: ["u1"],
    availability: [afternoonSlot],
  };
  const halfHourSlot = {
    ...slot(["アクト会議室A"]),
    start: "2026-09-14T03:00:00.000Z",
    end: "2026-09-14T03:30:00.000Z",
  };

  it("resolves a time-only follow-up against the previous availability", () => {
    assert.equal(
      resolveTimeOnlySelection("では、15時―16時で。", context)?.start,
      afternoonSlot.start,
    );
    assert.equal(
      resolveTimeOnlySelection("では15:00〜16:00で確定したい", context)?.start,
      afternoonSlot.start,
    );
    assert.equal(
      resolveTimeOnlySelection("では、以下で。\n15:00〜16:00", context)?.start,
      afternoonSlot.start,
    );
  });

  it("returns undefined for a non-time reply", () => {
    assert.equal(resolveTimeOnlySelection("候補を見せて", context), undefined);
  });

  it("infers the end from the saved duration for a start-only reply", () => {
    assert.equal(
      resolveTimeOnlySelection(
        "では以下で。\n12:00開始",
        { ...context, durationMinutes: 30, availability: [halfHourSlot] },
      )?.end,
      halfHourSlot.end,
    );
  });

  it("uses an explicit date and Japanese half-hour when the same time exists on multiple days", () => {
    const september14 = {
      ...halfHourSlot,
      start: "2026-09-14T02:30:00.000Z",
      end: "2026-09-14T03:00:00.000Z",
    };
    const september15 = {
      ...halfHourSlot,
      start: "2026-09-15T02:30:00.000Z",
      end: "2026-09-15T03:00:00.000Z",
    };
    assert.equal(
      resolveTimeOnlySelection(
        "では、9/15の11時半スタートで。会議室はアクト応接室にして",
        {
          ...context,
          endDate: "2026-09-15",
          durationMinutes: 30,
          availability: [september14, september15],
        },
      )?.start,
      september15.start,
    );
  });

  it("uses the validated AzureChat date and time when the raw follow-up has no parseable time", () => {
    const september15 = {
      ...halfHourSlot,
      start: "2026-09-15T02:30:00.000Z",
      end: "2026-09-15T03:00:00.000Z",
    };
    assert.equal(
      resolveTimeOnlySelection(
        "では、その時間で。会議室はアクト応接室にして",
        {
          ...context,
          endDate: "2026-09-15",
          durationMinutes: 30,
          availability: [september15],
        },
        { date: "2026-09-15", startTime: "11:30", endTime: null },
      )?.start,
      september15.start,
    );
  });
});

describe("resolveAutomaticFacilityForSlot", () => {
  it("chooses the preferred available room within an explicitly requested location", () => {
    assert.equal(
      resolveAutomaticFacilityForSlot(
        "アクト",
        slot(["アクト会議室A", "アクトミーティングルームC", "有玉会議室"]),
        "経営企画部",
        undefined,
      ),
      "アクトミーティングルームC",
    );
  });
});

describe("resolveEarliestPreferredFacility", () => {
  const earliest = {
    ...slot(["品川会議室", "アクト第2会議室"]),
    start: "2099-09-17T00:00:00.000Z",
    end: "2099-09-17T01:00:00.000Z",
  };
  const later = {
    ...slot(["アクトミーティングルームC"]),
    start: "2099-09-17T01:00:00.000Z",
    end: "2099-09-17T02:00:00.000Z",
  };

  it("prioritizes the earliest time, then the configured room order", () => {
    const result = resolveEarliestPreferredFacility(
      [later, earliest],
      "経営企画部",
      undefined,
      {},
      { "経営企画部": ["アクトミーティングルームC", "アクト"] },
    );
    assert.equal(result?.slot.start, earliest.start);
    assert.equal(result?.facilityId, "アクト第2会議室");
  });

  it("uses a persisted user preference before the department default", () => {
    const result = resolveEarliestPreferredFacility(
      [{ ...earliest, availableFacilityIds: ["有玉大会議室", "アクト第2会議室"] }],
      "経営企画部",
      undefined,
      {},
      { "経営企画部": ["アクト"] },
      ["有玉"],
    );
    assert.equal(result?.facilityId, "有玉大会議室");
  });

  it("returns undefined instead of guessing outside the preference list", () => {
    assert.equal(
      resolveEarliestPreferredFacility(
        [{ ...earliest, availableFacilityIds: ["品川会議室"] }],
        "経営企画部",
        undefined,
        {},
        { "経営企画部": ["アクト"] },
      ),
      undefined,
    );
  });
});

describe("resolveFacilityWithPreference", () => {
  it("prefers an explicitly requested facility over any organization preference", () => {
    const availability = [slot(["有玉本社", "アクトミーティングルームC"])];
    assert.equal(
      resolveFacilityWithPreference("有玉", availability, "経営企画部", undefined, START, END),
      "有玉本社",
    );
  });

  it("resolves the first-choice preference for the requester's organization", () => {
    const availability = [slot(["有玉本社", "アクトミーティングルームC"])];
    assert.equal(
      resolveFacilityWithPreference(undefined, availability, "経営企画部", undefined, START, END),
      "アクトミーティングルームC",
    );
  });

  it("falls back to the next preference when the first choice has no availability", () => {
    const availability = [slot(["アクト第2会議室", "品川"])];
    assert.equal(
      resolveFacilityWithPreference(undefined, availability, "経営企画部", undefined, START, END),
      "アクト第2会議室",
    );
  });

  it("rejects a preference that partially matches more than one available facility", () => {
    const availability = [slot(["アクトミーティングルームC", "品川ミーティングルームC"])];
    assert.throws(
      () => resolveFacilityWithPreference(
        undefined,
        availability,
        "経営企画部",
        undefined,
        START,
        END,
        {},
        { "経営企画部": ["ミーティングルームC"] },
      ),
      /複数の設備に一致/,
    );
  });

  it("requires an explicit facility when the organization has no configured preference", () => {
    const availability = [slot(["有玉本社"])];
    assert.throws(
      () => resolveFacilityWithPreference(undefined, availability, "未知の部署", undefined, START, END),
      /会議室を指定してください/,
    );
    assert.throws(
      () => resolveFacilityWithPreference(undefined, availability, undefined, undefined, START, END),
      /会議室を指定してください/,
    );
  });

  it("requires an explicit facility when no preference is available for the selected slot", () => {
    const availability = [slot(["品川"])];
    assert.throws(
      () => resolveFacilityWithPreference(undefined, availability, "経営企画部", undefined, START, END),
      /優先する会議室/,
    );
  });

  it("prefers a per-user override over the organization's default, for someone whose real work location differs", () => {
    const availability = [slot(["有玉本社", "品川オフィス"])];
    // Two people can share an organization (both 営業統括部) but need different
    // default facilities because DeskNet's exposes no field more granular than
    // 代表組織. The override table exists exactly for this case.
    const userOverrides = { "テスト太郎": ["品川"] };
    const organizationPreferences = { "営業統括部": ["有玉"] };
    assert.equal(
      resolveFacilityWithPreference(
        undefined,
        availability,
        "営業統括部",
        "テスト太郎",
        START,
        END,
        userOverrides,
        organizationPreferences,
      ),
      "品川オフィス",
    );
    assert.equal(
      resolveFacilityWithPreference(
        undefined,
        availability,
        "営業統括部",
        "テスト花子",
        START,
        END,
        userOverrides,
        organizationPreferences,
      ),
      "有玉本社",
    );
  });

  it("infers a facility preference from the organization name when no table entry exists", () => {
    const availability = [slot(["名古屋オフィス応接室", "品川オフィス"])];
    assert.equal(
      resolveFacilityWithPreference(undefined, availability, "名古屋事務所", undefined, START, END, {}, {}),
      "名古屋オフィス応接室",
    );
  });

  it("does not guess when the inferred organization token matches more than one facility", () => {
    const availability = [slot(["名古屋オフィス応接室", "名古屋オフィス会議室"])];
    assert.throws(
      () => resolveFacilityWithPreference(undefined, availability, "名古屋事務所", undefined, START, END, {}, {}),
      /複数の設備に一致/,
    );
  });

  it("does not infer anything from an organization name with no recognizable suffix", () => {
    const availability = [slot(["名古屋オフィス応接室"])];
    assert.throws(
      () => resolveFacilityWithPreference(undefined, availability, "名古屋", undefined, START, END, {}, {}),
      /会議室を指定してください/,
    );
  });
});

describe("parseFacilityPreferenceTable", () => {
  const fallback = { "経営企画部": ["アクト"] };

  it("falls back to the default table when the environment variable is unset or blank", () => {
    assert.deepEqual(parseFacilityPreferenceTable("X", undefined, fallback), fallback);
    assert.deepEqual(parseFacilityPreferenceTable("X", "  ", fallback), fallback);
  });

  it("parses a valid JSON override, replacing the default table entirely", () => {
    const raw = JSON.stringify({ "営業統括部": ["有玉"], "経理部": ["品川", "アクト"] });
    assert.deepEqual(parseFacilityPreferenceTable("X", raw, fallback), {
      "営業統括部": ["有玉"],
      "経理部": ["品川", "アクト"],
    });
  });

  it("rejects invalid JSON", () => {
    assert.throws(() => parseFacilityPreferenceTable("X", "{not json", fallback), /valid JSON/);
  });

  it("rejects a JSON value that isn't an object", () => {
    assert.throws(() => parseFacilityPreferenceTable("X", "[1,2,3]", fallback), /JSON object/);
    assert.throws(() => parseFacilityPreferenceTable("X", '"アクト"', fallback), /JSON object/);
  });

  it("rejects an entry whose value isn't a non-empty array of non-empty strings", () => {
    assert.throws(
      () => parseFacilityPreferenceTable("X", JSON.stringify({ "経営企画部": "アクト" }), fallback),
      /non-empty array/,
    );
    assert.throws(
      () => parseFacilityPreferenceTable("X", JSON.stringify({ "経営企画部": [] }), fallback),
      /non-empty array/,
    );
    assert.throws(
      () => parseFacilityPreferenceTable("X", JSON.stringify({ "経営企画部": [""] }), fallback),
      /non-empty array/,
    );
  });
});

describe("formatFacilityChoiceMessage", () => {
  it("asks which room, listing each distinct available facility once", () => {
    const message = formatFacilityChoiceMessage(["アクト", "有玉本社", "アクト"]);
    assert.match(message, /会議室の場所はどこにしますか？/);
    assert.match(message, /・アクト/);
    assert.match(message, /・有玉本社/);
    assert.equal(message.match(/アクト/g)?.length, 1);
  });
});

describe("unavailable facility follow-up", () => {
  it("states clearly that the requested room is occupied", () => {
    assert.match(
      formatUnavailableFacilityChoiceMessage(
        "アクト応接室",
        ["アクトミーティングルームC"],
      ),
      /指定した会議室「アクト応接室」は、指定した日時には埋まっています/,
    );
  });

  it("inherits the site from the unavailable full room name", () => {
    assert.equal(inferFacilityScope("アクト応接室"), "アクト");
    assert.equal(cleanFacilityChoiceReply("では、ミーティングルームCで"), "ミーティングルームC");
  });
});

describe("isShowCandidatesRequest", () => {
  it("recognizes a request to go back to the previous candidates", () => {
    assert.equal(isShowCandidatesRequest("候補に戻して"), true);
    assert.equal(isShowCandidatesRequest("やっぱりやめて、候補に戻して"), true);
  });

  it("does not mistake a bare facility name for a show-candidates request", () => {
    assert.equal(isShowCandidatesRequest("有玉"), false);
    assert.equal(isShowCandidatesRequest("アクト"), false);
    assert.equal(isShowCandidatesRequest("品川オフィス"), false);
  });
});

describe("matchOfferedOrganizations", () => {
  it("matches an exact organization name", () => {
    assert.deepEqual(
      matchOfferedOrganizations("経営企画部", ["経営企画部", "三晃"]),
      ["経営企画部"],
    );
  });

  it("matches an informal reply missing the trailing suffix", () => {
    assert.deepEqual(
      matchOfferedOrganizations("経営企画", ["経営企画部", "三晃"]),
      ["経営企画部"],
    );
  });

  it("matches regardless of which organization is listed first", () => {
    assert.deepEqual(matchOfferedOrganizations("三晃", ["経営企画部", "三晃"]), ["三晃"]);
  });

  it("returns no matches for a reply that matches none of the offered organizations", () => {
    assert.deepEqual(matchOfferedOrganizations("有玉", ["経営企画部", "三晃"]), []);
    assert.deepEqual(matchOfferedOrganizations("", ["経営企画部", "三晃"]), []);
  });

  it("prefers an exact match over a reply that substring-matches multiple organizations", () => {
    // "経営企画部ではなく三晃です" substring-matches both organizations; naively
    // taking the first would silently resolve to the one the user just ruled out.
    assert.deepEqual(
      matchOfferedOrganizations("経営企画部ではなく三晃です", ["経営企画部", "三晃"]),
      ["経営企画部", "三晃"],
    );
  });

  it("does not offer an empty organization as a matchable candidate", () => {
    // A row DeskNet's exposed no department for ends up as "" — without
    // filtering it out, reply.includes("") is always true and would corrupt
    // matching for any reply at all.
    assert.deepEqual(matchOfferedOrganizations("三晃", ["三晃", ""]), ["三晃"]);
    assert.deepEqual(matchOfferedOrganizations("有玉", ["三晃", ""]), []);
  });
});

describe("participant-choice escape routing", () => {
  it("recognizes a complete new availability request as replacing the pending choice", () => {
    assert.equal(
      isFreshAvailabilityRequest("髙田さんだけで明日の空き時間を調べて"),
      true,
    );
    assert.equal(
      isFreshAvailabilityRequest("やっぱり経営企画部の佐藤さんだけで明日の空き時間を調べて"),
      true,
    );
  });

  it("does not mistake a short organization answer for a new availability request", () => {
    assert.equal(isFreshAvailabilityRequest("経営企画部"), false);
    assert.equal(isFreshAvailabilityRequest("経営企画部の山本さんです"), false);
  });

  it("recognizes explicit cancellation without swallowing unrelated text", () => {
    for (const prompt of ["キャンセル", "キャンセルしてください", "この選択を中止します", "やめて"]) {
      assert.equal(isParticipantChoiceCancellationRequest(prompt), true, prompt);
    }
    assert.equal(isParticipantChoiceCancellationRequest("山本さんを候補から外して"), false);
    assert.equal(isParticipantChoiceCancellationRequest("髙田さんだけで明日の空き時間を調べて"), false);
  });
});

describe("buildShowCandidatesResponse", () => {
  it("re-displays the facility-narrowed candidate list when one is present", () => {
    const conversation: PendingBookingConversation = {
      context: {
        date: "2026-08-24",
        endDate: "2026-08-24",
        durationMinutes: 30,
        participantIds: ["u1"],
        availability: [slot(["有玉本社"])],
      },
      facilityId: "有玉本社",
      candidates: [slot(["有玉本社"])],
    };
    const redisplay = buildShowCandidatesResponse(conversation);
    assert.deepEqual(redisplay.task, {
      type: "find_facility_availability",
      facilityQuery: "有玉本社",
    });
    assert.match(redisplay.result.assistantMessage ?? "", /予約をキャンセルしました/);
    assert.deepEqual(redisplay.result.availability, [slot(["有玉本社"])]);
  });

  it("falls back to the general availability grid when no facility-narrowed list exists", () => {
    const conversation: PendingBookingConversation = {
      context: {
        date: "2026-08-24",
        endDate: "2026-08-25",
        durationMinutes: 30,
        participants: [{ name: "髙田" }],
        participantIds: ["u1", "u2"],
        availability: [slot(["有玉本社", "アクト"])],
      },
    };
    const redisplay = buildShowCandidatesResponse(conversation);
    assert.deepEqual(redisplay.task, {
      type: "find_availability",
      participants: [{ name: "髙田" }],
      date: "2026-08-24",
      endDate: "2026-08-25",
      durationMinutes: 30,
    });
    assert.match(redisplay.result.assistantMessage ?? "", /予約をキャンセルしました/);
    assert.deepEqual(redisplay.result.availability, [slot(["有玉本社", "アクト"])]);
  });
});
