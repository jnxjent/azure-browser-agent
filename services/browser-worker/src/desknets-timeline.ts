import type { TimeInterval } from "@azure-browser-agent/agent-core";

export interface TimelineBlock {
  leftPx: number;
  widthPx: number;
}

export interface TimelineConversionRequest {
  dayStart: string;
  timelineWidthPx: number;
  blocks: TimelineBlock[];
  timelineMinutes?: number;
}

const DEFAULT_TIMELINE_MINUTES = 24 * 60;

export function convertTimelineBlocksToIntervals(
  request: TimelineConversionRequest,
): TimeInterval[] {
  const dayStart = Date.parse(request.dayStart);
  if (!Number.isFinite(dayStart)) {
    throw new TypeError("dayStart must be a valid ISO date-time value.");
  }
  if (!Number.isFinite(request.timelineWidthPx) || request.timelineWidthPx <= 0) {
    throw new TypeError("timelineWidthPx must be a positive number.");
  }

  const timelineMinutes = request.timelineMinutes ?? DEFAULT_TIMELINE_MINUTES;
  if (!Number.isSafeInteger(timelineMinutes) || timelineMinutes <= 0) {
    throw new TypeError("timelineMinutes must be a positive integer.");
  }

  return request.blocks.map((block, index) => {
    assertBlock(block, index, request.timelineWidthPx);
    const startMinutes = Math.round(
      (block.leftPx / request.timelineWidthPx) * timelineMinutes,
    );
    const durationMinutes = Math.round(
      (block.widthPx / request.timelineWidthPx) * timelineMinutes,
    );
    const endMinutes = startMinutes + durationMinutes;
    if (durationMinutes <= 0 || endMinutes > timelineMinutes) {
      throw new TypeError(`blocks[${index}] falls outside the timeline.`);
    }

    return {
      start: new Date(dayStart + startMinutes * 60_000).toISOString(),
      end: new Date(dayStart + endMinutes * 60_000).toISOString(),
    };
  });
}

function assertBlock(
  block: TimelineBlock,
  index: number,
  timelineWidthPx: number,
): void {
  if (!Number.isFinite(block.leftPx) || block.leftPx < 0) {
    throw new TypeError(`blocks[${index}].leftPx must be a non-negative number.`);
  }
  if (!Number.isFinite(block.widthPx) || block.widthPx <= 0) {
    throw new TypeError(`blocks[${index}].widthPx must be a positive number.`);
  }
  if (block.leftPx + block.widthPx > timelineWidthPx) {
    throw new TypeError(`blocks[${index}] falls outside the timeline.`);
  }
}
