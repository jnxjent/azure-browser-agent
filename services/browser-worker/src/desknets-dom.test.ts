import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeParticipantScheduleObservations } from "./desknets-dom.js";

describe("mergeParticipantScheduleObservations", () => {
  it("does not erase an earlier participant's busy blocks when DeskNet's later paints an empty row", () => {
    const busy = [{
      start: "2026-09-14T02:00:00.000Z",
      end: "2026-09-14T03:00:00.000Z",
    }];
    const first = mergeParticipantScheduleObservations([], [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy },
    ]);
    const second = mergeParticipantScheduleObservations(first, [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy: [] },
      { participantId: "田倉祐亮", busy },
    ]);
    const final = mergeParticipantScheduleObservations(second, [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy: [] },
      { participantId: "田倉祐亮", busy: [] },
      { participantId: "津藤俊介", busy },
    ]);

    assert.deepEqual(final, [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy },
      { participantId: "田倉祐亮", busy },
      { participantId: "津藤俊介", busy },
    ]);
  });
});
