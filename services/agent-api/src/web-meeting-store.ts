import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PasscodeAvailability } from "@azure-browser-agent/agent-core";

/**
 * WEB会議の条件と発行結果の永続化。
 *
 * 会話状態（`pendingBookings`）はプロセス内の `Map` なので、会議情報を同じ場所に置くと
 * API再起動後に同じ会議を二重発行する。イベントIDは作成前には分からないため、
 * **作成要求を出す前に `transactionId` を保存**し、応答が返ってからイベントIDを保存する。
 * 応答が失われても、次の試行は同じ `transactionId` を送るので会議は増えない。
 */

export type WebMeetingStatus =
  | "not_requested"
  | "requested"
  | "creating"
  | "created_pending_details"
  | "ready"
  | "failed";

export interface WebMeetingOwner {
  userId: string;
  threadId: string;
}

export interface WebMeetingRecord {
  userId: string;
  threadId: string;
  /** 「WEB希望」は条件として保持するだけ。これだけでは会議を作らない。 */
  requested: boolean;
  status: WebMeetingStatus;
  /** 発行前は0。発行で1になり、日時・件名の変更ごとに増える。古いカードの判定に使う。 */
  revision: number;
  transactionId?: string;
  eventId?: string;
  joinUrl?: string;
  meetingId?: string;
  passcode?: string;
  passcodeAvailability?: PasscodeAvailability;
  subject?: string;
  start?: string;
  end?: string;
  lastError?: string;
  updatedAt: string;
}

type StoredRecord = Omit<WebMeetingRecord, "userId" | "threadId">;

interface StoredWebMeetings {
  version: 1;
  users: Record<string, Record<string, StoredRecord>>;
}

const STATUSES: readonly WebMeetingStatus[] = [
  "not_requested",
  "requested",
  "creating",
  "created_pending_details",
  "ready",
  "failed",
];

export class WebMeetingStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(owner: WebMeetingOwner): Promise<WebMeetingRecord | undefined> {
    const userId = readIdentifier(owner.userId, "userId");
    const threadId = readIdentifier(owner.threadId, "threadId");
    const stored = await this.read();
    const record = stored.users[userId]?.[threadId];
    return record === undefined ? undefined : { userId, threadId, ...record };
  }

  /**
   * 読み取りと書き込みを直列化した上での更新。発行処理はこれ以外でレコードを書かない。
   * `updater` が undefined を返した場合は何も書かない。
   */
  async mutate(
    owner: WebMeetingOwner,
    updater: (current: WebMeetingRecord) => WebMeetingRecord | undefined,
  ): Promise<WebMeetingRecord> {
    const userId = readIdentifier(owner.userId, "userId");
    const threadId = readIdentifier(owner.threadId, "threadId");
    let result: WebMeetingRecord | undefined;
    await this.enqueue(async () => {
      const stored = await this.read();
      const existing = stored.users[userId]?.[threadId];
      const current: WebMeetingRecord = existing === undefined
        ? {
            userId,
            threadId,
            requested: false,
            status: "not_requested",
            revision: 0,
            updatedAt: new Date().toISOString(),
          }
        : { userId, threadId, ...existing };
      const updated = updater(current);
      if (updated === undefined) {
        result = current;
        return;
      }
      result = validateRecord({ ...updated, userId, threadId, updatedAt: new Date().toISOString() });
      const { userId: _userId, threadId: _threadId, ...record } = result;
      stored.users[userId] = { ...stored.users[userId], [threadId]: record };
      await this.write(stored);
    });
    return result as WebMeetingRecord;
  }

  /**
   * WEB希望の条件だけを更新する。既に発行済みの会議情報は消さない。
   * 「WEB不要」と言われても、既に作成済みの予定を勝手に削除はしない（残存は表示で伝える）。
   */
  async setRequested(owner: WebMeetingOwner, requested: boolean): Promise<WebMeetingRecord> {
    return this.mutate(owner, (current) =>
      current.requested === requested && current.status !== "not_requested"
        ? undefined
        : {
            ...current,
            requested,
            status: current.eventId === undefined
              ? requested
                ? "requested"
                : "not_requested"
              : current.status,
          },
    );
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.updateQueue.then(operation, operation);
    this.updateQueue = pending.catch(() => undefined);
    await pending;
  }

  private async read(): Promise<StoredWebMeetings> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.users)) {
        throw new Error("Web meeting file has an invalid structure.");
      }
      const users: StoredWebMeetings["users"] = {};
      for (const [userId, threads] of Object.entries(parsed.users)) {
        if (!isRecord(threads)) throw new Error("Web meeting file has an invalid user entry.");
        const normalizedUserId = readIdentifier(userId, "userId");
        const normalizedThreads: Record<string, StoredRecord> = {};
        for (const [threadId, value] of Object.entries(threads)) {
          const normalizedThreadId = readIdentifier(threadId, "threadId");
          const record = validateRecord({
            userId: normalizedUserId,
            threadId: normalizedThreadId,
            ...(isRecord(value) ? value : {}),
          } as unknown as WebMeetingRecord);
          const { userId: _userId, threadId: _threadId, ...rest } = record;
          normalizedThreads[normalizedThreadId] = rest;
        }
        users[normalizedUserId] = normalizedThreads;
      }
      return { version: 1, users };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, users: {} };
      }
      throw error;
    }
  }

  private async write(stored: StoredWebMeetings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function validateRecord(record: WebMeetingRecord): WebMeetingRecord {
  if (typeof record.requested !== "boolean") {
    throw new TypeError("A web meeting record must record whether a web meeting was requested.");
  }
  if (!STATUSES.includes(record.status)) {
    throw new TypeError("A web meeting record has an unknown status.");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new TypeError("A web meeting revision must be a non-negative integer.");
  }
  // 会議IDが無いのにパスコードだけある状態や、不要なのに値がある状態を保存しない。
  if (record.passcode !== undefined && record.passcodeAvailability !== "required") {
    throw new TypeError("A stored passcode must be marked as required.");
  }
  const optional: Array<keyof WebMeetingRecord> = [
    "transactionId",
    "eventId",
    "joinUrl",
    "meetingId",
    "passcode",
    "subject",
    "start",
    "end",
    "lastError",
  ];
  for (const key of optional) {
    const value = record[key];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new TypeError(`A web meeting ${String(key)} must be a non-empty string when present.`);
    }
  }
  if (
    record.passcodeAvailability !== undefined &&
    !["required", "not_required", "unavailable"].includes(record.passcodeAvailability)
  ) {
    throw new TypeError("A web meeting record has an unknown passcode availability.");
  }
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new TypeError("A web meeting record must carry a valid updatedAt timestamp.");
  }
  return record;
}

function readIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const identifier = value.normalize("NFKC").trim();
  if (identifier === "" || identifier.length > 200 || /[\r\n\t]/.test(identifier)) {
    throw new TypeError(`${field} must be a non-empty single-line string.`);
  }
  return identifier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
