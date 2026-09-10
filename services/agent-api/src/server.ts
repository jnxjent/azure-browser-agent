import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRun,
  analyzeDeskNetsIntent,
  filterFutureAvailability,
  parseDeskNetsTask,
  validateCreateRunInput,
  ORGANIZATION_SUFFIX,
  type BookableAvailabilitySlot,
  type BrowserRun,
  type CreateRunInput,
  type DeskNetsTask,
  type PendingBookingContext,
  type PendingParticipantChoice,
} from "@azure-browser-agent/agent-core";
import {
  DeskNetsBrowserWorker,
  MockBrowserWorker,
  formatAvailabilityMessage,
  isMeetingRoomFacilityName,
} from "@azure-browser-agent/browser-worker";
import {
  facilityChangeFromStructuredCommand,
  mergeFacilityChangeRequests,
  parseExplicitFacilityQuery,
  parseFacilityChangeRequest,
  type FacilityChangeRequest,
} from "./facility-change.js";
import { ParticipantAliasStore } from "./participant-alias-store.js";
import { readStructuredCommandOrUndefined } from "./structured-command.js";

const runs = new Map<string, BrowserRun>();
const controllers = new Map<string, AbortController>();
interface PendingFacilityChoice {
  selectedStart: string;
  selectedEnd: string;
  title: string;
  sendEmail: boolean;
  facilityScope?: string;
}

export interface PendingBookingConversation {
  context: PendingBookingContext;
  facilityId?: string;
  candidates?: BookableAvailabilitySlot[];
  selectedCandidateNumber?: number;
  selectedSlot?: BookableAvailabilitySlot;
  awaitingEmailChoice?: boolean;
  awaitingFacilityChoice?: PendingFacilityChoice;
}

const pendingBookings = new Map<string, PendingBookingConversation>();
// Separate from pendingBookings because this state exists BEFORE any search
// has actually succeeded (there's no PendingBookingContext yet to attach it
// to — no availability, no participantIds).
const pendingParticipantChoices = new Map<string, PendingParticipantChoice>();
const participantAliasStore = new ParticipantAliasStore(
  resolve(
    process.cwd(),
    process.env.DESKNETS_PARTICIPANT_ALIASES_PATH ??
      ".data/desknets-participant-aliases.json",
  ),
);

// Clears the one-shot "awaiting a specific reply" markers after they've been
// consumed, while keeping the reusable data (context.availability,
// candidates, facilityId) so show_candidates can still re-display it if the
// user changes their mind before manually confirming in DeskNet's.
function clearTransientConversationFlags(
  conversation: PendingBookingConversation,
): PendingBookingConversation {
  const {
    awaitingEmailChoice: _awaitingEmailChoice,
    awaitingFacilityChoice: _awaitingFacilityChoice,
    selectedSlot: _selectedSlot,
    selectedCandidateNumber: _selectedCandidateNumber,
    ...rest
  } = conversation;
  return rest;
}

// Uses the deterministic parser directly (not the full analyzeDeskNetsIntent,
// which may call Azure OpenAI) purely as a lightweight routing guard: it only
// needs to know whether this specific reply is a "show_candidates" request,
// not to fully resolve it. A prompt that doesn't parse (e.g. a genuine
// facility name like "有玉") is not a show_candidates request either.
export function isShowCandidatesRequest(prompt: string): boolean {
  try {
    return parseDeskNetsTask(prompt).type === "show_candidates";
  } catch {
    return false;
  }
}
const mockWorker = new MockBrowserWorker();
const deskNetsWorker = new DeskNetsBrowserWorker();
let deskNetsExecutionQueue: Promise<void> = Promise.resolve();

