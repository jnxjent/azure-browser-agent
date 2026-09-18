import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  facilityChangeFromStructuredCommand,
  mergeFacilityChangeRequests,
  parseExplicitFacilityQuery,
  parseFlexibleFacilityQuery,
  parseFacilityChangeRequest,
  parseAlternativeFacilityRequest,
} from "./facility-change.js";

describe("alternative room replies", () => {
  it("treats a location's meeting rooms as any room there, not a literal room name", () => {
    assert.deepEqual(parseFlexibleFacilityQuery("有玉の会議室"), {query:"有玉",facilityType:"meeting_room"});
    assert.deepEqual(parseFlexibleFacilityQuery("アクトの会議室"), {query:"アクト",facilityType:"meeting_room"});
    assert.equal(parseFlexibleFacilityQuery("有玉大会議室")?.query,"有玉大会議室");
  });
  it("interprets another room as a location scope plus an exclusion", () => {
    for (const prompt of ["では、アクトの別会議室で  ", "アクトの別の会議室にして", "アクトの他の会議室で"]) {
      assert.deepEqual(parseAlternativeFacilityRequest(prompt), {
        preferredQuery: "アクト", preferredType: "meeting_room", excludePrevious: true,
      });
    }
    assert.equal(parseAlternativeFacilityRequest("別の会議室で", "アクト")?.preferredQuery, "アクト");
    assert.equal(parseAlternativeFacilityRequest("別の会議室で"), undefined);
  });
});

describe("parseFacilityChangeRequest", () => {
  it("parses a preferred room and a location fallback across lines", () => {
    assert.deepEqual(
      parseFacilityChangeRequest(
        "会議室を以下に変更して。\nアクト応接室\n空いてなければ、アクトのどの会議室でもいい",
      ),
      {
        preferredQuery: "アクト応接室",
        fallbackQuery: "アクト",
        fallbackType: "meeting_room",
      },
    );
  });

  it("parses punctuation, hiragana and a natural fallback", () => {
    assert.deepEqual(
      parseFacilityChangeRequest(
        "会議室を、アクト応接室に変えて。あいてなければ、アクトの会議室ならどこでもいい。",
      ),
      {
        preferredQuery: "アクト応接室",
        fallbackQuery: "アクト",
        fallbackType: "meeting_room",
      },
    );
    assert.deepEqual(
      parseFacilityChangeRequest(
        "アクト応接室にかえて、空いていなかったらアクトの会議室どこでもいい",
      ),
      {
        preferredQuery: "アクト応接室",
        fallbackQuery: "アクト",
        fallbackType: "meeting_room",
      },
    );
  });

  it("recognizes an occupied-room fallback", () => {
    assert.deepEqual(
      parseFacilityChangeRequest(
        "会議室を、アクト応接室に変えて。埋まっていれば、アクトの会議室のどこでもいい",
      ),
      {
        preferredQuery: "アクト応接室",
        fallbackQuery: "アクト",
        fallbackType: "meeting_room",
      },
    );
  });

  it("supplements incomplete model output from the original wording", () => {
    assert.deepEqual(
      mergeFacilityChangeRequests(
        { preferredQuery: "アクト応接室" },
        {
          preferredQuery: "アクト応接室",
          fallbackQuery: "アクト",
          fallbackType: "meeting_room",
        },
      ),
      {
        preferredQuery: "アクト応接室",
        fallbackQuery: "アクト",
        fallbackType: "meeting_room",
      },
    );
  });

  it("extracts a room location combined with a time change", () => {
    assert.equal(
      parseExplicitFacilityQuery(
        "打ち合わせの日程を変えたい。9/14の12時開始に変えて　会議室は有玉で",
      ),
      "有玉",
    );
  });

  it("parses an inline room change", () => {
    assert.deepEqual(
      parseFacilityChangeRequest("会議室をアクト応接室に変更して"),
      { preferredQuery: "アクト応接室" },
    );
  });

  it("understands any available meeting room within a named location", () => {
    assert.deepEqual(
      parseFacilityChangeRequest("会議室は、有玉のどこかの会議室に変更して"),
      {
        preferredQuery: "有玉",
        preferredType: "meeting_room",
      },
    );
    assert.deepEqual(
      parseFlexibleFacilityQuery("有玉で空いている会議室"),
      {
        query: "有玉",
        facilityType: "meeting_room",
      },
    );
    assert.deepEqual(
      parseFlexibleFacilityQuery("有玉の会議室ならどこでもいい"),
      {
        query: "有玉",
        facilityType: "meeting_room",
      },
    );
  });

  it("normalizes a model-produced natural facility phrase", () => {
    assert.deepEqual(
      facilityChangeFromStructuredCommand({
        action: "change_facility",
        participants: [],
        dateStart: null,
        dateEnd: null,
        startTime: null,
        endTime: null,
        durationMinutes: null,
        candidateNumber: null,
        facility: {
          preferred: "有玉のどこかの会議室",
          fallbackLocation: null,
          fallbackType: "meeting_room",
          anyAvailable: true,
        },
        title: null,
        sendEmail: null,
      }),
      {
        preferredQuery: "有玉",
        preferredType: "meeting_room",
      },
    );
  });

  it("accepts a location-only any-room structured command", () => {
    assert.deepEqual(
      facilityChangeFromStructuredCommand({
        action: "change_facility",
        participants: [],
        dateStart: null,
        dateEnd: null,
        startTime: null,
        endTime: null,
        durationMinutes: null,
        candidateNumber: null,
        facility: {
          preferred: "有玉",
          fallbackLocation: null,
          fallbackType: "meeting_room",
          anyAvailable: true,
        },
        title: null,
        sendEmail: null,
      }),
      {
        preferredQuery: "有玉",
        preferredType: "meeting_room",
      },
    );
  });

  it("ignores messages that are not facility changes", () => {
    assert.equal(parseFacilityChangeRequest("アクトの空き時間を教えて"), undefined);
  });

  it("prefers a validated structured command over wording", () => {
    assert.deepEqual(
      facilityChangeFromStructuredCommand({
        action: "change_facility",
        participants: [],
        dateStart: null,
        dateEnd: null,
        startTime: null,
        endTime: null,
        durationMinutes: null,
        candidateNumber: null,
        facility: {
          preferred: "アクト応接室",
          fallbackLocation: "アクト",
          fallbackType: "meeting_room",
          anyAvailable: true,
        },
        title: null,
        sendEmail: null,
      }),
      {
        preferredQuery: "アクト応接室",
        fallbackQuery: "アクト",
        fallbackType: "meeting_room",
      },
    );
  });
});
