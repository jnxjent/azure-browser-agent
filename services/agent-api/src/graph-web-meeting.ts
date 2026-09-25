import { assertTeamsJoinUrl, type PasscodeAvailability } from "@azure-browser-agent/agent-core";

/**
 * Microsoft Graph への最小限の呼び出し。会議の作成・更新・情報取得だけを行う。
 *
 * 招待メールについて: 参加者を含むイベントを作成するとサーバーが全員へ招待を送信し、
 * その動作は設定で無効化できない（公式仕様）。ユーザー確定事項②「Teams側の招待メールは
 * 送らない」を満たす唯一の方法が参加者を空にすることなので、`attendees` は常に空配列を
 * 送り、引数として受け取らない。結果として予定が入るのは主催者のカレンダーだけになる。
 *
 * 主催者は常に操作者本人（`/me`）。代理主催（秘書が上司名義で作成）は初期版では未対応。
 */

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
/** Graphが受け付けるWindowsタイムゾーン名。DeskNet's側と同じ日本時間に固定する。 */
export const GRAPH_TIME_ZONE = "Tokyo Standard Time";

export interface GraphCallRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  body?: unknown;
}

export interface GraphCallResponse {
  status: number;
  body: unknown;
}

/** テストではここを差し替えてGraphをモック化する。実通信は`createGraphCall`。 */
export type GraphCall = (request: GraphCallRequest) => Promise<GraphCallResponse>;

export class GraphRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GraphRequestError";
  }
}

export interface CalendarEventInput {
  subject: string;
  /** 日本時間のローカル日時（`2026-10-01T10:00:00`）。 */
  startLocal: string;
  endLocal: string;
  /** 再試行でも同じ値を使い回すことで、二重作成を防ぐ。 */
  transactionId: string;
}

export interface CreatedCalendarEvent {
  eventId: string;
  /** 応答に含まれない場合があるため、取得できなければ後からイベントを読み直す。 */
  joinUrl?: string;
}

export interface OnlineMeetingDetails {
  meetingId?: string;
  passcode?: string;
  passcodeAvailability: PasscodeAvailability;
}

export class GraphWebMeetingClient {
  constructor(private readonly call: GraphCall) {}

  async createCalendarEvent(input: CalendarEventInput): Promise<CreatedCalendarEvent> {
    const body = await this.request({
      method: "POST",
      url: `${GRAPH_BASE_URL}/me/events`,
      body: {
        subject: input.subject,
        start: { dateTime: input.startLocal, timeZone: GRAPH_TIME_ZONE },
        end: { dateTime: input.endLocal, timeZone: GRAPH_TIME_ZONE },
        // 招待を出さないための空配列。要素を足すと招待が送信される。
        attendees: [],
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        transactionId: input.transactionId,
      },
    });
    const eventId = readString(readRecord(body).id);
    if (eventId === undefined) {
      throw new GraphRequestError("Graph did not return an event ID.", 500);
    }
    const joinUrl = readJoinUrl(body);
    return { eventId, ...(joinUrl === undefined ? {} : { joinUrl }) };
  }

  async updateCalendarEvent(
    eventId: string,
    input: Omit<CalendarEventInput, "transactionId">,
  ): Promise<void> {
    // 日時変更は同じイベントを更新して再利用する。作り直すと会議IDとパスコードが変わる。
    await this.request({
      method: "PATCH",
      url: `${GRAPH_BASE_URL}/me/events/${encodeURIComponent(eventId)}`,
      body: {
        subject: input.subject,
        start: { dateTime: input.startLocal, timeZone: GRAPH_TIME_ZONE },
        end: { dateTime: input.endLocal, timeZone: GRAPH_TIME_ZONE },
      },
    });
  }

  async readCalendarEventJoinUrl(eventId: string): Promise<string | undefined> {
    const body = await this.request({
      method: "GET",
      url: `${GRAPH_BASE_URL}/me/events/${encodeURIComponent(eventId)}`,
    });
    return readJoinUrl(body);
  }

  /**
   * 参加URLから会議IDとパスコードを引く。イベントの応答には含まれないため別呼び出しになる。
   * `conferenceId` は電話会議用の番号であり、ここで求めている会議IDではない。
   */
  async readOnlineMeetingDetails(joinUrl: string): Promise<OnlineMeetingDetails> {
    const requested = assertTeamsJoinUrl(joinUrl).href;
    // ODataの文字列リテラルではシングルクォートを2つ重ねて表す。値をそのまま埋めない。
    const filter = `JoinWebUrl eq '${requested.replaceAll("'", "''")}'`;
    const body = await this.request({
      method: "GET",
      url: `${GRAPH_BASE_URL}/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`,
    });
    // 単一オブジェクトではなく1件のコレクションで返る。
    const value = readRecord(body).value;
    if (Array.isArray(value) && value.length === 0) {
      throw new GraphRequestError("Teams会議の情報をまだ取得できません。", 503);
    }
    const meeting = Array.isArray(value) ? readRecord(value[0]) : readRecord(body);
    // 別の会議の会議ID・パスコードを本文へ貼らないため、返ってきた会議を必ず照合する。
    const returned = readString(meeting.joinWebUrl);
    if (returned !== undefined && returned !== requested) {
      throw new GraphRequestError("要求した会議とは別の会議が返されました。", 502);
    }
    const settings = readRecord(meeting.joinMeetingIdSettings);
    const meetingId = readString(settings.joinMeetingId);
    const passcode = readString(settings.passcode);
    // 「不要」と「取得失敗」を区別する。設定自体が無い場合は取得失敗として扱う。
    const passcodeAvailability: PasscodeAvailability =
      passcode !== undefined
        ? "required"
        : settings.isPasscodeRequired === false
          ? "not_required"
          : "unavailable";
    return {
      ...(meetingId === undefined ? {} : { meetingId }),
      ...(passcodeAvailability === "required" && passcode !== undefined ? { passcode } : {}),
      passcodeAvailability,
    };
  }

  private async request(request: GraphCallRequest): Promise<unknown> {
    const response = await this.call(request);
    if (response.status < 200 || response.status >= 300) {
      // 本文にはトークンや参加情報が混ざりうるので、そのまま外へ出さない。
      throw new GraphRequestError(
        `Microsoft 365への要求が失敗しました（HTTP ${response.status}）。`,
        response.status,
      );
    }
    return response.body;
  }
}

/** 実通信。アクセストークンは呼び出しごとに渡し、保存もログ出力もしない。 */
export function createGraphCall(accessToken: string): GraphCall {
  const token = accessToken.trim();
  if (!token || /[\r\n]/.test(token)) {
    throw new TypeError("A Microsoft 365 access token must be a non-empty single-line string.");
  }
  return async ({ method, url, body }) => {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  };
}

/** 予定の開始・終了（オフセット付きinstant）を日本時間のローカル日時へ落とす。 */
export function toJapanLocalDateTime(instant: string): string {
  const parsed = Date.parse(instant);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(instant) || !Number.isFinite(parsed)) {
    throw new TypeError("A meeting instant must carry an explicit UTC offset.");
  }
  return new Date(parsed + 9 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

function readJoinUrl(body: unknown): string | undefined {
  const joinUrl = readString(readRecord(readRecord(body).onlineMeeting).joinUrl);
  if (joinUrl === undefined) return undefined;
  // Graph由来でも、貼り付ける前に必ずTeamsのURLであることを確かめる。
  return assertTeamsJoinUrl(joinUrl).href;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" || /[\r\n]/.test(text) ? undefined : text;
}
