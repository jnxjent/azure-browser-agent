import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertTimelineBlocksToIntervals } from "./desknets-timeline.js";

describe("convertTimelineBlocksToIntervals", () => {
  it("converts full-hour blocks from the DeskNet's 24-hour grid", () => {
    const intervals = convertTimelineBlocksToIntervals({
      dayStart: "2026-08-06T00:00:00+09:00",
      timelineWidthPx: 480,
      blocks: [
        { leftPx: 200, widthPx: 60 },
        { leftPx: 300, widthPx: 20 },
      ],
    });

    assert.deepEqual(intervals, [
      {
        start: "2026-08-06T01:00:00.000Z",
        end: "2026-08-06T04:00:00.000Z",
      },
      {
        start: "2026-08-06T06:00:00.000Z",
        end: "2026-08-06T07:00:00.000Z",
      },
    ]);
  });

  it("preserves half-hour positions and widths", () => {
    const [interval] = convertTimelineBlocksToIntervals({
      dayStart: "2026-08-06T00:00:00+09:00",
      timelineWidthPx: 480,
      blocks: [{ leftPx: 230, widthPx: 10 }],
    });

    assert.deepEqual(interval, {
      start: "2026-08-06T02:30:00.000Z",
      end: "2026-08-06T03:00:00.000Z",
    });
  });

  it("rejects invalid and out-of-range blocks", () => {
    assert.throws(
      () =>
        convertTimelineBlocksToIntervals({
          dayStart: "2026-08-06T00:00:00+09:00",
          timelineWidthPx: 480,
          blocks: [{ leftPx: 470, widthPx: 20 }],
        }),
      /outside the timeline/,
    );
  });
});
