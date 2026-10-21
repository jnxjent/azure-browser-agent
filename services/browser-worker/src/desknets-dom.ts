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
  appointmentLabels: string[];
}

/** Half-day leave uses fixed JST hours; unqualified leave excludes the date. */
export function participantBusyIntervals(row: Pick<ExtractedTimelineRow, "timelineWidthPx" | "blocks" | "appointmentLabels">, dayStart: string) {
  const start = Date.parse(dayStart);
  if (!Number.isFinite(start)) throw new TypeError("dayStart must be a valid date-time.");
  const labels = row.appointmentLabels.map(label => label.normalize("NFKC").replace(/\s+/g, ""));
  const halfDay = labels.map(label => ({morning:label.includes("午前半休"),afternoon:label.includes("午後半休")}));
  // Qualifiers belong to one appointment: another full-day leave still wins.
  if (labels.some((label,index) => !halfDay[index]!.morning && !halfDay[index]!.afternoon && /有休|有給休暇|休み/.test(label))) {
    return [{ start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() }];
  }
  const interval = (from:number,to:number) => ({start:new Date(start+from*3_600_000).toISOString(),end:new Date(start+to*3_600_000).toISOString()});
  const leave = halfDay.flatMap(half => [...(half.morning?[interval(9,13)]:[]),...(half.afternoon?[interval(14,18)]:[])]);
  // A half-day entry can be drawn across the whole timeline. Replace only that
  // entry's geometry, retaining every other appointment's actual busy hours.
  const blocks = row.blocks.filter((_,index) => !halfDay[index]?.morning && !halfDay[index]?.afternoon);
  return [...convertTimelineBlocksToIntervals({dayStart,timelineWidthPx:row.timelineWidthPx,blocks}),...leave];
}

export function mergeParticipantScheduleObservations(
  previous: ParticipantSchedule[],
  current: ParticipantSchedule[],
): ParticipantSchedule[] {
  const schedules = new Map(
    previous.map((schedule) => [schedule.participantId, schedule]),
  );
  for (const schedule of current) {
    const remembered = schedules.get(schedule.participantId);
    const busy = [...(remembered?.busy ?? []), ...schedule.busy];
    schedules.set(schedule.participantId, {...schedule, busy:Array.from(new Map(busy.map(interval=>[`${interval.start}/${interval.end}`,interval])).values())});
  }
  return Array.from(schedules.values());
}

export async function extractParticipantSchedules(
  pageRoot: Locator,
  dayStart: string,
): Promise<ParticipantSchedule[]> {
  const table = pageRoot.locator(".co-sel-dialog:visible .co-sel-bottom table");
  const rows = await extractRows(table, ".name-text");
  return rows.map((row) => ({
    participantId: row.label,
    busy: participantBusyIntervals(row, dayStart),
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
        const appointments = Array.from(row.querySelectorAll<HTMLElement>(".sch-item"));
        const appointmentLabels = appointments.map(item => [
          item.textContent ?? "", item.getAttribute("title") ?? "", item.getAttribute("aria-label") ?? "",
          ...Array.from(item.querySelectorAll("[title],[aria-label]")).flatMap(child => [child.getAttribute("title") ?? "",child.getAttribute("aria-label") ?? ""]),
        ].join(" "));
        const blocks = appointments.map(
          (item) => {
            const rect = item.getBoundingClientRect();
            return {
              leftPx: rect.left - firstRect.left,
              widthPx: rect.width,
            };
          },
        );

        return { label, timelineWidthPx, blocks, appointmentLabels };
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
