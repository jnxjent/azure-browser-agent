import { randomUUID } from "node:crypto";
import {
  WEB_MEETING_BLOCK_END,
  buildWebMeetingBlock,
  describeWebMeetingCompleteness,
  type WebMeetingDetails,
} from "@azure-browser-agent/agent-core";
import {
  GraphRequestError,
  toJapanLocalDateTime,
  type GraphWebMeetingClient,
} from "./graph-web-meeting.js";
import type { WebMeetingOwner, WebMeetingRecord, WebMeetingStore } from "./web-meeting-store.js";

/**
 * WEB会議の発行とその再開。
 *
 * 発行は、日時が確定したうえでの明示的な「Teams会議を作成」操作からだけ呼ぶ。
 * 候補選択・カード再表示・会議室変更・コピー操作からは呼ばない。
 */

export class WebMeetingNotRequestedError extends Error {
  constructor() {
    super(
      "この会話ではWEB会議が希望されていません。WEB会議が必要な場合は「WEBで」と指示してください。",
    );
    this.name = "WebMeetingNotRequestedError";
  }
}

export interface WebMeetingSchedule {
  /** 件名。未指定なら空文字のまま扱い、仮の件名を作らない。 */
  subject: string;
  start: string;
  end: string;
}

export async function ensureWebMeeting(options: {
  store: WebMeetingStore;
  client: GraphWebMeetingClient;
  owner: WebMeetingOwner;
  schedule: WebMeetingSchedule;
  newTransactionId?: () => string;
}): Promise<WebMeetingRecord> {
  const { store, client, owner, schedule } = options;
  const newTransactionId = options.newTransactionId ?? (() => randomUUID());
  const startLocal = toJapanLocalDateTime(schedule.start);
  const endLocal = toJapanLocalDateTime(schedule.end);

  const existing = await store.get(owner);
  if (existing?.requested !== true) throw new WebMeetingNotRequestedError();

  // 作成要求を出す前に冪等キーを保存する。応答が失われても次の試行が同じ値を送る。
  let record = await store.mutate(owner, (current) =>
    current.transactionId === undefined
      ? { ...current, transactionId: newTransactionId(), status: "creating" }
      : current.status === "failed"
        ? { ...current, status: current.eventId === undefined ? "creating" : "created_pending_details" }
        : undefined,
  );

  try {
    if (record.eventId === undefined) {
      const created = await client.createCalendarEvent({
        subject: schedule.subject,
        startLocal,
        endLocal,
        transactionId: record.transactionId as string,
      });
      record = await store.mutate(owner, (current) =>
        patched(current, {
          eventId: created.eventId,
          joinUrl: created.joinUrl,
          subject: schedule.subject === "" ? undefined : schedule.subject,
          start: schedule.start,
          end: schedule.end,
          revision: Math.max(current.revision, 1),
          status: "created_pending_details",
          lastError: undefined,
        }),
      );
    } else if (hasScheduleChanged(record, schedule)) {
      // 日時・件名の変更は同じイベントを更新して再利用する。会議IDとパスコードは変わらない。
      await client.updateCalendarEvent(record.eventId, {
        subject: schedule.subject,
        startLocal,
        endLocal,
      });
      record = await store.mutate(owner, (current) =>
        patched(current, {
          subject: schedule.subject === "" ? undefined : schedule.subject,
          start: schedule.start,
          end: schedule.end,
          // 更新番号を上げて、過去のカードからのコピーを止める。
          revision: current.revision + 1,
          lastError: undefined,
        }),
      );
    }

    if (record.joinUrl === undefined) {
      const joinUrl = await client.readCalendarEventJoinUrl(record.eventId as string);
      if (joinUrl === undefined) {
        throw new GraphRequestError("Teams会議の参加URLをまだ取得できません。", 503);
      }
      record = await store.mutate(owner, (current) => patched(current, { joinUrl }));
    }

    if (record.status !== "ready") {
      const joinUrl = record.joinUrl as string;
      const details = await client.readOnlineMeetingDetails(joinUrl);
      // Graphのオンライン会議側は予定作成に遅れて揃うことがある。取得しきれていないうちは
      // "ready" にしない。ここで ready にすると、次の再取得が素通りして永久に埋まらない。
      const { complete } = describeWebMeetingCompleteness({
        joinUrl,
        ...(details.meetingId === undefined ? {} : { meetingId: details.meetingId }),
        ...(details.passcode === undefined ? {} : { passcode: details.passcode }),
        passcodeAvailability: details.passcodeAvailability,
      });
      record = await store.mutate(owner, (current) =>
        patched(current, {
          meetingId: details.meetingId,
          // 「不要」「取得失敗」へ変わったときに古いパスコードを残さない。
          passcode: details.passcode,
          passcodeAvailability: details.passcodeAvailability,
          status: complete ? "ready" : "created_pending_details",
          lastError: undefined,
        }),
      );
    }
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microsoft 365への接続に失敗しました。";
    // 失敗しても transactionId と eventId は残す。次の試行は作成ではなく続きから再開する。
    await store.mutate(owner, (current) =>
      patched(current, { status: "failed", lastError: message }),
    );
    throw error;
  }
}