export const server = createServer(async (request, response) => {
  setCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (
    requestUrl.pathname !== "/health" &&
    !isAuthorizedRequest(request.headers.authorization)
  ) {
    response.setHeader("WWW-Authenticate", "Bearer");
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 401, { error: "Unauthorized." });
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

export function isAuthorizedRequest(
  authorizationHeader: string | string[] | undefined,
  configuredApiKey = process.env.AGENT_API_KEY,
): boolean {
  const expectedApiKey = configuredApiKey?.trim();
  if (!expectedApiKey) return true;
  if (typeof authorizationHeader !== "string") return false;

  const match = /^Bearer[\t ]+([^\s]+)$/i.exec(authorizationHeader);
  if (!match) return false;

  const suppliedDigest = createHash("sha256").update(match[1] as string).digest();
  const expectedDigest = createHash("sha256").update(expectedApiKey).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

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
    request.method === "GET" &&
    segments.length === 2 &&
    segments[0] === "browser-agent" &&
    segments[1] === "participant-aliases"
  ) {
    sendJson(response, 200, { aliases: await participantAliasStore.list() });
    return;
  }

  if (
    request.method === "POST" &&
    segments.length === 2 &&
    segments[0] === "browser-agent" &&
    segments[1] === "participant-aliases"
  ) {
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new TypeError("Request body must be a JSON object.");
    const entry = await participantAliasStore.upsert(body.alias, body.formalName);
    sendJson(response, 200, { alias: entry });
    return;
  }

  if (
    request.method === "DELETE" &&
    segments.length === 3 &&
    segments[0] === "browser-agent" &&
    segments[1] === "participant-aliases"
  ) {
    const alias = decodeURIComponent(segments[2] as string);
    const removed = await participantAliasStore.remove(alias);
    if (!removed) {
      sendJson(response, 404, { error: "呼称が登録されていません。" });
      return;
    }
    sendJson(response, 200, { removed: true });
    return;
  }

  if (
    request.method === "POST" &&
    segments.length === 2 &&
    segments[0] === "browser-agent" &&
    segments[1] === "runs"
  ) {
    const requestBody = await readJsonBody(request);
    const structuredCommand = readStructuredCommandOrUndefined(
      requestBody,
      (error) => console.warn(
        "[DeskNetsAgent] Ignoring invalid structuredCommand; using raw prompt.",
        error instanceof Error ? error.message : String(error),
      ),
    );
    const submittedInput = validateCreateRunInput(requestBody);
    const validatedInput = submittedInput.site === "desknets"
      ? {
          ...submittedInput,
          prompt: await participantAliasStore.replaceAliases(submittedInput.prompt),
        }
      : submittedInput;
    const pendingApproval = validatedInput.site === "desknets"
      ? findPendingApproval(validatedInput.userId, validatedInput.threadId)
      : undefined;
    const durationChange = pendingApproval === undefined
      ? undefined
      : readRequestedDurationChange(structuredCommand, validatedInput.prompt);
    if (
      pendingApproval !== undefined &&
      durationChange !== undefined &&
      pendingApproval.task?.type === "book_meeting" &&
      pendingApproval.context !== undefined &&
      pendingApproval.result?.approvalRequest !== undefined
    ) {
      const approval = pendingApproval.result.approvalRequest;
      const resizedAvailability = resizeBookableAvailability(
        getCompanyWideAvailability(pendingApproval.context),
        durationChange,
      );
      const resizedSlot = resizedAvailability.find(
        (candidate) =>
          candidate.start === approval.start &&
          candidate.availableFacilityIds.includes(approval.facilityId),
      );
      if (resizedSlot === undefined) {
        throw new TypeError(
          `${formatJapanInstant(approval.start)}開始で${durationChange}分間、参加者全員と${approval.facilityId}が空いていません。別の時間または会議室を指定してください。`,
        );
      }
      const resizedContext: PendingBookingContext = {
        ...pendingApproval.context,
        durationMinutes: durationChange,
        availability: resizedAvailability,
        allFacilityAvailability: resizedAvailability,
      };
      cancelSupersededApprovals(validatedInput.userId, validatedInput.threadId);
      pendingBookings.set(validatedInput.threadId, {
        context: resizedContext,
        facilityId: approval.facilityId,
      });
      const changedRun: BrowserRun = {
        ...createRun({ ...validatedInput, mode: "write" }),
        intentSource: structuredCommand?.action === "change_duration"
          ? "azure_openai"
          : "deterministic",
        task: {
          ...pendingApproval.task,
          facilityQuery: approval.facilityId,
          title: approval.title,
          sendEmail: approval.emailNotificationWillBeSent,
          selectedStart: resizedSlot.start,
          selectedEnd: resizedSlot.end,
        },
        context: resizedContext,
      };
      runs.set(changedRun.id, changedRun);
      startRun(changedRun.id);
      sendJson(response, 202, changedRun);
      return;
    }
    const facilityChange = pendingApproval === undefined
      ? undefined
      : mergeFacilityChangeRequests(
          facilityChangeFromStructuredCommand(structuredCommand),
          parseFacilityChangeRequest(validatedInput.prompt),
        );
    if (
      pendingApproval !== undefined &&
      facilityChange !== undefined &&
      pendingApproval.task?.type === "book_meeting" &&
      pendingApproval.context !== undefined &&
      pendingApproval.result?.approvalRequest !== undefined
    ) {
      const approval = pendingApproval.result.approvalRequest;
      const approvalAvailability = getCompanyWideAvailability(pendingApproval.context);
      const slot = approvalAvailability.find(
        (candidate) =>
          candidate.start === approval.start && candidate.end === approval.end,
      );
      if (slot === undefined) {
        throw new TypeError("変更対象の日時候補が失われました。空き時間を再検索してください。");
      }
      let facilityId: string;
      try {
        facilityId = resolveAutomaticFacilityForSlot(
          facilityChange.preferredQuery,
          slot,
          pendingApproval.context.userOrganization,
          pendingApproval.context.userDisplayName,
        );
      } catch (error) {
        if (facilityChange.fallbackQuery === undefined) throw error;
        const fallbackSlot = restrictSlotToFacilityType(
          slot,
          facilityChange.fallbackType,
        );
        facilityId = resolveAutomaticFacilityForSlot(
          facilityChange.fallbackQuery,
          fallbackSlot,
          pendingApproval.context.userOrganization,
          pendingApproval.context.userDisplayName,
        );
      }
      cancelSupersededApprovals(validatedInput.userId, validatedInput.threadId);
      const changedRun: BrowserRun = {
        ...createRun({ ...validatedInput, mode: "write" }),
        intentSource: "deterministic",
        task: {
          ...pendingApproval.task,
          facilityQuery: facilityId,
          title: approval.title,
          sendEmail: approval.emailNotificationWillBeSent,
          selectedStart: approval.start,
          selectedEnd: approval.end,
        },
        context: {
          ...pendingApproval.context,
          availability: approvalAvailability,
        },
      };
      runs.set(changedRun.id, changedRun);
      startRun(changedRun.id);
      sendJson(response, 202, changedRun);
      return;
    }
    if (validatedInput.site === "desknets") {
      cancelSupersededApprovals(validatedInput.userId, validatedInput.threadId);
    }
    let run = createRun(validatedInput);
    if (validatedInput.site === "desknets") {
      const awaitingConversation = pendingBookings.get(validatedInput.threadId);
      if (
        awaitingConversation?.awaitingFacilityChoice !== undefined &&
        !isShowCandidatesRequest(validatedInput.prompt)
      ) {
        // A "候補に戻して"-style reply must escape the facility-choice
        // question rather than being swallowed as an (invalid) facility
        // name — otherwise there would be no way to back out once asked.
        handleFacilityChoiceReply(
          run,
          validatedInput,
          awaitingConversation,
          awaitingConversation.awaitingFacilityChoice,
          response,
        );
        return;
      }
      const awaitingParticipantChoice = pendingParticipantChoices.get(validatedInput.threadId);
      if (awaitingParticipantChoice !== undefined) {
        if (isFreshAvailabilityRequest(validatedInput.prompt)) {
          // A complete new availability request supersedes the unresolved
          // organization question. Drop only that question and let the new
          // prompt continue through the normal intent-analysis path below.
          pendingParticipantChoices.delete(validatedInput.threadId);
        } else if (isParticipantChoiceCancellationRequest(validatedInput.prompt)) {
          pendingParticipantChoices.delete(validatedInput.threadId);
          const cancelledChoice: BrowserRun = {
            ...run,
            input: { ...validatedInput, mode: "read" },
            status: "completed",
            updatedAt: new Date().toISOString(),
            result: {
              summary: "Cancelled the pending participant organization choice.",
              assistantMessage: "参加者の組織選択をキャンセルしました。",
              evidence: [],
            },
          };
          runs.set(cancelledChoice.id, cancelledChoice);
          sendJson(response, 202, cancelledChoice);
          return;
        } else {
          handleParticipantChoiceReply(run, validatedInput, awaitingParticipantChoice, response);
          return;
        }
      }
      const conversation = pendingBookings.get(validatedInput.threadId);
      const requestedFacilityQuery =
        structuredCommand?.facility.preferred ??
        parseExplicitFacilityQuery(validatedInput.prompt);
      const selectionContext = conversation === undefined
        ? undefined
        : {
            ...conversation.context,
            availability: requestedFacilityQuery === undefined
              ? conversation.context.availability
              : getCompanyWideAvailability(conversation.context),
          };
      const selectedSlot = selectionContext === undefined
        ? undefined
        : resolveTimeOnlySelection(validatedInput.prompt, selectionContext);
      const selectedFacilityQuery =
        requestedFacilityQuery ?? conversation?.context.facilityQuery;
      const analysis = selectedSlot === undefined
        ? await analyzeDeskNetsIntent(validatedInput.prompt)
        : {
            source: "deterministic" as const,
            task: {
              type: "book_meeting" as const,
              ...(selectedFacilityQuery === undefined
                ? {}
                : { facilityQuery: selectedFacilityQuery }),
              title: conversation?.context.title?.trim() || "打ち合わせ",
              sendEmail: false,
              selectedStart: selectedSlot.start,
              selectedEnd: selectedSlot.end,
            },
          };
      let task = analysis.task;
      run = { ...run, intentSource: analysis.source };
      if (task.type === "change_availability_duration") {
        const participants = conversation?.context.participants;
        const endDate = conversation?.context.endDate;
        if (conversation === undefined || participants === undefined || endDate === undefined) {
          throw new TypeError(
            "先に同じ会話で参加者と期間を指定して空き時間を確認してください。",
          );
        }
        task = {
          type: "find_availability",
          participants,
          date: conversation.context.date,
          endDate,
          durationMinutes: task.durationMinutes,
          ...(conversation.context.facilityQuery === undefined
            ? {}
            : { facilityQuery: conversation.context.facilityQuery }),
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
        const facilityAvailability = getCompanyWideAvailability(conversation.context);
        const facilityId = resolveConversationFacility(
          task.facilityQuery,
          facilityAvailability,
        );
        const matchingCandidates = filterFutureAvailability(facilityAvailability)
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
      if (task.type === "show_candidates") {
        if (conversation === undefined) {
          throw new TypeError(
            "先に同じ会話で参加者の空き時間を確認してください。",
          );
        }
        const redisplay = buildShowCandidatesResponse(conversation);
        pendingBookings.set(validatedInput.threadId, clearTransientConversationFlags(conversation));
        run = {
          ...run,
          input: { ...validatedInput, mode: "read" },
          task: redisplay.task,
          status: "completed",
          updatedAt: new Date().toISOString(),
          result: redisplay.result,
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
        // Deliberately not deleted: if the user changes their mind before
        // manually clicking DeskNet's own "追加", show_candidates needs the
        // conversation's availability data to still be here.
        pendingBookings.set(validatedInput.threadId, clearTransientConversationFlags(conversation));
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
        const bookingAvailability = getCompanyWideAvailability(conversation.context);
        const slot = bookingAvailability.find(
          (candidate) => candidate.start === task.selectedStart && candidate.end === task.selectedEnd,
        );
        if (slot === undefined || slot.availableFacilityIds.length === 0) {
          throw new TypeError(
            `指定した日時は現在の${conversation.context.durationMinutes}分候補にありません。候補を確認するか、所要時間を変更して再検索してください。`,
          );
        }
        const resolvedTitle = task.title || conversation.context.title || "";
        let facilityId: string;
        try {
          facilityId = task.facilityQuery === undefined
            ? resolveFacilityWithPreference(
                undefined,
                [slot],
                conversation.context.userOrganization,
                conversation.context.userDisplayName,
                task.selectedStart,
                task.selectedEnd,
              )
            : resolveAutomaticFacilityForSlot(
                task.facilityQuery,
                slot,
                conversation.context.userOrganization,
                conversation.context.userDisplayName,
              );
        } catch {
          // Could not resolve a single facility automatically (no matching
          // preference, an ambiguous match, or an explicitly named room
          // that isn't free at this time) — ask instead of failing the run.
          const facilityScope = task.facilityQuery === undefined
            ? undefined
            : inferFacilityScope(task.facilityQuery);
          pendingBookings.set(validatedInput.threadId, {
            ...conversation,
            awaitingFacilityChoice: {
              selectedStart: task.selectedStart,
              selectedEnd: task.selectedEnd,
              title: resolvedTitle,
              sendEmail: task.sendEmail,
              ...(facilityScope === undefined
                ? {}
                : { facilityScope }),
            },
          });
          run = {
            ...run,
            input: { ...validatedInput, mode: "read" },
            task,
            status: "awaiting_user_input",
            updatedAt: new Date().toISOString(),
            result: {
              summary: "Facility could not be resolved automatically; asking the user to choose.",
              assistantMessage: task.facilityQuery === undefined
                ? formatFacilityChoiceMessage(slot.availableFacilityIds)
                : formatUnavailableFacilityChoiceMessage(
                    task.facilityQuery,
                    slot.availableFacilityIds,
                  ),
              evidence: [`Candidates: ${slot.availableFacilityIds.join("、")}`],
            },
          };
          runs.set(run.id, run);
          sendJson(response, 202, run);
          return;
        }
        assertSlotHasNotStarted(slot);
        // Deliberately not deleted here either — see the comment above.
        pendingBookings.set(validatedInput.threadId, clearTransientConversationFlags(conversation));
        run = {
          ...run,
          input: { ...validatedInput, mode: "write" },
          task: {
            ...task,
            facilityQuery: facilityId,
            title: resolvedTitle,
          },
          context: {
            ...conversation.context,
            availability: bookingAvailability,
          },
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
    if (!isRunOwnerRequest(request, run)) {
      sendJson(response, 403, {
        error: "This run does not belong to the current user or chat thread.",
      });
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
      if (run.task?.type !== "book_meeting" || run.context === undefined) {
        sendJson(response, 409, { error: "The booking proposal is incomplete." });
        return;
      }
      const approvalBody = await readJsonBody(request);
      if (!isRecord(approvalBody) || typeof approvalBody.title !== "string") {
        throw new TypeError("title must be a string.");
      }
      const approvedTitle = approvalBody.title.normalize("NFKC").trim();
      if (approvedTitle.length < 1 || approvedTitle.length > 100 || /[\r\n\t]/.test(approvedTitle)) {
        throw new TypeError("title must contain between 1 and 100 characters on one line.");
      }
      const approvalRequestedAt = Date.parse(run.approval?.requestedAt ?? run.updatedAt);
      if (!Number.isFinite(approvalRequestedAt) || Date.now() - approvalRequestedAt > 15 * 60_000) {
        sendJson(response, 409, {
          error: "確認の有効期限が切れました。空き時間を再検索してください。",
        });
        return;
      }
      const approved: BrowserRun = {
        ...run,
        task: { ...run.task, title: approvedTitle },
        result: {
          ...run.result,
          approvalRequest: { ...run.result.approvalRequest, title: approvedTitle },
        },
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

export function restrictSlotToFacilityType(
  slot: BookableAvailabilitySlot,
  fallbackType: FacilityChangeRequest["fallbackType"],
): BookableAvailabilitySlot {
  if (fallbackType === undefined || fallbackType === "any") return slot;
  const availableFacilityIds = slot.availableFacilityIds.filter((facilityId) =>
    fallbackType === "reception_room"
      ? facilityId.normalize("NFKC").includes("応接室")
      : isMeetingRoomFacilityName(facilityId) &&
        !facilityId.normalize("NFKC").includes("応接室"),
  );
  if (availableFacilityIds.length === 0) {
    throw new TypeError(
      fallbackType === "reception_room"
        ? "指定した日時に空いている応接室がありません。"
        : "指定した日時に空いている会議室がありません。",
    );
  }
  return { ...slot, availableFacilityIds };
}

export function getCompanyWideAvailability(
  context: PendingBookingContext,
): BookableAvailabilitySlot[] {
  return context.allFacilityAvailability ?? context.availability;
}

export function resizeBookableAvailability(
  availability: BookableAvailabilitySlot[],
  durationMinutes: number,
): BookableAvailabilitySlot[] {
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 480) {
    throw new TypeError("会議時間は30分から480分の範囲で指定してください。");
  }
  const starts = Array.from(new Set(availability.map((slot) => slot.start)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const facilityIds = Array.from(new Set(
    availability.flatMap((slot) => slot.availableFacilityIds),
  ));
  return starts.flatMap((start) => {
    const startMs = Date.parse(start);
    const endMs = startMs + durationMinutes * 60_000;
    const availableFacilityIds = facilityIds.filter((facilityId) =>
      isIntervalCoveredByFacility(availability, facilityId, startMs, endMs),
    );
    if (availableFacilityIds.length === 0) return [];
    const base = availability.find((slot) => slot.start === start);
    if (base === undefined) return [];
    return [{
      ...base,
      end: new Date(endMs).toISOString(),
      durationMinutes,
      availableFacilityIds,
    }];
  });
}

function isIntervalCoveredByFacility(
  availability: BookableAvailabilitySlot[],
  facilityId: string,
  startMs: number,
  endMs: number,
): boolean {
  let coveredUntil = startMs;
  const candidates = availability
    .filter((slot) => slot.availableFacilityIds.includes(facilityId))
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  while (coveredUntil < endMs) {
    const covering = candidates.filter(
      (slot) => Date.parse(slot.start) <= coveredUntil && Date.parse(slot.end) > coveredUntil,
    );
    if (covering.length === 0) return false;
    coveredUntil = Math.max(...covering.map((slot) => Date.parse(slot.end)));
  }
  return true;
}

export function readRequestedDurationChange(
  structuredCommand: ReturnType<typeof readStructuredCommandOrUndefined>,
  prompt: string,
): number | undefined {
  if (
    structuredCommand?.action === "change_duration" &&
    structuredCommand.durationMinutes !== null
  ) {
    return structuredCommand.durationMinutes;
  }
  try {
    const parsed = parseDeskNetsTask(prompt);
    return parsed.type === "change_availability_duration"
      ? parsed.durationMinutes
      : undefined;
  } catch {
    return undefined;
  }
}

function formatJapanInstant(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function isRunOwnerRequest(
  request: Pick<IncomingMessage, "headers">,
  run: Pick<BrowserRun, "input">,
  configuredApiKey = process.env.AGENT_API_KEY,
): boolean {
  if (!configuredApiKey?.trim()) return true;
  const userId = request.headers["x-user-id"];
  const threadId = request.headers["x-chat-thread-id"];
  return typeof userId === "string" &&
    typeof threadId === "string" &&
    userId === run.input.userId &&
    threadId === run.input.threadId;
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

function cancelSupersededApprovals(userId: string, threadId: string): void {
  for (const [runId, run] of runs) {
    if (
      run.status === "awaiting_approval" &&
      run.input.userId === userId &&
      run.input.threadId === threadId
    ) {
      runs.set(runId, {
        ...run,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
        result: {
          summary: "Cancelled because a newer DeskNet's request superseded this approval.",
          assistantMessage: "新しい依頼が送信されたため、この確認は無効になりました。",
          evidence: run.result?.evidence ?? [],
        },
      });
    }
  }
}

function findPendingApproval(
  userId: string,
  threadId: string,
): BrowserRun | undefined {
  return Array.from(runs.values())
    .filter(
      (run) =>
        run.status === "awaiting_approval" &&
        run.input.userId === userId &&
        run.input.threadId === threadId,
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
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
    const participantChoice = completed.result?.participantChoice;
    if (participantChoice !== undefined) {
      pendingParticipantChoices.set(completed.input.threadId, participantChoice);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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

// Default meeting-room preference by DeskNet's "代表組織" (primary
// department, shown on each user's own DeskNet's profile page), tried in
// order when the request does not name a facility explicitly. An explicit
// facility mention in the request always takes priority over this table.
// Overridable at deploy time via the FACILITY_PREFERENCE_BY_ORGANIZATION
// environment variable (JSON object of organization name -> ordered array
// of facility name substrings), so operations can add/adjust organizations
// without a code change and rebuild. These defaults are the mappings
// confirmed so far: 経営企画部 -> アクト系(ルームC優先), 営業統括部 -> 有玉.
const DEFAULT_FACILITY_PREFERENCE_BY_ORGANIZATION: Record<string, string[]> = {
  "経営企画部": ["ミーティングルームC", "アクト"],
  "営業統括部": ["有玉"],
};
const FACILITY_PREFERENCE_BY_ORGANIZATION = parseFacilityPreferenceTable(
  "FACILITY_PREFERENCE_BY_ORGANIZATION",
  process.env.FACILITY_PREFERENCE_BY_ORGANIZATION,
  DEFAULT_FACILITY_PREFERENCE_BY_ORGANIZATION,
);

// Per-person overrides for the rare case where someone's actual work
// location doesn't match their organization's default (e.g. two people in
// the same 営業統括部 based out of different offices). DeskNet's exposes no
// field more granular than 代表組織, so this is keyed by the requester's
// DeskNet's display name and only needs an entry for known exceptions —
// everyone else falls through to FACILITY_PREFERENCE_BY_ORGANIZATION.
// Overridable via the FACILITY_PREFERENCE_OVERRIDE_BY_USER environment
// variable (same JSON shape, keyed by DeskNet's display name instead of
// organization). Known exception not yet wired in: someone in 営業統括部
// based at the 品川 office (default for that organization is 有玉) — add
// them here, keyed by their exact DeskNet's display name, once known.
const DEFAULT_FACILITY_PREFERENCE_OVERRIDE_BY_USER: Record<string, string[]> = {};
const FACILITY_PREFERENCE_OVERRIDE_BY_USER = parseFacilityPreferenceTable(
  "FACILITY_PREFERENCE_OVERRIDE_BY_USER",
  process.env.FACILITY_PREFERENCE_OVERRIDE_BY_USER,
  DEFAULT_FACILITY_PREFERENCE_OVERRIDE_BY_USER,
);

export function parseFacilityPreferenceTable(
  envVarName: string,
  rawValue: string | undefined,
  fallback: Record<string, string[]>,
): Record<string, string[]> {
  if (rawValue === undefined || rawValue.trim() === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error(
      `${envVarName} must be valid JSON: an object mapping names to ordered arrays of facility name strings.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${envVarName} must be a JSON object mapping names to ordered arrays of facility name strings.`,
    );
  }
  const table: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const isValidPreferenceList =
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "string" && item.trim() !== "");
    if (!isValidPreferenceList) {
      throw new Error(
        `${envVarName}["${key}"] must be a non-empty array of non-empty facility name strings.`,
      );
    }
    table[key] = value as string[];
  }
  return table;
}

const ORGANIZATION_SUFFIX_PATTERN = new RegExp(`${ORGANIZATION_SUFFIX}$`);

// Lowest-priority fallback, tried only when neither table above has an
// entry: strips the same organizational suffix used elsewhere when parsing
// "○○部のBさん" (e.g. "名古屋事務所" → "名古屋"), then treats that token as
// a one-item preference to substring-match against the facilities actually
// on offer (e.g. "名古屋オフィス応接室", "名古屋オフィス会議室"). This lets a
// regional office get a sensible default without a hand-maintained table
// entry. Genuine ambiguity (multiple matching rooms) or no match at all is
// left to the normal preference-resolution failure path, which asks the
// user rather than guessing.
function inferFacilityTokenFromOrganization(organization: string): string | undefined {
  const token = organization.replace(ORGANIZATION_SUFFIX_PATTERN, "").trim();
  return token === "" || token === organization ? undefined : token;
}

function computeFacilityPreferences(
  organization: string | undefined,
  displayName: string | undefined,
  userOverrides: Record<string, string[]>,
  organizationPreferences: Record<string, string[]>,
): string[] | undefined {
  const override = displayName === undefined ? undefined : userOverrides[displayName];
  if (override !== undefined) return override;
  const configured = organization === undefined ? undefined : organizationPreferences[organization];
  if (configured !== undefined) return configured;
  const inferred = organization === undefined ? undefined : inferFacilityTokenFromOrganization(organization);
  return inferred === undefined ? undefined : [inferred];
}

export function resolveFacilityWithPreference(
  query: string | undefined,
  availability: BookableAvailabilitySlot[],
  organization: string | undefined,
  displayName: string | undefined,
  selectedStart: string,
  selectedEnd: string,
  userOverrides: Record<string, string[]> = FACILITY_PREFERENCE_OVERRIDE_BY_USER,
  organizationPreferences: Record<string, string[]> = FACILITY_PREFERENCE_BY_ORGANIZATION,
): string {
  if (query !== undefined) return resolveConversationFacility(query, availability);

  const preferences = computeFacilityPreferences(organization, displayName, userOverrides, organizationPreferences);
  if (preferences === undefined || preferences.length === 0) {
    throw new TypeError("会議室を指定してください。");
  }
  const slot = availability.find(
    (candidate) => candidate.start === selectedStart && candidate.end === selectedEnd,
  );
  const availableIds = slot?.availableFacilityIds ?? [];
  for (const preferred of preferences) {
    const normalizedPreference = normalizeFacilityName(preferred);
    const matches = availableIds.filter((facilityId) =>
      normalizeFacilityName(facilityId).includes(normalizedPreference),
    );
    if (matches.length > 1) {
      throw new TypeError(
        `優先する会議室「${preferred}」が複数の設備に一致しました: ${matches.join("、")}。会議室を指定してください。`,
      );
    }
    if (matches.length === 1) return matches[0] as string;
  }
  throw new TypeError(
    `優先する会議室(${preferences.join("、")})に、指定した日時の空きがありません。会議室を指定してください。`,
  );
}

export function resolveAutomaticFacilityForSlot(
  query: string | undefined,
  slot: BookableAvailabilitySlot,
  organization: string | undefined,
  displayName: string | undefined,
  userOverrides: Record<string, string[]> = FACILITY_PREFERENCE_OVERRIDE_BY_USER,
  organizationPreferences: Record<string, string[]> = FACILITY_PREFERENCE_BY_ORGANIZATION,
): string {
  let candidates = [...slot.availableFacilityIds];
  if (query !== undefined) {
    const normalizedQuery = normalizeFacilityName(query);
    const exact = candidates.find(
      (facilityId) => normalizeFacilityName(facilityId) === normalizedQuery,
    );
    if (exact !== undefined) return exact;
    candidates = candidates.filter((facilityId) =>
      normalizeFacilityName(facilityId).includes(normalizedQuery),
    );
    if (candidates.length === 0) {
      throw new TypeError(`設備が見つからないか、空きがありません: ${query}`);
    }
  }

  const preferences = computeFacilityPreferences(
    organization,
    displayName,
    userOverrides,
    organizationPreferences,
  ) ?? [];
  for (const preference of preferences) {
    const normalizedPreference = normalizeFacilityName(preference);
    const preferred = candidates.find((facilityId) =>
      normalizeFacilityName(facilityId).includes(normalizedPreference),
    );
    if (preferred !== undefined) return preferred;
  }

  const selected = candidates.sort((left, right) => left.localeCompare(right, "ja"))[0];
  if (selected === undefined) throw new TypeError("指定した日時に空いている会議室がありません。");
  return selected;
}

export function resolveTimeOnlySelection(
  prompt: string,
  context: PendingBookingContext,
): BookableAvailabilitySlot | undefined {
  const normalized = prompt.normalize("NFKC").trim();
  const rangeMatch = normalized.match(
    /(\d{1,2})\s*(?:時|:)\s*(\d{1,2})?(?:\s*分)?\s*(?:-|―|ー|〜|~|から)\s*(\d{1,2})\s*(?:時|:)\s*(\d{1,2})?(?:\s*分)?/,
  );
  const startOnlyMatch = rangeMatch === null
    ? normalized.match(
        /(\d{1,2})\s*(?:時|:)\s*(\d{1,2})?(?:\s*分)?\s*(?:開始|スタート|から)/,
      )
    : null;
  const match = rangeMatch ?? startOnlyMatch;
  if (match === null) return undefined;

  const startHour = Number.parseInt(match[1] ?? "", 10);
  const startMinute = Number.parseInt(match[2] ?? "0", 10);
  const inferredEndMinutes =
    startHour * 60 + startMinute + context.durationMinutes;
  const endHour = rangeMatch === null
    ? Math.floor(inferredEndMinutes / 60) % 24
    : Number.parseInt(match[3] ?? "", 10);
  const endMinute = rangeMatch === null
    ? inferredEndMinutes % 60
    : Number.parseInt(match[4] ?? "0", 10);
  if (
    startHour > 23 || startMinute > 59 || endHour > 23 || endMinute > 59
  ) {
    throw new TypeError("有効な開始・終了時刻を指定してください。");
  }

  const matchingSlots = context.availability.filter((slot) => {
    const start = japanDateAndTime(slot.start);
    const end = japanDateAndTime(slot.end);
    return start.hour === startHour && start.minute === startMinute &&
      end.hour === endHour && end.minute === endMinute;
  });
  if (matchingSlots.length === 0) {
    throw new TypeError(
      `指定した時刻は現在の${context.durationMinutes}分候補にありません。候補を確認してください。`,
    );
  }
  const dates = new Set(matchingSlots.map((slot) => japanDateAndTime(slot.start).date));
  if (dates.size > 1) {
    throw new TypeError("複数の日付に同じ時刻の候補があります。日付も指定してください。");
  }
  return matchingSlots[0];
}

function japanDateAndTime(value: string): {
  date: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    hour: Number.parseInt(read("hour"), 10),
    minute: Number.parseInt(read("minute"), 10),
  };
}

// "やっぱりやめて、候補に戻して" — re-display the last candidate list from
// data already held in the conversation, without touching the browser at
// all. Prefers the more specific, facility-narrowed candidates() list (set
// by find_facility_availability) when present, since that's what the user
// was most recently choosing from; otherwise falls back to the general
// find_availability-style availability grid. The reconstructed `task` field
// intentionally reuses find_facility_availability/find_availability's type
// (not a new "show_candidates" task) so the existing web-console rendering
// logic, which switches on run.task?.type, displays it without changes.
export function buildShowCandidatesResponse(
  conversation: PendingBookingConversation,
): { task: DeskNetsTask; result: NonNullable<BrowserRun["result"]> } {
  if (conversation.candidates !== undefined && conversation.facilityId !== undefined) {
    const candidates = conversation.candidates;
    const facilityId = conversation.facilityId;
    return {
      task: { type: "find_facility_availability", facilityQuery: facilityId },
      result: {
        summary: `Re-displaying ${candidates.length} candidates for ${facilityId}.`,
        assistantMessage: `予約をキャンセルしました。${formatNumberedFacilityCandidates(facilityId, candidates)}`,
        evidence: [`Facility: ${facilityId}`, `Candidates shown: ${candidates.length}`],
        availability: candidates,
      },
    };
  }
  const { context } = conversation;
  const endDate = context.endDate ?? context.date;
  return {
    task: {
      type: "find_availability",
      participants: context.participants ?? [],
      date: context.date,
      endDate,
      durationMinutes: context.durationMinutes,
    },
    result: {
      summary: `Re-displaying ${context.availability.length} availability candidates.`,
      assistantMessage: `予約をキャンセルしました。${formatAvailabilityMessage(context.date, endDate, context.durationMinutes, context.availability)}`,
      evidence: [`Candidates: ${context.availability.length}`],
      availability: context.availability,
    },
  };
}

export function formatFacilityChoiceMessage(availableFacilityIds: string[]): string {
  const options = Array.from(new Set(availableFacilityIds));
  const lines = options.map((option) => `・${option}`).join("\n");
  return `会議室の場所はどこにしますか？\n${lines}\nいずれかの名称で答えてください。`;
}

export function formatUnavailableFacilityChoiceMessage(
  requestedFacility: string,
  availableFacilityIds: string[],
): string {
  return `指定した会議室「${requestedFacility}」は、指定した日時には埋まっています。\n別の会議室を指定してください。\n${formatFacilityChoiceMessage(availableFacilityIds)}`;
}

export function inferFacilityScope(query: string): string | undefined {
  const normalized = query.normalize("NFKC").trim();
  const match = normalized.match(
    /^(.+?)(?:大会議室|小会議室|会議室|応接室|ミーティングルーム|ルーム)/,
  );
  const scope = match?.[1]?.trim();
  return scope === "" ? undefined : scope;
}

export function cleanFacilityChoiceReply(prompt: string): string {
  return prompt
    .normalize("NFKC")
    .trim()
    .replace(/^(?:では|それでは|じゃあ|それなら|なら)[、,\s]*/, "")
    .replace(/(?:にして(?:ください)?|で(?:お願いします)?|をお願いします)[。.!！]?$/, "")
    .trim();
}

// Handles the reply to formatFacilityChoiceMessage's question. The prompt is
// treated as a bare facility name rather than run through the normal intent
// parser, since free text like "有玉" or "品川" doesn't match any recognized
// intent pattern on its own; resolveConversationFacility already does the
// same normalized substring matching used everywhere else facility names are
// typed informally.
function handleFacilityChoiceReply(
  run: BrowserRun,
  validatedInput: CreateRunInput,
  conversation: PendingBookingConversation,
  pending: PendingFacilityChoice,
  response: ServerResponse,
): void {
  const companyWideAvailability = getCompanyWideAvailability(conversation.context);
  const slot = companyWideAvailability.find(
    (candidate) => candidate.start === pending.selectedStart && candidate.end === pending.selectedEnd,
  );
  if (slot === undefined || slot.availableFacilityIds.length === 0) {
    pendingBookings.delete(validatedInput.threadId);
    throw new TypeError("指定した日時の候補が失われました。空き時間を再検索してください。");
  }
  let facilityId: string;
  const replyQuery = cleanFacilityChoiceReply(validatedInput.prompt);
  try {
    try {
      facilityId = resolveConversationFacility(replyQuery, [slot]);
    } catch (error) {
      if (pending.facilityScope === undefined) throw error;
      facilityId = resolveConversationFacility(
        `${pending.facilityScope}${replyQuery}`,
        [slot],
      );
    }
  } catch {
    const askAgain: BrowserRun = {
      ...run,
      input: { ...validatedInput, mode: "read" },
      status: "awaiting_user_input",
      updatedAt: new Date().toISOString(),
      result: {
        summary: "Facility choice was not recognized; asking again.",
        assistantMessage: formatFacilityChoiceMessage(slot.availableFacilityIds),
        evidence: [`Candidates: ${slot.availableFacilityIds.join("、")}`],
      },
    };
    runs.set(askAgain.id, askAgain);
    sendJson(response, 202, askAgain);
    return;
  }
  assertSlotHasNotStarted(slot);
  // Deliberately not deleted — see the comment in the book_meeting branch.
  const companyWideContext = {
    ...conversation.context,
    availability: companyWideAvailability,
  };
  pendingBookings.set(
    validatedInput.threadId,
    clearTransientConversationFlags({ ...conversation, context: companyWideContext }),
  );
  const resolved: BrowserRun = {
    ...run,
    input: { ...validatedInput, mode: "write" },
    task: {
      type: "book_meeting",
      facilityQuery: facilityId,
      title: pending.title,
      sendEmail: pending.sendEmail,
      selectedStart: pending.selectedStart,
      selectedEnd: pending.selectedEnd,
    },
    context: companyWideContext,
  };
  runs.set(resolved.id, resolved);
  startRun(resolved.id);
  sendJson(response, 202, resolved);
}

// Matches the reply to the "○○さんが複数見つかりました。どちらですか？"
// question against the offered organization names, and returns every
// candidate that matches (not just the first) so the caller can tell a
// confident single match from a genuinely ambiguous one. An exact match
// (after normalization) always wins outright over substring candidates —
// without that priority, a reply like "経営企画部ではなく三晃です" would
// substring-match BOTH offered organizations, and picking whichever happens
// to be first would silently resolve to the wrong one. Organizations that
// are empty strings (DeskNet's exposed no department for that row) are
// never offered as matchable candidates: besides being unselectable, an
// empty normalized string would otherwise substring-match any reply at all.
export function matchOfferedOrganizations(
  reply: string,
  organizations: string[],
): string[] {
  const normalizedReply = normalizeFacilityName(reply.trim());
  const candidates = organizations.filter((organization) => organization.trim() !== "");
  if (normalizedReply === "") return [];
  const exactMatches = candidates.filter(
    (organization) => normalizeFacilityName(organization) === normalizedReply,
  );
  if (exactMatches.length > 0) return exactMatches;
  return candidates.filter((organization) => {
    const normalizedOrganization = normalizeFacilityName(organization);
    return normalizedOrganization.includes(normalizedReply) || normalizedReply.includes(normalizedOrganization);
  });
}

// An unresolved organization question must not trap the thread forever.
// A fully specified availability request is treated as a replacement for
// the old search and is allowed to proceed through normal intent analysis.
// Using the deterministic parser here keeps short organization answers such
// as "経営企画部の山本さんです" in the choice flow because they still lack a
// date and therefore are not complete find_availability requests.
export function isFreshAvailabilityRequest(prompt: string): boolean {
  try {
    return parseDeskNetsTask(prompt).type === "find_availability";
  } catch {
    return false;
  }
}

export function isParticipantChoiceCancellationRequest(prompt: string): boolean {
  const normalized = prompt.normalize("NFKC").trim();
  return /^(?:この(?:選択|検索|依頼|確認)を)?(?:キャンセル(?:して(?:ください)?|します)?|中止(?:して(?:ください)?|します)?|やめ(?:て(?:ください)?|ます)?|取り消し(?:て(?:ください)?|ます)?)[。.!！]?$/.test(
    normalized,
  );
}

function formatParticipantChoiceMessage(ambiguousName: string, organizations: string[]): string {
  const lines = organizations.map((organization) => `・${organization}`).join("\n");
  return `${ambiguousName}さんが複数見つかりました。どちらですか？\n${lines}\n組織名で答えてください。`;
}

function handleParticipantChoiceReply(
  run: BrowserRun,
  validatedInput: CreateRunInput,
  pending: PendingParticipantChoice,
  response: ServerResponse,
): void {
  const matches = matchOfferedOrganizations(validatedInput.prompt, pending.organizations);
  if (matches.length !== 1) {
    // Zero matches (unrecognized reply) or more than one (a genuinely
    // ambiguous reply) — keep the state and ask again rather than guessing.
    const askAgain: BrowserRun = {
      ...run,
      input: { ...validatedInput, mode: "read" },
      status: "awaiting_user_input",
      updatedAt: new Date().toISOString(),
      result: {
        summary: "Organization choice was not recognized; asking again.",
        assistantMessage: formatParticipantChoiceMessage(pending.ambiguousName, pending.organizations),
        evidence: [`Organizations: ${pending.organizations.join("、")}`],
      },
    };
    runs.set(askAgain.id, askAgain);
    sendJson(response, 202, askAgain);
    return;
  }
  const matchedOrganization = matches[0] as string;
  pendingParticipantChoices.delete(validatedInput.threadId);
  const participants = pending.task.participants.map((participant, index) =>
    index === pending.participantIndex
      ? { ...participant, organization: matchedOrganization }
      : participant,
  );
  const resumed: BrowserRun = {
    ...run,
    input: { ...validatedInput, mode: "read" },
    task: { ...pending.task, participants },
  };
  runs.set(resumed.id, resumed);
  startRun(resumed.id);
  sendJson(response, 202, resumed);
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
