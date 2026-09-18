import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFacilityAvailable } from "./desknets-facility-conflicts.js";
import { resolveLiveRoomChange } from "./room-change.js";

const slot = { start: "2026-09-17T01:00:00Z", end: "2026-09-17T02:00:00Z" };
test("room-only changes check live occupancy and offer alternatives only in the same location", () => {
  const rooms = [{facilityId:"有玉大会議室",busy:[slot]}, {facilityId:"有玉小会議室",busy:[]}, {facilityId:"アクト大会議室",busy:[]}];
  const blocked = resolveLiveRoomChange(rooms,slot,"有玉大会議室","有玉");
  assert.equal(blocked.facilityId,undefined);
  assert.deepEqual(blocked.alternatives,["有玉小会議室"]);
  assert.match(blocked.message,/埋まっています/);
  assert.doesNotMatch(blocked.message,/アクト/);
  assert.equal(resolveLiveRoomChange(rooms,slot,"有玉小会議室","有玉").facilityId,"有玉小会議室");
  assert.equal(resolveLiveRoomChange(rooms,slot,"有玉","有玉","有玉小会議室").facilityId,undefined);
});
test("rejects newly occupied rooms including partial overlaps and duplicate rows", () => {
  for (const busy of [
    slot,
    { start: "2026-09-17T00:30:00Z", end: "2026-09-17T01:30:00Z" },
    { start: "2026-09-17T01:30:00Z", end: "2026-09-17T02:30:00Z" },
  ]) {
    assert.throws(() => assertFacilityAvailable([
      { facilityId: "room", busy: [] }, { facilityId: "room", busy: [busy] },
    ], "room", slot), /埋まっています/);
  }
});
test("accepts adjacent bookings and an empty room", () => {
  assertFacilityAvailable([{ facilityId: "room", busy: [] }], "room", slot);
  assertFacilityAvailable([{ facilityId: "room", busy: [
    { start: "2026-09-17T00:00:00Z", end: slot.start },
    { start: slot.end, end: "2026-09-17T03:00:00Z" },
  ] }], "room", slot);
});
test("fails closed when the room or its reservation data cannot be verified", () => {
  assert.throws(() => assertFacilityAvailable([], "room", slot), /確認できません/);
  assert.throws(() => assertFacilityAvailable([
    { facilityId: "room", busy: [{ start: "invalid", end: slot.end }] },
  ], "room", slot), /読み取れません/);
});
