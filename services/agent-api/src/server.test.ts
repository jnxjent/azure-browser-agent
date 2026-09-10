import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BookableAvailabilitySlot } from "@azure-browser-agent/agent-core";
import {
  buildShowCandidatesResponse,
  formatFacilityChoiceMessage,
  formatUnavailableFacilityChoiceMessage,
  getCompanyWideAvailability,
  inferFacilityScope,
  cleanFacilityChoiceReply,
  isFreshAvailabilityRequest,
  isAuthorizedRequest,
  isRunOwnerRequest,
  isParticipantChoiceCancellationRequest,
  isShowCandidatesRequest,
  matchOfferedOrganizations,
  parseFacilityPreferenceTable,
  resolveFacilityWithPreference,
  resolveAutomaticFacilityForSlot,
  resizeBookableAvailability,
  restrictSlotToFacilityType,
  resolveTimeOnlySelection,
  type PendingBookingConversation,
} from "./server.js";

const START = "2026-08-24T00:30:00.000Z";
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
      () => resolveFacilityWithPreference(undefined, availability, "経営企画部", undefined, START, END),
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
