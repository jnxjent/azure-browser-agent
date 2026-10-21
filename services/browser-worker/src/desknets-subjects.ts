import type { ParticipantSchedule } from "@azure-browser-agent/agent-core";
import type { Page } from "playwright";
import { participantBusyIntervals } from "./desknets-dom.js";

export interface SubjectAppointment {
  startdate: string;
  enddate: string;
  starttime: string;
  endtime: string;
  detail: string;
}

/** schprivate includes untimed subjects which the free-time bars omit. */
export function subjectBusyIntervals(events: SubjectAppointment[], dayStart: string) {
  const date = dayStart.slice(0, 10).replaceAll("-", "");
  const midnight = Date.parse(dayStart);
  if (!/^\d{8}$/.test(date) || !Number.isFinite(midnight)) throw Error("Invalid schedule date.");
  return events.flatMap(event => {
    if (!/^\d{8}$/.test(event.startdate) || !/^\d{8}$/.test(event.enddate) || event.enddate < event.startdate) throw Error("Invalid appointment dates.");
    if (event.startdate > date || event.enddate < date) return [];
    const leave = participantBusyIntervals({ timelineWidthPx: 1440, blocks: [], appointmentLabels: [event.detail] }, dayStart);
    if (leave.length) return leave;
    // Untimed ordinary notes have never blocked the free-time timeline.
    if (!event.starttime && !event.endtime) return [];
    const minutes = (time: string) => {
      if (!/^(?:[01]\d|2[0-3])[0-5]\d$|^2400$/.test(time)) throw Error("Invalid appointment time.");
      return Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
    };
    const from = event.startdate < date ? 0 : minutes(event.starttime || "0000");
    const to = event.enddate > date ? 1440 : minutes(event.endtime || "2400");
    if (to < from) throw Error("Invalid appointment range.");
    return to === from ? [] : [{ start: new Date(midnight + from * 60_000).toISOString(), end: new Date(midnight + to * 60_000).toISOString() }];
  });
}

/** Read-only native detail request, scoped to the selected native user IDs/date. */
export async function readParticipantSubjectSchedules(page: Page, dayStart: string): Promise<ParticipantSchedule[]> {
  const date = dayStart.slice(0, 10).replaceAll("-", "");
  const participants = await page.locator(".co-sel-dialog:visible .co-sel-bottom table tbody tr").evaluateAll(rows => rows.map(row => {
    const name = row.querySelector(".name-text");
    const item = (window as any).jQuery?.(row).data("item");
    const ref = item?.type === "user" && /^\d+$/.test(String(item.id)) ? `user${item.id}` : name?.getAttribute("data-refid") ?? "";
    return { label: name?.textContent?.trim() ?? "", ref };
  }));
  if (!participants.length || participants.some(p => !p.label || !/^user\d+$/.test(p.ref))) throw Error("Cannot identify selected schedule users.");
  const result: ParticipantSchedule[] = [];
  for (const participant of participants) {
    const events = await page.evaluate(({ id, date }) => new Promise<SubjectAppointment[]>((resolve, reject) => {
      // This is the same read-only endpoint used by the native free-time popup.
      const dn = (window as any).desknets;
      const timer = setTimeout(() => reject(Error("Schedule subject read timed out.")), 15000);
      try {
        dn.ajax.rest({ url: dn.getUrl(dn.MODULE_API_MAIN), data: { cmd: "schprivate", proc: "d", id, date },
          success(data: any) {
            clearTimeout(timer);
            try {
              if (!data || !Object.hasOwn(data, "slist")) throw Error("Missing schedule detail response.");
              const items = data.slist ? dn.ajax.getItems(data.slist.item) : [];
              if (!Array.isArray(items)) throw Error("Invalid schedule detail list.");
              resolve(items.map((event: any) => {
                if (typeof event.startdate !== "string" || typeof event.enddate !== "string") throw Error("Missing appointment dates.");
                return { startdate: event.startdate, enddate: event.enddate, starttime: event.starttime ?? "", endtime: event.endtime ?? "", detail: event.detail ?? "" };
              }));
            } catch (error) { reject(error); }
          },
          error() { clearTimeout(timer); reject(Error("Cannot read schedule subjects.")); },
        });
      } catch (error) { clearTimeout(timer); reject(error); }
    }), { id: participant.ref.slice(4), date });
    result.push({ participantId: participant.label, busy: subjectBusyIntervals(events, dayStart) });
  }
  return result;
}
