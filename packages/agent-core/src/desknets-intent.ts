import type { DeskNetsTask, ParticipantSelector } from "./contracts.js";

// Exported so other packages (e.g. the facility-preference inference in
// agent-api) can strip the same organizational suffixes without maintaining
// a second, potentially drifting copy of this list.
export const ORGANIZATION_SUFFIX =
  "(?:部|課|室|センター|事業部|統括部|本部|グループ|支店|事務所|ホールディングス)";
// Lazy so the shortest valid "...suffixの" is matched first. This keeps a
// hiragana-containing department name (e.g. "ものづくり推進部") intact while
// still stopping before a later, unrelated "...部の" in the same sentence.
// "と" is excluded because it is the conjunction used to list multiple
// participants ("Aさんと総務部のBさん"); without excluding it, a lazy match
// starting right after the previous "さん" would swallow it as a leading
// character of the next participant's organization.
const SELF_ORGANIZATION_NAME =
  "(?:当部|当部署|自部署|同じ部|同じ部署|自部門|同じ部門)";
const ORGANIZATION_NAME =
  `(?:${SELF_ORGANIZATION_NAME}|[^\\sと、。,.!！?？「」『』()（）0-9]{1,20}?${ORGANIZATION_SUFFIX})`;
const PARTICIPANT_TITLE =
  "(?:代表取締役|執行役員|取締役|副社長|本部長|支店長|副部長|副支店長|部長|次長|課長|室長|所長|係長|主任|専務|常務|マネージャー|リーダー)";
const PARTICIPANT_SUFFIX = `(?:さん|${PARTICIPANT_TITLE})`;
const PARTICIPANT_WITH_ORGANIZATION = new RegExp(
  `(?:^|[\\s、,，・]|と)(?:(${ORGANIZATION_NAME})の)?([々一-龯髙﨑]{1,12}?)(?:${PARTICIPANT_SUFFIX})?(?=$|[\\s、,，・]|と|で|だけ|[がはをに]|の(?:空き|予定|打ち合わせ|会議|直近|最短|一番早|最も早|今日|明日|今週|来週))`,
  "g",
);
const PARTICIPANT_SUFFIX_AT_END = new RegExp(`${PARTICIPANT_SUFFIX}$`);

const NON_PARTICIPANT_WORDS = new Set([
  "私",
  "本人",
  "今日",
  "明日",
  "今週",
  "今週中",
  "来週",
  "来週中",
  "今月",
  "今月中",
  "会議",
  "予定",
  "候補",
  "日程",
  "時間",
  "空き",
  "設備",
  "会議室",
  "応接室",
]);

