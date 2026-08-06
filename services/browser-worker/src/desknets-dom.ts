import {
  type FacilitySchedule,
  type ParticipantSchedule,
} from "@azure-browser-agent/agent-core";
import type { Locator } from "playwright";
import {
  convertTimelineBlocksToIntervals,
  type TimelineBlock,
} from "./desknets-timeline.js";

interface ExtractedTimelineRow {
  label: string;
  timelineWidthPx: number;
  blocks: TimelineBlock[];
}

export async function extractParticipantSchedules(
  pageRoot: Locator,
  dayStart: string,
): Promise<ParticipantSchedule[]> {
  const table = pageRoot.locator(".co-sel-dialog:visible .co-sel-bottom table");
  const rows = await extractRows(table, ".name-text");
  return rows.map((row) => ({
    participantId: row.label,
    busy: convertTimelineBlocksToIntervals({
      dayStart,
      timelineWidthPx: row.timelineWidthPx,
      blocks: row.blocks,
    }),
  }));
}

export async function extractFacilitySchedules(
  pageRoot: Locator,
  dayStart: string,
): Promise<FacilitySchedule[]> {
  const table = pageRoot.locator(
    ".ui-dialog:visible .sch-entry-plant-reserve-list table",
  );
  const rows = await extractRows(table, ".sch-entry-plant-name");
  return rows.map((row) => ({
    facilityId: row.label,
    busy: convertTimelineBlocksToIntervals({
      dayStart,
      timelineWidthPx: row.timelineWidthPx,
      blocks: row.blocks,
    }),
  }));
}

async function extractRows(
  table: Locator,
  labelSelector: string,
): Promise<ExtractedTimelineRow[]> {
  if ((await table.count()) !== 1) {
    throw new Error(`Expected one DeskNet's timeline table for ${labelSelector}.`);
  }
  await table.locator("tbody tr").first().waitFor({
    state: "attached",
    timeout: 10_000,
  });

  const rows = await table.locator("tbody tr").evaluateAll(
    (rowElements, selector) =>
      rowElements.map((rowElement) => {
        const row = rowElement as HTMLTableRowElement;
        const timelineCells = Array.from(row.cells).slice(1);
        const firstCell = timelineCells[0];
        const lastCell = timelineCells.at(-1);
        if (firstCell === undefined || lastCell === undefined) {
          throw new Error("DeskNet's timeline row does not contain time cells.");
        }

        const firstRect = firstCell.getBoundingClientRect();
        const lastRect = lastCell.getBoundingClientRect();
        const label = row.querySelector(selector)?.textContent?.trim() ?? "";
        const timelineWidthPx = lastRect.right - firstRect.left;
        const blocks = Array.from(row.querySelectorAll<HTMLElement>(".sch-item")).map(
          (item) => {
            const rect = item.getBoundingClientRect();
            return {
              leftPx: rect.left - firstRect.left,
              widthPx: rect.width,
            };
          },
        );

        return { label, timelineWidthPx, blocks };
      }),
    labelSelector,
  );

  if (rows.length === 0) {
    throw new Error("DeskNet's timeline table contains no rows.");
  }
  for (const [index, row] of rows.entries()) {
    if (row.label === "") {
      throw new Error(`DeskNet's timeline row ${index} has no label.`);
    }
    if (!Number.isFinite(row.timelineWidthPx) || row.timelineWidthPx <= 0) {
      throw new Error(`DeskNet's timeline row ${index} has no measurable width.`);
    }
  }
  return rows;
}
