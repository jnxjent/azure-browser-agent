import assert from "node:assert/strict";
import { it } from "node:test";
import { schedulingIncrementMinutes, formatAvailabilityMessage } from "./desknets-worker.js";
import { findCommonAvailability } from "@azure-browser-agent/agent-core";

it("limits candidate increments while respecting the exact buffer", () => {
  for (const [buffer, expected] of [[0,30],[15,15],[20,10],[25,5],[7,5]]) {
    assert.equal(schedulingIncrementMinutes(buffer,0),expected);
    assert.equal(schedulingIncrementMinutes(0,buffer),expected);
  }
  const slots = findCommonAvailability({window:{start:"2099-01-05T09:00:00+09:00",end:"2099-01-05T12:00:00+09:00"},durationMinutes:60,incrementMinutes:schedulingIncrementMinutes(7),bufferBeforeMinutes:7,schedules:[{participantId:"test",busy:[{start:"2099-01-05T09:00:00+09:00",end:"2099-01-05T10:00:00+09:00"}]}]});
  assert.equal(slots[0]?.start,"2099-01-05T01:10:00.000Z");
});

it("describes applied buffers for candidates and empty results", () => {
  for (const slots of [[],[{start:"2099-01-05T01:00:00Z",end:"2099-01-05T02:00:00Z"}]]) {
    const message = formatAvailabilityMessage("2099-01-05","2099-01-05",60,slots,{bufferBeforeMinutes:30,bufferAfterMinutes:15});
    assert.match(message,/30/);
    assert.match(message,/15/);
    assert.ok(message.startsWith("\u524d\u306e\u4e88\u5b9a"));
  }
});