export function parseDeskNetsTask(
  prompt: string,
  now: Date = new Date(),
): DeskNetsTask {
  const normalized = prompt.normalize("NFKC").trim();
  if (normalized === "") throw new TypeError("prompt must be a non-empty string.");

  const candidateNumber = readCandidateNumber(normalized);
  if (candidateNumber !== undefined) {
    return { type: "select_booking_candidate", candidateNumber };
  }

  if (/候補.*(?:戻|やめ|見せ|表示|一覧)|(?:戻|やめ).*候補/.test(normalized)) {
    return { type: "show_candidates" };
  }

  if (/^(?:はい|お願いします|送信します|送信する|送信で|メール送信で|メールを?送信(?:して|で)?)[。！!]?$/.test(normalized)) {
    return { type: "set_email_notification", sendEmail: true };
  }
  if (/^(?:いいえ|不要です|送信しません|送信しない)[。！!]?$/.test(normalized)) {
    return { type: "set_email_notification", sendEmail: false };
  }

  const participants = readParticipants(normalized);

  if (
    participants.length === 0 &&
    /(?:空いている|空いてる|空き)(?:時間帯|時間|枠)/.test(normalized) &&
    /(?:ルーム|会議室)/.test(normalized)
  ) {
    return {
      type: "find_facility_availability",
      facilityQuery: readFacilityQuery(normalized),
    };
  }

  if (/(?:セット|予約|登録|作成|設定|入れて|確保)(?:して|をお願い)/.test(normalized)) {
    const selectedWindow = readExplicitBookingWindow(normalized, now);
    const facilityQuery = readOptionalFacilityQuery(normalized);
    return {
      type: "book_meeting",
      ...(facilityQuery === undefined ? {} : { facilityQuery }),
      title: readMeetingTitle(prompt.trim()) ?? "",
      sendEmail: readEmailNotification(normalized),
      ...selectedWindow,
    };
  }

  const durationMinutes = readDurationMinutes(normalized);
  if (participants.length === 0) {
    if (durationMinutes !== undefined) {
      return { type: "change_availability_duration", durationMinutes };
    }
    throw new TypeError("少なくとも1名の参加者名を指定してください。");
  }

  const title = readMeetingTitle(prompt.trim());
  const facilityQuery = readOptionalFacilityQuery(normalized);
  return {
    type: "find_availability",
    participants,
    ...readDateRange(normalized, now),
    durationMinutes: durationMinutes ?? 60,
    ...(facilityQuery === undefined ? {} : { facilityQuery }),
    ...(title === undefined ? {} : { title }),
    ...(/(?:直近|最短|一番早|最も早)/.test(normalized)
      ? { selectionMode: "earliest" as const }
      : {}),
  };
}

export function normalizeParticipantName(value: string): string {
  return value.normalize("NFKC").trim().replace(PARTICIPANT_SUFFIX_AT_END, "").trim();
}

function readParticipants(prompt: string): ParticipantSelector[] {
  const participants = Array.from(prompt.matchAll(PARTICIPANT_WITH_ORGANIZATION), (match) => {
    const name = match[2]?.trim();
    if (name === undefined || name === "" || isNonParticipantWord(name)) return undefined;
    const organization = match[1]?.trim();
    return organization === undefined || organization === ""
      ? { name }
      : { name, organization };
  }).filter((selector): selector is ParticipantSelector => selector !== undefined);

  const keys = participants.map((selector) => `${selector.name}:${selector.organization ?? ""}`);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("参加者名が重複しています。");
  }
  return participants;
}

function isNonParticipantWord(value: string): boolean {
  return NON_PARTICIPANT_WORDS.has(value) ||
    /^(?:今週|来週)(?:の)?[月火水木金土日](?:曜日|曜)?$/.test(value);
}

function readCandidateNumber(prompt: string): number | undefined {
  const explicitlySelectsCandidate =
    /候補\s*\d+/.test(prompt) ||
    /\d+\s*番/.test(prompt) ||
    /^(?:では|じゃあ|それでは)?\s*\d+\s*で(?:確定|お願い|いい|進めて|予約|設定)/.test(prompt);
  if (!explicitlySelectsCandidate) return undefined;
  const match = prompt.match(/(?:では|じゃあ|それでは)?\s*(\d+)\s*(?:番|で)(?:確定|お願いします|予約|セット)?/);
  if (match?.[1] === undefined) return undefined;
  const candidateNumber = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(candidateNumber) && candidateNumber > 0
    ? candidateNumber
    : undefined;
}

function readFacilityQuery(prompt: string): string {
  const query = readOptionalFacilityQuery(prompt);
  if (query === undefined) throw new TypeError("予約する設備名を指定してください。");
  return query;
}

