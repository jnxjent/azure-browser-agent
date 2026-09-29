import assert from "node:assert/strict";
import test from "node:test";
import { parseFacilityOnlyAvailability } from "./facility-only-availability.js";

const now = new Date("2026-09-29T09:00:00+09:00");

test("turns the reported room question into a bounded read-only facility search", () => {
  assert.deepEqual(parseFacilityOnlyAvailability(
    "10月５日以降、午後でアクト中会議室を２時間確保できる日程を教えてください",
    "別の会議室", now,
  ), {
    type: "find_room_availability",
    facilityQuery: "アクト中会議室",
    date: "2026-10-05",
    endDate: "2026-10-11",
    durationMinutes: 120,
    windowStart: "12:00",
    windowEnd: "17:00",
  });
});

test("does not replace a people-and-room availability search", () => {
  assert.equal(parseFacilityOnlyAvailability(
    "10月5日以降、髙田部長とアクト中会議室で空いている日程を教えて",
    "アクト中会議室", now,
  ), undefined);
});

test("rolls an omitted year forward and rejects impossible dates", () => {
  const december = new Date("2026-12-20T09:00:00+09:00");
  assert.equal(parseFacilityOnlyAvailability(
    "1月5日以降、アクト中会議室を2時間確保できる日は？", null, december,
  )?.date, "2027-01-05");
  assert.throws(() => parseFacilityOnlyAvailability(
    "2月30日以降、アクト中会議室を2時間確保できる日は？", null, now,
  ), /有効な検索開始日/);
});
