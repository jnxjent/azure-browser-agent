import assert from "node:assert/strict";
import { it } from "node:test";
import { findCommonAvailability } from "@azure-browser-agent/agent-core";
import { readMeetingHours } from "./meeting-hours.js";

it("defaults to 09:00–17:00 and keeps the whole meeting inside the window", () => {
  const hours = readMeetingHours({});
  assert.deepEqual(hours, {start: "09:00", end: "17:00"});
  for (const durationMinutes of [30, 60]) {
    const slots = findCommonAvailability({window: {start:`2099-01-05T${hours.start}:00+09:00`,end:`2099-01-05T${hours.end}:00+09:00`},durationMinutes,incrementMinutes:30,schedules:[{participantId:"test",busy:[]}]});
    assert.equal(slots[0]?.start, "2099-01-05T00:00:00.000Z");
    assert.equal(slots.at(-1)?.end, "2099-01-05T08:00:00.000Z");
    assert.equal(slots.length, durationMinutes === 30 ? 16 : 15);
  }
});

it("supports configurable hours including minutes and rejects invalid/reversed windows", () => {
  const hours = readMeetingHours({DESKNETS_MEETING_START_TIME:"10:15",DESKNETS_MEETING_END_TIME:"16:45"});
  assert.deepEqual(hours, {start:"10:15",end:"16:45"});
  const slots = findCommonAvailability({window:{start:`2099-01-05T${hours.start}:00+09:00`,end:`2099-01-05T${hours.end}:00+09:00`},durationMinutes:30,incrementMinutes:30,schedules:[{participantId:"test",busy:[]}]});
  assert.equal(slots[0]?.start,"2099-01-05T01:15:00.000Z");
  assert.equal(slots.at(-1)?.end,"2099-01-05T07:45:00.000Z");
  for (const value of ["9:00", "24:00", "09:60", "invalid"]) {
    assert.throws(() => readMeetingHours({DESKNETS_MEETING_START_TIME:value}), /HH:mm/);
  }
  for (const value of ["09:00", "08:00"]) {
    assert.throws(() => readMeetingHours({DESKNETS_MEETING_END_TIME:value}), /開始は終了より前/);
  }
});