// Matches a bare facility name (e.g. "有玉", "品川", "アクト") that has no
// letter suffix and so isn't caught by the ルーム/会議室 patterns above:
// either "<name>の会議室で/の設備で" or "<name>で会議/打ち合わせ/予約/セット/設定/確保".
// Lazy so the shortest valid name is matched (e.g. "品川" in "品川の会議室で
// 予約して"), rather than backtracking past a later "で予約" and swallowing
// "の会議室" into the captured name.
// The lookbehind stops the capture from starting mid-date/time expression:
// without it, in "...11時に有玉で会議を設定して" the leftmost successful
// match starts right after the digit "1" (blocked by the digit exclusion
// below) or right after "時", swallowing "時に有玉" instead of "有玉". "に"
// itself is left out of the lookbehind because it is the natural particle
// separating a time clause from the facility name that follows it.
const BARE_FACILITY_NAME = new RegExp(
  '(?<![0-9時分月日年])([^\\sと、。,.!！?？「」『』()（）0-9]{2,10}?)(?:の(?:会議室|設備)|で(?:会議|打ち合わせ|予約|セット|設定|確保|登録|作成))',
);

function readOptionalFacilityQuery(prompt: string): string | undefined {
  const quotedFacility = prompt.match(/設備\s*[「"]([^」"]+)[」"]/);
  if (quotedFacility?.[1] !== undefined && quotedFacility[1].trim() !== "") {
    return quotedFacility[1].trim();
  }
  const room = prompt.match(/(?:ミーティング)?ルーム\s*([A-Z])/i);
  if (room?.[1] !== undefined) return `ルーム${room[1].toUpperCase()}`;
  const meetingRoom = prompt.match(/会議室\s*([A-Z])/i);
  if (meetingRoom?.[1] !== undefined) return `ルーム${meetingRoom[1].toUpperCase()}`;
  const labelledFacility = prompt.match(
    /(?:会議室|設備)\s*(?:は|を|:|：)\s*([^\s、。,.!！?？「」『』()（）]{2,20}?)(?=で(?:お願い|よろしく|$|[、。,.!！?？])|に(?:して|設定して)(?:ください)?(?:[、。,.!！?？]|$)|[、。,.!！?？]|$)/,
  );
  if (labelledFacility?.[1] !== undefined && labelledFacility[1].trim() !== "") {
    return labelledFacility[1].trim();
  }
  const bareFacility = prompt.match(BARE_FACILITY_NAME);
  if (bareFacility?.[1] !== undefined && bareFacility[1].trim() !== "") {
    const candidate = bareFacility[1].trim();
    if (PARTICIPANT_SUFFIX_AT_END.test(candidate) || NON_PARTICIPANT_WORDS.has(candidate)) return undefined;
    return candidate;
  }
  return undefined;
}

function readEmailNotification(prompt: string): boolean {
  if (/メール.*(?:送信|発信).*(?:しない|不要|なし)/.test(prompt)) return false;
  // Email and notification to the requesting user are the safe operational
  // defaults. An explicit opt-out still takes precedence.
  return true;
}

function readMeetingTitle(prompt: string): string | undefined {
  const quoted = prompt.match(/(?:議題|件名)\s*[:=＝]\s*[「"]([^」"]+)[」"]/);
  if (quoted?.[1] !== undefined && quoted[1].trim() !== "") return quoted[1].trim();
  const plain = prompt.match(/(?:議題|件名)\s*[:=＝]\s*([^。\n]+)/);
  const title = plain?.[1]?.trim();
  return title === undefined || title === "" ? undefined : title;
}

/** Read a duration, excluding the minutes belonging to a clock time. */
export function readDurationMinutes(prompt: string): number | undefined {
  const durationText = prompt.normalize("NFKC")
    .replace(/\d{1,2}\s*時(?!間)(?:\s*\d{1,2}\s*分|\s*半)?/g, " ");
  const hours = durationText.match(/(?<!\d)(\d+)\s*時間(?:\s*(半)|\s*(\d+)\s*分)?/);
  const minutes = hours === null ? durationText.match(/(?<!\d)(\d+)\s*分(?:間)?/) : null;
  if (hours === null && minutes === null) return undefined;
  const value = hours !== null
    ? Number(hours[1]) * 60 + (hours[2] ? 30 : Number(hours[3] ?? 0))
    : Number.parseInt(minutes?.[1] ?? "0", 10);
  if (!Number.isSafeInteger(value) || value < 30 || value > 480) {
    throw new TypeError("打ち合わせ時間は30分から480分の範囲で指定してください。");
  }
  return value;
}

function readExplicitBookingWindow(
  prompt: string,
  now: Date,
): { selectedStart?: string; selectedEnd?: string } {
  const time = prompt.match(
    /(\d{1,2})\s*[:時]\s*(\d{1,2})?(?:\s*分)?\s*(?:-|〜|~|から)\s*(\d{1,2})\s*[:時]\s*(\d{1,2})?(?:\s*分)?/,
  );
  if (time === null) return {};
  if (!/(?:今日|明日|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*[/.-]\s*\d{1,2})/.test(prompt)) {
    throw new TypeError("直接予約する場合は日付と開始・終了時刻を指定してください。");
  }
  const { date } = readDateRange(prompt, now);
  const startHour = Number.parseInt(time[1] ?? "", 10);
  const startMinute = Number.parseInt(time[2] ?? "0", 10);
  const endHour = Number.parseInt(time[3] ?? "", 10);
  const endMinute = Number.parseInt(time[4] ?? "0", 10);
  if (
    startHour < 0 || startHour > 23 || startMinute < 0 || startMinute > 59 ||
    endHour < 0 || endHour > 23 || endMinute < 0 || endMinute > 59
  ) {
    throw new TypeError("有効な開始・終了時刻を指定してください。");
  }
  const selectedStart = new Date(`${date}T${pad2(startHour)}:${pad2(startMinute)}:00+09:00`);
  const selectedEnd = new Date(`${date}T${pad2(endHour)}:${pad2(endMinute)}:00+09:00`);
  if (selectedEnd.getTime() <= selectedStart.getTime()) {
    throw new TypeError("終了時刻は開始時刻より後にしてください。");
  }
  return { selectedStart: selectedStart.toISOString(), selectedEnd: selectedEnd.toISOString() };
}

function readDateRange(
  prompt: string,
  now: Date,
): { date: string; endDate: string } {
  const today = japanDate(now);
  const explicitRange = readExplicitDateRange(prompt, now);
  if (explicitRange !== undefined) return explicitRange;
  if (/今日/.test(prompt)) return { date: today, endDate: today };
  if (/明日/.test(prompt)) {
    const tomorrow = addDays(today, 1);
    return { date: tomorrow, endDate: tomorrow };
  }
  const nextWeekday = prompt.match(/来週(?:の)?([月火水木金土日])(?:曜日|曜)?/);
  if (nextWeekday?.[1] !== undefined) {
    const weekdayOffset = "月火水木金土日".indexOf(nextWeekday[1]);
    const currentWeekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const daysUntilNextMonday = 8 - (currentWeekday === 0 ? 7 : currentWeekday);
    const date = addDays(today, daysUntilNextMonday + weekdayOffset);
    return { date, endDate: date };
  }
  const thisWeekday = prompt.match(/今週(?:の)?([月火水木金土日])(?:曜日|曜)?/);
  if (thisWeekday?.[1] !== undefined) {
    const targetIsoWeekday = "月火水木金土日".indexOf(thisWeekday[1]) + 1;
    const currentWeekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const currentIsoWeekday = currentWeekday === 0 ? 7 : currentWeekday;
    const date = addDays(today, targetIsoWeekday - currentIsoWeekday);
    return { date, endDate: date };
  }
  if (/今週/.test(prompt)) {
    // "今週" covers today through this week's Friday, never the past days
    // already gone by (unlike 来週, which always starts at next Monday) and
    // never Saturday/Sunday (meeting candidates don't need weekend dates).
    // If today is itself Sat/Sun, no weekday is left this week; fall back to
    // just today rather than returning an inverted (endDate < date) range.
    const day = new Date(`${today}T00:00:00Z`).getUTCDay();
    const daysUntilFriday = day === 0 || day === 6 ? 0 : 5 - day;
    return { date: today, endDate: addDays(today, daysUntilFriday) };
  }
  const weeks = prompt.match(/(\d{1,2})\s*週間以内/);
  if (weeks?.[1] !== undefined) {
    const days = Number.parseInt(weeks[1], 10) * 7;
    if (days < 1 || days > 31) throw new TypeError("検索期間は31日以内で指定してください。");
    return { date: today, endDate: addDays(today, days - 1) };
  }
  if (/今月中/.test(prompt)) {
    const [year, month] = today.split("-").map(Number);
    if (year === undefined || month === undefined) throw new TypeError("現在日付を解釈できません。");
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      date: today,
      endDate: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${lastDay.toString().padStart(2, "0")}`,
    };
  }
  if (/来週/.test(prompt)) {
    const day = new Date(`${today}T00:00:00Z`).getUTCDay();
    const daysUntilNextMonday = 8 - (day === 0 ? 7 : day);
    const date = addDays(today, daysUntilNextMonday);
    return { date, endDate: addDays(date, 6) };
  }

  // A natural request such as "髙田部長との打ち合わせ可能な日程を教えて"
  // should work without making the user restate today's date. Search from the
  // current Japan date through the next six calendar days; same-day slots that
  // have already started are removed later using the exact current instant.
  if (!/(?:20\d{2}年)?\d{1,2}月\d{1,2}日|\d{1,2}[/.]\d{1,2}/.test(prompt)) {
    return { date: today, endDate: addDays(today, 6) };
  }

  const full = prompt.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  const short = prompt.match(/(\d{1,2})月(\d{1,2})日/);
  const shortSlash = prompt.match(/(\d{1,2})[/.](\d{1,2})/);
  const year = full?.[1] === undefined ? now.getFullYear() : Number.parseInt(full[1], 10);
  const monthText = full?.[2] ?? short?.[1] ?? shortSlash?.[1];
  const dayText = full?.[3] ?? short?.[2] ?? shortSlash?.[2];
  if (monthText === undefined || dayText === undefined) {
    throw new TypeError("日付を「8月6日」または「2026年8月6日」の形式で指定してください。");
  }
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError("有効な日付を指定してください。");
  }
  const date = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  return { date, endDate: date };
}

function readExplicitDateRange(
  prompt: string,
  now: Date,
): { date: string; endDate: string } | undefined {
  const japanese = prompt.match(
    /(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日\s*(?:から|〜|~|-)\s*(?:(?:(20\d{2})年)?(?:(\d{1,2})月)?)?(\d{1,2})日/,
  );
  const slash = japanese === null
    ? prompt.match(/(?:(20\d{2})[/.])?(\d{1,2})[/.](\d{1,2})\s*(?:から|〜|~|-)\s*(?:(?:(20\d{2})[/.])?(?:(\d{1,2})[/.])?)?(\d{1,2})/)
    : null;
  const match = japanese ?? slash;
  if (match === null) return undefined;
  const startYear = Number.parseInt(match[1] ?? String(now.getFullYear()), 10);
  const startMonth = Number.parseInt(match[2] ?? "", 10);
  const startDay = Number.parseInt(match[3] ?? "", 10);
  const endYear = Number.parseInt(match[4] ?? String(startYear), 10);
  const endMonth = Number.parseInt(match[5] ?? String(startMonth), 10);
  const endDay = Number.parseInt(match[6] ?? "", 10);
  const date = formatValidDate(startYear, startMonth, startDay);
  const endDate = formatValidDate(endYear, endMonth, endDay);
  if (endDate < date) throw new TypeError("終了日は開始日以降にしてください。");
  return { date, endDate };
}

function formatValidDate(year: number, month: number, day: number): string {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError("有効な日付を指定してください。");
  }
  return `${year.toString().padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function japanDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new TypeError("現在日付を解釈できません。");
  }
  return `${year}-${month}-${day}`;
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
