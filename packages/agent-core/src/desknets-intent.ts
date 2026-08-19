import type { DeskNetsTask } from "./contracts.js";

const JAPANESE_NAME = /([々一-龯髙﨑]{1,12})さん/g;

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

  if (/^(?:はい|お願いします|送信します|送信する)[。！!]?$/.test(normalized)) {
    return { type: "set_email_notification", sendEmail: true };
  }
  if (/^(?:いいえ|不要です|送信しません|送信しない)[。！!]?$/.test(normalized)) {
    return { type: "set_email_notification", sendEmail: false };
  }

  if (
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
    return {
      type: "book_meeting",
      facilityQuery: readFacilityQuery(normalized),
      title: readMeetingTitle(prompt.trim()) ?? "",
      sendEmail: readEmailNotification(normalized),
      ...selectedWindow,
    };
  }

  const participantNames = Array.from(normalized.matchAll(JAPANESE_NAME), (match) =>
    match[1]?.trim(),
  ).filter((name): name is string => name !== undefined && name !== "");
  const durationMinutes = readDurationMinutes(normalized);
  if (participantNames.length === 0) {
    if (durationMinutes !== undefined) {
      return { type: "change_availability_duration", durationMinutes };
    }
    throw new TypeError("少なくとも1名を「○○さん」の形式で指定してください。");
  }
  if (new Set(participantNames).size !== participantNames.length) {
    throw new TypeError("参加者名が重複しています。");
  }

  const title = readMeetingTitle(prompt.trim());
  return {
    type: "find_availability",
    participantNames,
    ...readDateRange(normalized, now),
    durationMinutes: durationMinutes ?? 60,
    ...(title === undefined ? {} : { title }),
  };
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
  const quotedFacility = prompt.match(/設備\s*[「"]([^」"]+)[」"]/);
  if (quotedFacility?.[1] !== undefined && quotedFacility[1].trim() !== "") {
    return quotedFacility[1].trim();
  }
  const room = prompt.match(/(?:ミーティング)?ルーム\s*([A-Z])/i);
  if (room?.[1] !== undefined) return `ルーム${room[1].toUpperCase()}`;
  const meetingRoom = prompt.match(/会議室\s*([A-Z])/i);
  if (meetingRoom?.[1] !== undefined) return `ルーム${meetingRoom[1].toUpperCase()}`;
  throw new TypeError("予約する設備名を指定してください。");
}

function readEmailNotification(prompt: string): boolean {
  if (/メール.*(?:送信|発信).*(?:しない|不要|なし)/.test(prompt)) return false;
  return /メール.*(?:送信|発信)/.test(prompt);
}

function readMeetingTitle(prompt: string): string | undefined {
  const quoted = prompt.match(/(?:議題|件名)\s*[:=＝]\s*[「"]([^」"]+)[」"]/);
  if (quoted?.[1] !== undefined && quoted[1].trim() !== "") return quoted[1].trim();
  const plain = prompt.match(/(?:議題|件名)\s*[:=＝]\s*([^。\n]+)/);
  const title = plain?.[1]?.trim();
  return title === undefined || title === "" ? undefined : title;
}

function readDurationMinutes(prompt: string): number | undefined {
  const hours = prompt.match(/(\d{1,2})\s*時間(?:\s*(\d{1,2})\s*分)?/);
  const minutes = hours === null ? prompt.match(/(\d{1,3})\s*分(?:間)?/) : null;
  if (hours === null && minutes === null) return undefined;
  const value = hours !== null
    ? Number.parseInt(hours[1] ?? "0", 10) * 60 + Number.parseInt(hours[2] ?? "0", 10)
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
