import type { FindRoomAvailabilityTask } from "@azure-browser-agent/agent-core";

const DAY_MS = 86_400_000;

function japanDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A bounded read-only search for a named room, independent of people's calendars. */
export function parseFacilityOnlyAvailability(
  prompt: string,
  preferredFacility?: string | null,
  now: Date = new Date(),
): FindRoomAvailabilityTask | undefined {
  const text = prompt.normalize("NFKC");
  if (!/(?:会議室|応接室|ルーム)/.test(text) || !/(?:空き|空いて|使える|予約でき|確保でき|利用でき)/.test(text)) return undefined;
  // A named participant changes the meaning to a joint people-and-room search.
  if (/(?:さん|部長|次長|課長|参加者|出席者|私と|自分と)/.test(text)) return undefined;
  const preferred = preferredFacility?.normalize("NFKC").trim();
  const rawFacility = text.match(/(?:^|[、。\sで])([^\s、。で]{2,24}?(?:会議室|応接室|ルーム[A-Z]?))(?=を|が|で|に|の|$)/)?.[1]
    ?? (preferred && /(?:会議室|応接室|ルーム)/.test(preferred) ? preferred : undefined);
  if (!rawFacility || !/(?:会議室|応接室|ルーム)/.test(rawFacility)) return undefined;

  const today = japanDate(now);
  const dateMatch = text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/);
  let date = today;
  if (dateMatch) {
    let year = dateMatch[1] ? Number(dateMatch[1]) : Number(today.slice(0, 4));
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    let parsed = new Date(Date.UTC(year, month - 1, day));
    if (!dateMatch[1] && parsed.toISOString().slice(0, 10) < today) {
      year += 1;
      parsed = new Date(Date.UTC(year, month - 1, day));
    }
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      throw new TypeError("有効な検索開始日を指定してください。");
    }
    date = parsed.toISOString().slice(0, 10);
  }
  const duration = text.match(/(\d+)\s*時間(?:\s*(\d+)\s*分)?/);
  const minutes = text.match(/(\d+)\s*分(?:間)?/);
  const durationMinutes = duration
    ? Number(duration[1]) * 60 + Number(duration[2] ?? 0)
    : minutes ? Number(minutes[1]) : 60;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 480) {
    throw new TypeError("利用時間は30分から480分の範囲で指定してください。");
  }
  return {
    type: "find_room_availability",
    facilityQuery: rawFacility,
    date,
    endDate: addDays(date, 6),
    durationMinutes,
    windowStart: /午後/.test(text) ? "12:00" : "09:00",
    windowEnd: "17:00",
  };
}
