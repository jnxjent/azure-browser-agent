import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRun,
  analyzeDeskNetsIntent,
  filterFutureAvailability,
  validateCreateRunInput,
  type BookableAvailabilitySlot,
  type BrowserRun,
  type PendingBookingContext,
} from "@azure-browser-agent/agent-core";
import {
  DeskNetsBrowserWorker,
  MockBrowserWorker,
} from "@azure-browser-agent/browser-worker";

const runs = new Map<string, BrowserRun>();
const controllers = new Map<string, AbortController>();
interface PendingBookingConversation {
  context: PendingBookingContext;
  facilityId?: string;
  candidates?: BookableAvailabilitySlot[];
  selectedCandidateNumber?: number;
  selectedSlot?: BookableAvailabilitySlot;
  awaitingEmailChoice?: boolean;
}

const pendingBookings = new Map<string, PendingBookingConversation>();
const mockWorker = new MockBrowserWorker();
const deskNetsWorker = new DeskNetsBrowserWorker();
let deskNetsExecutionQueue: Promise<void> = Promise.resolve();

export const server = createServer(async (request, response) => {
  setCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = error instanceof TypeError ? 400 : 500;
    sendJson(response, status, { error: message });
  }
});

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (
    request.method === "POST" &&
    segments.length === 2 &&
    segments[0] === "browser-agent" &&
    segments[1] === "runs"
  ) {
    const validatedInput = validateCreateRunInput(await readJsonBody(request));
    let run = createRun(validatedInput);
    if (validatedInput.site === "desknets") {
      const analysis = await analyzeDeskNetsIntent(validatedInput.prompt);
      let task = analysis.task;
      run = { ...run, intentSource: analysis.source };
      const conversation = pendingBookings.get(validatedInput.threadId);
      if (task.type === "change_availability_duration") {
        const participantNames = conversation?.context.participantNames;
        const endDate = conversation?.context.endDate;
        if (conversation === undefined || participantNames === undefined || endDate === undefined) {
          throw new TypeError(
            "先に同じ会話で参加者と期間を指定して空き時間を確認してください。",
          );
        }
        task = {
          type: "find_availability",
          participantNames,
          date: conversation.context.date,
          endDate,
          durationMinutes: task.durationMinutes,
        };
      }
      if (task.type === "find_availability") {
        const today = currentJapanDate();
        if (task.endDate < today) {
          throw new TypeError(
            `${task.date}〜${task.endDate}は過去の期間です。本日以降を指定してください。`,
          );
        }
        task = { ...task, date: task.date < today ? today : task.date };
        const rangeDays = inclusiveDateRangeDays(task.date, task.endDate);
        if (rangeDays > 31) throw new TypeError("検索期間は31日以内で指定してください。");
      }
      if (task.type === "find_facility_availability") {
        if (conversation === undefined) {
          throw new TypeError(
            "先に同じ会話で参加者の空き時間を確認してください。",
          );
        }
        const facilityId = resolveConversationFacility(
          task.facilityQuery,
          conversation.context.availability,
        );
        const matchingCandidates = filterFutureAvailability(conversation.context.availability)
          .filter((slot) => slot.availableFacilityIds.includes(facilityId))
          .map((slot) => ({ ...slot, availableFacilityIds: [facilityId] }))
          .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
        if (matchingCandidates.length === 0) {
          throw new TypeError(`${facilityId}が空いている候補はありません。`);
        }
        const candidates = matchingCandidates.slice(0, 50);
        pendingBookings.set(validatedInput.threadId, {
          context: conversation.context,
          facilityId,
          candidates,
        });
        run = {
          ...run,
          input: { ...validatedInput, mode: "read" },
          task,
          status: "completed",
          updatedAt: new Date().toISOString(),
          result: {
            summary: `Found ${candidates.length} candidates for ${facilityId}.`,
            assistantMessage: formatNumberedFacilityCandidates(facilityId, candidates, matchingCandidates.length),
            evidence: [`Facility: ${facilityId}`, `Candidates shown: ${candidates.length} of ${matchingCandidates.length}`],
            availability: candidates,
          },
        };
        runs.set(run.id, run);
        sendJson(response, 202, run);
        return;
      }
      if (task.type === "select_booking_candidate") {
        const candidates = conversation?.candidates;
        const facilityId = conversation?.facilityId;
        if (conversation === undefined || candidates === undefined || facilityId === undefined) {
          throw new TypeError("先に設備の空いている候補を表示してください。");
        }
        const selectedSlot = candidates[task.candidateNumber - 1];
        if (selectedSlot === undefined) {
          throw new TypeError(`候補番号は1から${candidates.length}の範囲で指定してください。`);
        }
        assertSlotHasNotStarted(selectedSlot);
        pendingBookings.set(validatedInput.threadId, {
          ...conversation,
          selectedCandidateNumber: task.candidateNumber,
          selectedSlot,
          awaitingEmailChoice: true,
        });
        run = {
          ...run,
          input: { ...validatedInput, mode: "read" },
          task,
          status: "awaiting_user_input",
          updatedAt: new Date().toISOString(),
          result: {
            summary: `Selected candidate ${task.candidateNumber}; awaiting email choice.`,
            assistantMessage: `以下の内容でミーティングを確定してよいですか？\n日時: ${formatJapanSlot(selectedSlot)}\n参加者: ${selectedSlot.participantIds.join("、")}\n会議室: ${facilityId}\n出席者（本人を含む）へのメール送信の有無を選択してください。`,
            evidence: [`Selected candidate: ${task.candidateNumber}`],
            meetingProposal: {
              title: conversation.context.title ?? "",
              start: selectedSlot.start,
              end: selectedSlot.end,
              participantIds: selectedSlot.participantIds,
              facilityId,
            },
          },
        };
        runs.set(run.id, run);
        sendJson(response, 202, run);
        return;
      }
      if (task.type === "set_email_notification") {
        if (
          conversation?.awaitingEmailChoice !== true ||
          conversation.selectedSlot === undefined ||
          conversation.facilityId === undefined
        ) {
          throw new TypeError("メール送信の確認待ちではありません。");
        }
        assertSlotHasNotStarted(conversation.selectedSlot);
        run = {
          ...run,
          input: { ...validatedInput, mode: "write" },
          task: {
            type: "book_meeting",
            facilityQuery: conversation.facilityId,
            title: conversation.context.title ?? "",
            sendEmail: task.sendEmail,
            selectedStart: conversation.selectedSlot.start,
            selectedEnd: conversation.selectedSlot.end,
          },
          context: conversation.context,
        };
        pendingBookings.delete(validatedInput.threadId);
      } else if (task.type === "book_meeting") {
        if (conversation === undefined) {
          throw new TypeError(
            "先に同じ会話で参加者の空き時間を確認してください。",
          );
        }
        if (task.selectedStart === undefined || task.selectedEnd === undefined) {
          throw new TypeError(
            "直接予約する場合は、候補内の日付と開始・終了時刻を指定してください。",
          );
        }
        const facilityId = resolveConversationFacility(
          task.facilityQuery,
          conversation.context.availability,
        );
        const selectedSlot = conversation.context.availability.find(
          (slot) =>
            slot.start === task.selectedStart &&
            slot.end === task.selectedEnd &&
            slot.availableFacilityIds.includes(facilityId),
        );
        if (selectedSlot === undefined) {
          throw new TypeError(
            `指定した日時は${facilityId}を含む現在の${conversation.context.durationMinutes}分候補にありません。候補を確認するか、所要時間を変更して再検索してください。`,
          );
        }
        assertSlotHasNotStarted(selectedSlot);
        pendingBookings.delete(validatedInput.threadId);
        run = {
          ...run,
          input: { ...validatedInput, mode: "write" },
          task: {
            ...task,
            facilityQuery: facilityId,
            title: task.title || conversation.context.title || "",
          },
          context: conversation.context,
        };
      } else {
        run = {
          ...run,
          input: { ...validatedInput, mode: "read" },
          task,
        };
      }
    }
    runs.set(run.id, run);
    startRun(run.id);
    sendJson(response, 202, run);
    return;
  }

  if (
    segments.length >= 3 &&
    segments[0] === "browser-agent" &&
    segments[1] === "runs"
  ) {
    const runId = segments[2];
    if (runId === undefined) {
      sendJson(response, 404, { error: "Run not found." });
      return;
    }

    const run = runs.get(runId);
    if (run === undefined) {
      sendJson(response, 404, { error: "Run not found." });
      return;
    }

    if (
      request.method === "GET" &&
      segments.length === 5 &&
      segments[3] === "artifacts"
    ) {
      const filename = segments[4];
      if (filename !== "before.png" && filename !== "after.png") {
        sendJson(response, 404, { error: "Artifact not found." });
        return;
      }
      await sendArtifact(response, runId, filename);
      return;
    }

    if (request.method === "GET" && segments.length === 3) {
      sendJson(response, 200, run);
      return;
    }

    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[3] === "cancel"
    ) {
      cancelRun(run);
      sendJson(response, 200, runs.get(run.id));
      return;
    }

    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[3] === "approve"
    ) {
      if (run.status !== "awaiting_approval" || run.result?.approvalRequest === undefined) {
        sendJson(response, 409, {
          error: "This run is not waiting for final booking approval.",
        });
        return;
      }
      if (Date.parse(run.result.approvalRequest.start) < Date.now()) {
        sendJson(response, 409, {
          error: "選択した開始時刻を過ぎたため確定できません。空き時間を再検索してください。",
        });
        return;
      }
      const approved: BrowserRun = {
        ...run,
        status: "queued",
        updatedAt: new Date().toISOString(),
        approval: {
          requestedAt: run.approval?.requestedAt ?? run.updatedAt,
          approvedAt: new Date().toISOString(),
        },
      };
      runs.set(run.id, approved);
      startRun(run.id);
      sendJson(response, 202, runs.get(run.id));
      return;
    }
  }

  sendJson(response, 404, { error: "Route not found." });
}

