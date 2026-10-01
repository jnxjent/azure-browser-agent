import type { FindAvailabilityTask } from "@azure-browser-agent/agent-core";

const LOCATIONS = [
  "ミダックこなん", "奥山の杜CC", "浜名湖CC", "遠州CC", "御殿山",
  "富士宮", "名古屋", "アクト", "有玉", "品川", "奥山", "都田",
];
const DAY_MS = 86_400_000;

export interface RequiredFacilityRequest {
  locations: string[];
  queries?: string[];
}

function currentJapanDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function namedRoomAtLocation(text: string, location: string): string | undefined {
  const start = text.indexOf(location);
  if (start < 0) return undefined;
  const part = text.slice(start).split(/(?:と|及び|および|、|,|。)/, 1)[0] ?? "";
  const match = part.match(/^(.*?(?:ミーティングルーム|会議室|応接室)(?:[A-Z0-9])?)/);
  return match?.[1]?.trim();
}

/** Read simultaneous locations and, when present, the explicitly named room at each site. */
export function readRequiredFacilityRequest(prompt: string): RequiredFacilityRequest | undefined {
  const text = prompt.normalize("NFKC");
  if (!/(?:会議室|応接室|ミーティングルーム)/.test(text)) return undefined;
  const locations = LOCATIONS.filter((location) => text.includes(location) &&
    !LOCATIONS.some((longer) => longer !== location && longer.includes(location) && text.includes(longer)));
  if (locations.length < 2) return undefined;
  if (locations.length > 10) {
    throw new TypeError("同時に指定できる会議室は10室までです。");
  }
  const namedLocations = locations.map((location) => location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (new RegExp(`(?:${namedLocations})\\s*(?:か|または|又は)\\s*(?:${namedLocations})`).test(text)) {
    return undefined;
  }
  const explicitlySimultaneous = /(?:それぞれ|各(?:拠点|場所|事務所|本社)|両方|双方|両拠点)/.test(text);
  const queries = locations.map((location) => namedRoomAtLocation(text, location));
  const allRoomsNamed = queries.every((query): query is string => query !== undefined);
  if (!explicitlySimultaneous && !allRoomsNamed) return undefined;
  return {
    locations,
    ...(allRoomsNamed ? { queries } : {}),
  };
}

/** Only explicit requests for one room at each named site use the intersection. */
export function readRequiredFacilityLocations(prompt: string): string[] | undefined {
  return readRequiredFacilityRequest(prompt)?.locations;
}

/** Deterministic self-and-multiple-rooms search used before the general intent model. */
export function parseMultiRoomAvailability(
  prompt: string,
  now: Date = new Date(),
): FindAvailabilityTask | undefined {
  const text = prompt.normalize("NFKC");
  const required = readRequiredFacilityRequest(text);
  if (required === undefined || required.queries === undefined ||
      !/(?:空き|空いて|使える|予約でき|確保でき|利用でき)/.test(text) ||
      /(?:さん|部長|次長|課長|参加者|出席者)/.test(text)) return undefined;

  const today = currentJapanDate(now);
  const dateMatch = text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/);
  let date = today;
  if (dateMatch !== null) {
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
  const hours = text.match(/(\d+)\s*時間(?:\s*(\d+)\s*分)?/);
  const minutes = text.match(/(\d+)\s*分(?:間)?/);
  const durationMinutes = hours
    ? Number(hours[1]) * 60 + Number(hours[2] ?? 0)
    : minutes ? Number(minutes[1]) : 60;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 480) {
    throw new TypeError("利用時間は30分から480分の範囲で指定してください。");
  }
  return {
    type: "find_availability",
    participants: [],
    date,
    endDate: addDays(date, 6),
    durationMinutes,
    requiredFacilityLocations: required.locations,
    requiredFacilityQueries: required.queries,
    ...(/午前/.test(text)
      ? { windowStart: "09:00", windowEnd: "12:00" }
      : /午後/.test(text)
        ? { windowStart: "13:00", windowEnd: "18:00" }
        : {}),
    ...(/(?:以降|から)/.test(text) ? { autoExtendSearch: true } : {}),
  };
}
