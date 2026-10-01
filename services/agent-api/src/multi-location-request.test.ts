import assert from "node:assert/strict";
import test from "node:test";
import { parseMultiRoomAvailability, readRequiredFacilityLocations, readRequiredFacilityRequest } from "./multi-location-request.js";

test("recognizes two rooms required at the same time in separate locations", () => {
  assert.deepEqual(readRequiredFacilityLocations(
    "10月5日以降に事業部鈴木清彦部長、私でWEBミーティングを開催したいです。時間は1時間。鈴木部長は有玉本社、私はアクト事務所で参加しますのでそれぞれ1か所の会議室を確保できる候補日を教えてください。",
  ), ["アクト", "有玉"]);
});

test("does not turn an alternate location into a simultaneous requirement", () => {
  assert.equal(readRequiredFacilityLocations("アクトか有玉の会議室が空いている日を教えて"), undefined);
});

test("recognizes two explicitly named rooms without requiring the word 両方", () => {
  assert.deepEqual(
    readRequiredFacilityRequest("10月5日以降、午後でアクト中会議室と有玉大会議室を2時間確保できる日程を教えてください"),
    {
      locations: ["アクト", "有玉"],
      queries: ["アクト中会議室", "有玉大会議室"],
    },
  );
});

test("builds the reported self-and-two-rooms afternoon search deterministically", () => {
  assert.deepEqual(
    parseMultiRoomAvailability(
      "10月5日以降、午後でアクト中会議室と有玉大会議室を2時間確保できる日程を教えてください",
      new Date("2026-10-01T00:00:00+09:00"),
    ),
    {
      type: "find_availability",
      participants: [],
      date: "2026-10-05",
      endDate: "2026-10-11",
      durationMinutes: 120,
      requiredFacilityLocations: ["アクト", "有玉"],
      requiredFacilityQueries: ["アクト中会議室", "有玉大会議室"],
      windowStart: "13:00",
      windowEnd: "18:00",
      autoExtendSearch: true,
    },
  );
});

test("recognizes three explicitly named rooms and keeps every room in the intersection", () => {
  assert.deepEqual(
    readRequiredFacilityRequest(
      "10月5日以降、アクト中会議室と有玉大会議室と品川大会議室が同時に2時間空いている候補を教えてください",
    ),
    {
      locations: ["アクト", "有玉", "品川"],
      queries: ["アクト中会議室", "有玉大会議室", "品川大会議室"],
    },
  );
});

test("keeps a generic location room request for worker-side any-room matching", () => {
  assert.deepEqual(
    readRequiredFacilityRequest(
      "10月5日以降、アクト中会議室、有玉大会議室、品川の会議室が同時に2時間空いている候補を教えてください",
    ),
    {
      locations: ["アクト", "有玉", "品川"],
      queries: ["アクト中会議室", "有玉大会議室", "品川の会議室"],
    },
  );
});