function startRun(runId: string): void {
  const run = runs.get(runId);
  if (run === undefined) return;
  if (run.input.site === "desknets") {
    deskNetsExecutionQueue = deskNetsExecutionQueue.then(
      () => executeRun(runId),
      () => executeRun(runId),
    );
  } else {
    void executeRun(runId);
  }
}

async function executeRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (run === undefined || run.status === "cancelled") return;
  const controller = new AbortController();
  controllers.set(runId, controller);
  const running: BrowserRun = {
    ...run,
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  runs.set(runId, running);

  const worker =
    running.input.site === "desknets" ? deskNetsWorker : mockWorker;
  try {
    const completed = await worker.execute(running, controller.signal);
    runs.set(runId, completed);
    const pending = completed.result?.pendingBooking;
    if (pending !== undefined) {
      pendingBookings.set(completed.input.threadId, { context: pending });
    }
  } catch (error: unknown) {
    const current = runs.get(runId);
    if (current?.status === "cancelled") return;
    const message = error instanceof Error ? error.message : "Unknown error";
    if (current !== undefined) {
      runs.set(runId, {
        ...current,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: message,
      });
    }
  } finally {
    controllers.delete(runId);
  }
}

function cancelRun(run: BrowserRun): void {
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    return;
  }
  controllers.get(run.id)?.abort(new Error("Run cancelled by user."));
  runs.set(run.id, {
    ...run,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new TypeError("Request body exceeds 64 KiB.");
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body === "") {
    throw new TypeError("Request body is required.");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TypeError("Request body must be valid JSON.");
  }
}

function setCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const origin = request.headers.origin;
  const allowedOrigins = new Set([
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ]);
  if (origin !== undefined && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function sendArtifact(
  response: ServerResponse,
  runId: string,
  filename: "before.png" | "after.png",
): Promise<void> {
  const artifactPath = resolve(process.cwd(), "screenshots", runId, filename);
  try {
    const image = await readFile(artifactPath);
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": image.byteLength,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(image);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      sendJson(response, 404, { error: "Artifact not found." });
      return;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined) {
  const entryUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entryUrl) {
    const port = parsePort(process.env.AGENT_API_PORT, 3001);
    server.listen(port, "127.0.0.1", () => {
      console.log(`Agent API listening on http://127.0.0.1:${port}`);
    });
  }
}

function resolveConversationFacility(
  query: string,
  availability: BookableAvailabilitySlot[],
): string {
  const normalizedQuery = normalizeFacilityName(query);
  const facilityIds = new Set(
    availability.flatMap((slot) => slot.availableFacilityIds),
  );
  const matches = Array.from(facilityIds).filter((facilityId) =>
    normalizeFacilityName(facilityId).includes(normalizedQuery),
  );
  if (matches.length === 0) {
    throw new TypeError(`設備が見つからないか、空きがありません: ${query}`);
  }
  if (matches.length > 1) {
    throw new TypeError(`設備名が曖昧です: ${matches.join("、")}`);
  }
  return matches[0] as string;
}

function normalizeFacilityName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

function formatNumberedFacilityCandidates(
  facilityId: string,
  candidates: BookableAvailabilitySlot[],
  totalCandidates: number = candidates.length,
): string {
  const lines = candidates.map(
    (candidate, index) => `${index + 1}. ${formatJapanSlot(candidate)}`,
  );
  const scope = totalCandidates > candidates.length
    ? `${totalCandidates}件中、早い順に先頭${candidates.length}件です。`
    : "時間の早い順に以下です。";
  return `${facilityId}が空いている候補は${scope}\n${lines.join("\n")}\n候補をクリックするか、番号で選んでください。`;
}

function formatJapanSlot(slot: { start: string; end: string }): string {
  const date = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
  }).format(new Date(slot.start));
  const time = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} ${time.format(new Date(slot.start))}〜${time.format(new Date(slot.end))}`;
}

function currentJapanDate(now: Date = new Date()): string {
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
    throw new Error("Unable to determine the current date in Japan.");
  }
  return `${year}-${month}-${day}`;
}

function assertSlotHasNotStarted(slot: { start: string }): void {
  if (Date.parse(slot.start) < Date.now()) {
    throw new TypeError(
      "選択した開始時刻を過ぎました。設備の空き時間を再検索してください。",
    );
  }
}

function inclusiveDateRangeDays(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new TypeError("有効な検索期間を指定してください。");
  }
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}
