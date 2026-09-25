/**
 * Teams WEB会議情報の整形と、会話条件としての「WEB希望」の判定。
 *
 * このモジュールが保証するのは **ユーザーがコピーする文字列を組み立てるところまで**。
 * AzureChatは会社PCのDeskNet's本文を読めないため、貼り付け先で既存本文が保持されたか、
 * 同じ情報が二重に貼られていないかは検証できない。`upsertWebMeetingBlock` の置換・
 * 重複排除も、カード上で組み立てる文字列に対してのみ有効である。
 * 詳細は docs/teams-meeting-info-copy-2026-09-24.md の3.2。
 */

/** パスコードは会議ポリシー次第で発行されない。「不要」と「取得失敗」を混同しない。 */
export type PasscodeAvailability = "required" | "not_required" | "unavailable";

export interface WebMeetingDetails {
  joinUrl: string;
  /** Graphが会議IDを返さなかった場合は undefined。値を生成・推測しない。 */
  meetingId?: string;
  /** passcodeAvailability が "required" のときだけ入る。 */
  passcode?: string;
  passcodeAvailability: PasscodeAvailability;
}

export const WEB_MEETING_BLOCK_START = "【Teams WEB会議】";
export const WEB_MEETING_BLOCK_END = "【Teams WEB会議情報ここまで】";

const BLOCK_SOURCE =
  `${escapeForRegExp(WEB_MEETING_BLOCK_START)}[\\s\\S]*?${escapeForRegExp(WEB_MEETING_BLOCK_END)}`;
/** 直前の空行ごと捕まえるので、重複を消した跡に余白が残らない。 */
const blockPattern = (): RegExp => new RegExp(`(\\n*)(${BLOCK_SOURCE})`, "g");

const ALLOWED_JOIN_HOSTS = ["teams.microsoft.com", "teams.cloud.microsoft"];

/** Teamsの参加URLだけを通す。取得元がGraphでも、貼り付ける前に必ず通す。 */
export function assertTeamsJoinUrl(joinUrl: string): URL {
  const url = new URL(joinUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !ALLOWED_JOIN_HOSTS.includes(url.hostname)
  ) {
    throw new Error("Unsupported Teams join URL.");
  }
  return url;
}

export function buildWebMeetingBlock(details: WebMeetingDetails): string {
  const url = assertTeamsJoinUrl(details.joinUrl);
  for (const value of [details.meetingId, details.passcode]) {
    if (value !== undefined && (!value.trim() || /[\r\n]/.test(value))) {
      throw new Error("Invalid meeting information.");
    }
  }
  // 不整合をそのまま文字列にすると、取得できていない値を貼ってしまう。
  if (details.passcodeAvailability === "required" && details.passcode === undefined) {
    throw new Error("A required passcode is missing.");
  }
  if (details.passcodeAvailability !== "required" && details.passcode !== undefined) {
    throw new Error("A passcode was supplied although it is not required.");
  }
  return [
    WEB_MEETING_BLOCK_START,
    `参加URL: ${url.href}`,
    ...(details.meetingId === undefined ? [] : [`会議ID: ${details.meetingId}`]),
    ...(details.passcode === undefined ? [] : [`パスコード: ${details.passcode}`]),
    WEB_MEETING_BLOCK_END,
  ].join("\n");
}

/**
 * 既存の管理ブロックを新しい内容へ置き換える。複数ある場合は最初の位置に1つだけ残す。
 * 終了マーカーを欠いた壊れた書きかけは、境界を確定できないため触らずに残し、末尾へ追記する。
 */
export function upsertWebMeetingBlock(body: string, details: WebMeetingDetails): string {
  const block = buildWebMeetingBlock(details);
  let replaced = false;
  // ブロック以外の本文には触れない。空白・改行の整形もしない。
  const updated = body.replace(blockPattern(), (_match, gap: string) => {
    if (replaced) return "";
    replaced = true;
    return `${gap}${block}`;
  });
  return replaced ? updated : body ? `${body}\n\n${block}` : block;
}

export function removeWebMeetingBlock(body: string): string {
  return body.replace(blockPattern(), "").replace(/^\n+/, "");
}

/**
 * カードに出す補足。「不要」と「取得失敗」を別の文言にするためのもので、
 * 取得失敗があるうちは complete を false にして再試行を促す。
 */
export function describeWebMeetingCompleteness(details: WebMeetingDetails): {
  complete: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  let complete = true;
  if (details.meetingId === undefined) {
    notes.push("会議IDを取得できませんでした。再試行してください。");
    complete = false;
  }
  if (details.passcodeAvailability === "not_required") {
    notes.push("この会議ではパスコードは不要です。");
  } else if (details.passcodeAvailability === "unavailable") {
    notes.push("パスコードを取得できませんでした。再試行してください。");
    complete = false;
  }
  return { complete, notes };
}

const WEB_MEETING_KEYWORD = "(?:web|ウェブ|オンライン|teams|チームズ|リモート)";
// 否定語はキーワードの直後とは限らない（「WEB会議にしないで」「オンラインでの打ち合わせは不要」）。
// 文の区切りまでの範囲だけを見て、別の文の否定を巻き込まない。判定に迷う場合は否定側に倒す。
const WEB_MEETING_DECLINED = new RegExp(
  `${WEB_MEETING_KEYWORD}[^。、!?！？\\n]{0,15}?` +
    "(?:不要|いらない|要らない|なし|無し|使わない|使用しない|やめて|やめる|やめ|不使用|" +
    "しないで|しない|せずに|ではなく|じゃなく|ではない|じゃない|中止|取り消)",
);
const WEB_MEETING_REQUESTED = new RegExp(
  "(?:web会議|ウェブ会議|オンライン会議|teams会議|web(?:で|を|も|に)|ウェブ(?:で|を)|" +
    "teams(?:で|を|も|に)|チームズ(?:で|を)|リモート(?:で|開催)|オンライン(?:で|開催))",
);

/**
 * 「WEB希望」は会話の条件として保持するだけで、これ自体は会議を作成しない。
 * 実際の発行は、日時確定後の明示的な「Teams会議を作成」操作に限る。
 * 否定・取消を肯定指示として扱わないため、否定を先に判定する。
 */
export function detectWebMeetingRequest(
  prompt: string,
): "requested" | "declined" | undefined {
  const normalized = prompt.normalize("NFKC").toLowerCase();
  if (WEB_MEETING_DECLINED.test(normalized)) return "declined";
  if (WEB_MEETING_REQUESTED.test(normalized)) return "requested";
  return undefined;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