export interface WebMeetingView {
  requested: boolean;
  status: WebMeetingRecord["status"];
  revision: number;
  joinUrl?: string;
  meetingId?: string;
  passcode?: string;
  passcodeAvailability?: WebMeetingRecord["passcodeAvailability"];
  /** ユーザーがコピーする文字列。保証するのはここまで（貼り付け先の本文は検証できない）。 */
  copyText?: string;
  complete: boolean;
  /**
   * 保存済みの会議と、いま確定している日時・件名がずれている。再調整後にTeams側の
   * 予定を更新しないと、DeskNet'sだけ新しい日時になる。
   */
  scheduleChanged: boolean;
  notes: string[];
  /** 表示は常に「未登録」。DeskNet'sへの登録はユーザーが手動で行う。 */
  registered: false;
  error?: string;
}

export function describeWebMeeting(
  record: WebMeetingRecord | undefined,
  schedule?: WebMeetingSchedule,
): WebMeetingView {
  if (record === undefined) {
    return {
      requested: false, status: "not_requested", revision: 0,
      complete: false, scheduleChanged: false, notes: [], registered: false,
    };
  }
  const scheduleChanged =
    record.eventId !== undefined && schedule !== undefined && hasScheduleChanged(record, schedule);
  const base: WebMeetingView = {
    requested: record.requested,
    status: record.status,
    revision: record.revision,
    complete: false,
    scheduleChanged,
    notes: [],
    registered: false,
    ...(record.lastError === undefined ? {} : { error: record.lastError }),
  };
  if (record.joinUrl === undefined || record.passcodeAvailability === undefined) {
    return {
      ...base,
      notes: record.eventId === undefined
        ? base.notes
        : [
            // 会議は既に存在する。ユーザーが離脱しても勝手に消さないので、残存を伝える。
            "Teams会議は作成済みです。DeskNet'sへ登録しなくてもTeams側に残ります。同じ会議の再調整では作り直さず再利用します。",
          ],
    };
  }
  const details: WebMeetingDetails = {
    joinUrl: record.joinUrl,
    ...(record.meetingId === undefined ? {} : { meetingId: record.meetingId }),
    ...(record.passcode === undefined ? {} : { passcode: record.passcode }),
    passcodeAvailability: record.passcodeAvailability,
  };
  const completeness = describeWebMeetingCompleteness(details);
  return {
    ...base,
    joinUrl: record.joinUrl,
    ...(record.meetingId === undefined ? {} : { meetingId: record.meetingId }),
    ...(record.passcode === undefined ? {} : { passcode: record.passcode }),
    passcodeAvailability: record.passcodeAvailability,
    // The calendar event still has its old time until the explicit update succeeds.
    ...(scheduleChanged ? {} : {
      copyText: buildWebMeetingBlock(details).replace(`\n${WEB_MEETING_BLOCK_END}`, ""),
    }),
    complete: completeness.complete,
    notes: [
      ...(scheduleChanged
        ? [
            "日時または件名が変更されています。「Teams会議の日時を更新」を押すまで、Teams側の予定は以前のままです。",
          ]
        : []),
      ...completeness.notes,
      "DeskNet'sの「内容」欄の末尾に貼り付けてください。",
      "日時や会議を変更した場合は、古いWEB会議情報を削除してから貼り付けてください。",
      "Teams会議は作成済みです。DeskNet'sへ登録しなくてもTeams側に残ります。同じ会議の再調整では作り直さず再利用します。",
    ],
  };
}

/** `undefined` は「この項目を消す」を意味する。exactOptionalPropertyTypes のための明示。 */
function patched(
  current: WebMeetingRecord,
  patch: Partial<Record<keyof WebMeetingRecord, unknown>>,
): WebMeetingRecord {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as WebMeetingRecord;
}

function hasScheduleChanged(record: WebMeetingRecord, schedule: WebMeetingSchedule): boolean {
  return (
    record.start !== schedule.start ||
    record.end !== schedule.end ||
    (record.subject ?? "") !== schedule.subject
  );
}
