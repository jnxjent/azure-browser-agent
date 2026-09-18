import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertActionAllowed,
  assertRunAllowed,
  filterFutureAvailability,
  findBookableAvailability,
  findCommonAvailability,
  type BookMeetingTask,
  type BookableAvailabilitySlot,
  type BrowserAction,
  type BrowserRun,
  type FindAvailabilityTask,
  type Observation,
  type PendingBookingContext,
  type ParticipantSchedule,
  type ParticipantSelector,
  type RunExecutor,
  type RunLimits,
} from "@azure-browser-agent/agent-core";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  extractFacilitySchedules,
  extractParticipantSchedules,
  mergeParticipantScheduleObservations,
} from "./desknets-dom.js";
import { keepMeetingRoomFacilities } from "./desknets-facilities.js";
import { resolveSelfOrganizationParticipants, preferParticipantOrganization } from "./desknets-participants.js";
import { readCompanyHolidays } from "./desknets-holidays.js";
import { readMeetingHours } from "./meeting-hours.js";
import { resolveLiveRoomChange } from "./room-change.js";
import { ensureSingleDeskNetsTab } from "./desknets-tabs.js";
import { openFacilityDialog } from "./desknets-facility-dialog.js";
import { assertFacilityAvailable } from "./desknets-facility-conflicts.js";
import { participantResultsTable, participantResultsBaseline } from "./desknets-participant-results.js";

interface DeskNetsWorkerOptions {
  cdpEndpoint?: string;
  limits?: RunLimits;
}

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

export class DeskNetsBrowserWorker implements RunExecutor {
  private readonly cdpEndpoint: string;
  private readonly limits: RunLimits;
  private browserConnection: Promise<Browser> | undefined;
  private scheduleUrl: string | undefined;

  constructor(options: DeskNetsWorkerOptions = {}) {
    this.cdpEndpoint =
      options.cdpEndpoint ??
      process.env.DESKNETS_CDP_ENDPOINT ??
      DEFAULT_CDP_ENDPOINT;
    this.limits = options.limits ?? readLimitsFromEnvironment();
  }

  async execute(run: BrowserRun, signal: AbortSignal): Promise<BrowserRun> {
    assertRunAllowed(run, this.limits);
    if (run.input.site !== "desknets") {
      throw new Error("DeskNetsBrowserWorker only accepts site=desknets.");
    }
    if (this.limits.allowedDomains.length === 0) {
      throw new Error("ALLOWED_DOMAINS must include the DeskNet's hostname.");
    }
    assertLoopbackEndpoint(this.cdpEndpoint);
    signal.throwIfAborted();

    const startedAt = Date.now();
    const artifactDirectory = resolve(process.cwd(), "screenshots", run.id);
    await mkdir(artifactDirectory, { recursive: true });

    const browser = await this.getBrowser();
    let page: Page | undefined;
    let preservePreparedForm = false;
    let primaryError: unknown;
    try {
      if (run.task === undefined) {
        throw new Error("DeskNet's run does not contain a structured task.");
      }
      page = await ensureSingleDeskNetsTab(browser, this.limits.allowedDomains);
      if (page === undefined) {
        const startUrl = this.scheduleUrl ?? process.env.DESKNETS_START_URL;
        if (!startUrl) throw new Error("専用EdgeでDeskNet'sのスケジュール画面を開いてください。");
        assertActionAllowed({ type: "open_page", url: startUrl }, this.limits);
        const browserContext = browser.contexts()[0];
        if (!browserContext) throw new Error("DeskNet's専用ブラウザのセッションがありません。");
        page = await browserContext.newPage();
        await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      }
      const pageUrl = new URL(page.url());
      assertActionAllowed({ type: "open_page", url: pageUrl.href }, this.limits);
      const scheduleUrl = new URL(pageUrl);
      scheduleUrl.search = "?cmd=schindex";
      scheduleUrl.hash = "cmd=schweekgrp";
      this.scheduleUrl = scheduleUrl.href;
      if (run.task?.type === "find_availability") {
        const completed = await executeAvailabilityRun({
          run,
          task: run.task,
          page,
          signal,
          limits: this.limits,
          artifactDirectory,
          startedAt,
        });
        // Only a genuine success leaves a form worth preserving for a
        // follow-up booking; an ambiguous-participant pause has already
        // abandoned its partially-filled form and should be cleaned up here.
        preservePreparedForm = completed.status === "completed";
        return completed;
      }
      if (run.task?.type === "book_meeting") {
        const completed = await executeBookingRun({
          run,
          task: run.task,
          page,
          signal,
          limits: this.limits,
          artifactDirectory,
          startedAt,
        });
        preservePreparedForm =
          completed.status === "awaiting_approval" ||
          completed.status === "awaiting_user_input";
        return completed;
      }
      throw new Error("DeskNet's run does not contain a supported structured task.");
    } catch (error) {
      primaryError = error;
      await recordFailure(artifactDirectory, page, "primary", error);
      throw error;
    } finally {
      if (page !== undefined && !page.isClosed() && !preservePreparedForm) {
        try {
          await discardPreparedForm(page);
        } catch (cleanupError) {
          await recordFailure(artifactDirectory, page, "cleanup", cleanupError);
          if (primaryError === undefined) throw cleanupError;
        }
      }
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browserConnection === undefined) {
      const connection = this.connectOrRecoverBrowser();
      this.browserConnection = connection;
      void connection
        .then((browser) => {
          browser.once("disconnected", () => {
            if (this.browserConnection === connection) this.browserConnection = undefined;
          });
        })
        .catch(() => {
          if (this.browserConnection === connection) this.browserConnection = undefined;
        });
    }

    const browser = await this.browserConnection;
    if (browser.isConnected()) return browser;
    this.browserConnection = undefined;
    return this.getBrowser();
  }

  private async connectOrRecoverBrowser(): Promise<Browser> {
    try {
      return await chromium.connectOverCDP(this.cdpEndpoint, { timeout: 10_000 });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ECONNREFUSED")) throw error;
      if (process.platform !== "win32") {
        throw new Error("DeskNet's専用ブラウザに接続できません。専用Edgeを起動してください。", { cause: error });
      }
      const endpoint = new URL(this.cdpEndpoint);
      assertLoopbackEndpoint(this.cdpEndpoint);
      const startUrl = this.scheduleUrl ?? process.env.DESKNETS_START_URL ??
        "https://desknets.midac.jp/dneo/dneo.cgi?cmd=schindex#cmd=schweekgrp";
      assertActionAllowed({ type: "open_page", url: startUrl }, this.limits);
      const profile = resolve(import.meta.dirname, "../../..", ".auth", "desknets-edge-cdp-profile");
      await mkdir(profile, { recursive: true });
      const edge = spawn(process.env.EDGE_EXECUTABLE_PATH ??
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${endpoint.port || "80"}`,
        `--user-data-dir=${profile}`,
        startUrl,
      ], { detached: true, stdio: "ignore", windowsHide: false });
      let startupError: Error | undefined;
      edge.on("error", (cause) => { startupError = cause; });
      edge.unref();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && startupError === undefined) {
        const ready = await fetch(new URL("/json/version", endpoint), {
          signal: AbortSignal.timeout(1_000),
        }).then((response) => response.ok).catch(() => false);
        if (ready) {
          return await chromium.connectOverCDP(this.cdpEndpoint, { timeout: 10_000 });
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      throw new Error("DeskNet's専用Edgeを起動できませんでした。npm run auth:desknets で専用Edgeを起動し、認証してください。", { cause: startupError ?? error });
    }
  }
}

interface DeskNetsExecutionContext {
  run: BrowserRun;
  page: Page;
  signal: AbortSignal;
  limits: RunLimits;
  artifactDirectory: string;
  startedAt: number;
}

async function executeAvailabilityRun(
  context: DeskNetsExecutionContext & { task: FindAvailabilityTask },
): Promise<BrowserRun> {
  const { run, task: requestedTask, page, signal, limits, artifactDirectory, startedAt } = context;
  const meetingHours = readMeetingHours();
  await ensureScheduleList(page);
  signal.throwIfAborted();
  // Read the requester's own department once, while the schedule list (not an
  // unsaved form) is on screen, so a later booking step can resolve a default
  // meeting room without navigating away from an in-progress, unsaved form.
  const { organization: userOrganization, displayName: userDisplayName } =
    await readCurrentUserProfile(page);
  const task: FindAvailabilityTask = {
    ...requestedTask,
    participants: resolveSelfOrganizationParticipants(
      requestedTask.participants,
      userOrganization,
      run.input.prompt,
    ),
  };
  await ensureScheduleList(page);
  signal.throwIfAborted();
  const action: BrowserAction = { type: "click", target: "利用設備" };
  assertActionAllowed(action, limits, "read");
  const searchEnd = task.autoExtendSearch ? new Date(Date.parse(`${task.date}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0,10) : task.endDate;
  const dates = enumerateDates(task.date, searchEnd);
  const holidays = await readCompanyHolidays(page, dates);
  const participantAvailability: BookableAvailabilitySlot[] = [];
  const availability: BookableAvailabilitySlot[] = [];
  const allFacilityAvailability: BookableAvailabilitySlot[] = [];
  let participantIds: string[] = [];
  let participantRowCount = 0;
  let facilityRowCount = 0;
  let observationBefore: Observation | undefined;
  let observationAfter: Observation | undefined;

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index] as string;
    if (task.autoExtendSearch && holidays.has(date)) continue;
    if (task.autoExtendSearch) task.endDate = date;
    let participantSchedules: ParticipantSchedule[];
    if (index > 0) {
      await discardPreparedForm(page);
      await ensureScheduleList(page);
    }
    try {
      participantSchedules = await openAvailabilityForm(page, { ...task, date, endDate: date });
    } catch (error) {
      if (error instanceof AmbiguousParticipantError) {
        if (error.participantIndex === undefined) {
          throw new Error(
            `Internal error: AmbiguousParticipantError for "${error.participantName}" is missing its participant index.`,
          );
        }
        // Ambiguity is a property of the name/organization pairing, not of
        // the specific date, so it would recur identically on every
        // remaining date — no point continuing the loop. execute()'s
        // finally block discards the partially-filled form since this
        // return isn't "completed".
        return {
          ...run,
          status: "awaiting_user_input",
          updatedAt: new Date().toISOString(),
          result: {
            summary: `Participant name "${error.participantName}" matched more than one organization.`,
            assistantMessage: `${error.participantName}さんが複数見つかりました。どちらですか？\n${error.organizations.map((organization) => `・${organization}`).join("\n")}\n組織名で答えてください。`,
            evidence: [
              `Ambiguous participant: ${error.participantName}`,
              `Organizations: ${error.organizations.join("、")}`,
            ],
            participantChoice: {
              task,
              participantIndex: error.participantIndex,
              ambiguousName: error.participantName,
              organizations: error.organizations,
            },
          },
        };
      }
      throw error;
    }
    const dayStart = `${date}T00:00:00+09:00`;
    if (holidays.has(date)) {
      const end = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
      participantSchedules = participantSchedules.map(schedule => ({
        ...schedule, busy: [...schedule.busy, { start: dayStart, end }],
      }));
    }
    participantRowCount = participantSchedules.length;
    if (participantRowCount !== task.participants.length + 1) {
      throw new Error(`Expected ${task.participants.length + 1} participant rows, found ${participantRowCount}.`);
    }
    const distinctParticipantIds = new Set(participantSchedules.map((schedule) => schedule.participantId));
    if (distinctParticipantIds.size !== participantSchedules.length) {
      throw new Error(
        "Two requested participants resolved to the same DeskNet's person; check for inconsistent organization qualifiers.",
      );
    }
    if (participantIds.length === 0) {
      participantIds = participantSchedules.map((schedule) => schedule.participantId);
      observationBefore = await observe(
        page,
        run.id,
        "before.png",
        artifactDirectory,
        `Verified ${participantRowCount} selected participant rows across ${dates.length} requested date(s).`,
        ["Participant selector", "Participant availability grid"],
      );
    } else {
      const currentParticipantIds = participantSchedules.map((schedule) => schedule.participantId);
      if (
        currentParticipantIds.length !== participantIds.length ||
        currentParticipantIds.some((participantId, participantIndex) => participantId !== participantIds[participantIndex])
      ) {
        throw new Error(`Selected participants changed while reading ${date}.`);
      }
    }
    await confirmVisibleDialog(page, "登録先");
    await openFacilityDialog(page);
    const facilitySchedules = keepMeetingRoomFacilities(
      deduplicateFacilitySchedules(
        await extractFacilitySchedules(page.locator("body"), dayStart),
      ),
    );
    facilityRowCount = facilitySchedules.length;
    if (index === dates.length - 1 || task.autoExtendSearch) {
      observationAfter = await observe(
        page,
        run.id,
        "after.png",
        artifactDirectory,
        `Verified ${facilityRowCount} company-wide facility rows on the final requested date.`,
        ["Facility selector", "Facility availability grid"],
      );
    }
    await cancelVisibleDialog(page, "利用設備");

    const availabilityRequest = {
      window: { start: `${date}T${meetingHours.start}:00+09:00`, end: `${date}T${meetingHours.end}:00+09:00` },
      durationMinutes: task.durationMinutes,
      incrementMinutes: 30,
      schedules: participantSchedules,
      ...(task.facilityQuery === undefined ? {} : { facilityQuery: task.facilityQuery }),
    };
    participantAvailability.push(
      ...filterFutureAvailability(findCommonAvailability(availabilityRequest)).map((slot) => ({
        ...slot,
        availableFacilityIds: [],
      })),
    );
    const filteredAvailability = filterFutureAvailability(findBookableAvailability({
      ...availabilityRequest,
      facilities: facilitySchedules,
    }));
    availability.push(...filteredAvailability);
    const { facilityQuery: _facilityQuery, ...companyWideRequest } = availabilityRequest;
    allFacilityAvailability.push(...(task.facilityQuery === undefined
      ? filteredAvailability
      : filterFutureAvailability(findBookableAvailability({
      ...companyWideRequest,
      facilities: facilitySchedules,
    }))));
    assertWithinDuration(startedAt, limits.maxRunDurationMs);
    signal.throwIfAborted();
    if (task.autoExtendSearch && availability.length >= 5) break;
  }
  if (observationBefore === undefined || observationAfter === undefined) {
    throw new Error("The requested date range produced no observable schedule data.");
  }
  assertWithinDuration(startedAt, limits.maxRunDurationMs);
  signal.throwIfAborted();

  const pendingBooking = {
    ...(task.autoExtendSearch === undefined ? {} : {autoExtendSearch:task.autoExtendSearch}),
    ...(task.selectionMode === undefined ? {} : { selectionMode: task.selectionMode }),
    date: task.date,
    endDate: task.endDate,
    durationMinutes: task.durationMinutes,
    participants: task.participants,
    ...(task.facilityQuery === undefined ? {} : { facilityQuery: task.facilityQuery }),
    ...(task.title === undefined ? {} : { title: task.title }),
    participantIds,
    availability,
    allFacilityAvailability,
    ...(userOrganization === undefined ? {} : { userOrganization }),
    ...(userDisplayName === undefined ? {} : { userDisplayName }),
  };
  return {
    ...run,
    status: "completed",
    updatedAt: new Date().toISOString(),
    steps: [
      ...run.steps,
      {
        sequence: run.steps.length + 1,
        observationBefore,
        reasoning:
          "Select the requested participants, read their availability, then inspect facilities while preserving the unsaved form for a possible follow-up booking.",
        action,
        observationAfter,
        verified: participantRowCount >= 2 && facilityRowCount > 0,
      },
    ],
    result: {
      summary: `DeskNet's verified ${participantRowCount} participants across ${dates.length} date(s), found ${participantAvailability.length} participant candidates, and found ${availability.length} candidates with at least one available facility.`,
      assistantMessage: formatAvailabilityMessage(
        task.date,
        task.endDate,
        task.durationMinutes,
        availability,
      ),
      evidence: [
        observationBefore.screenshotRef,
        observationAfter.screenshotRef,
        `Date range: ${task.date} to ${task.endDate}`,
        `Participant rows: ${participantRowCount}`,
        `Facility rows: ${facilityRowCount}`,
      ],
      availability,
      pendingBooking,
    },
  };
}

async function executeBookingRun(
  context: DeskNetsExecutionContext & { task: BookMeetingTask },
): Promise<BrowserRun> {
  const { task, page, signal, limits, artifactDirectory } = context;
  let run = context.run;
  let pending = run.context;
  if (pending === undefined) throw new Error("Pending booking context is missing.");

  if (task.facilityQuery === undefined) {
    throw new Error("Agent API must resolve a concrete facility before dispatching a booking run.");
  }
  if (task.facilityOnlyChange) {
    if (!task.selectedStart || !task.selectedEnd) throw new Error("変更する会議の日時がありません。");
    if (Date.parse(task.selectedStart) < Date.now()) throw new Error("開始時刻を過ぎています。候補を再検索してください。");
    const date = japanDateFromInstant(task.selectedStart);
    await ensurePreparedBookingFormForCandidate(page, pending, date, signal);
    await openFacilityDialog(page);
    const schedules = keepMeetingRoomFacilities(deduplicateFacilitySchedules(await extractFacilitySchedules(page.locator("body"), `${date}T00:00:00+09:00`)));
    await cancelVisibleDialog(page, "利用設備");
    const live = resolveLiveRoomChange(schedules, {start:task.selectedStart,end:task.selectedEnd}, task.facilityQuery,
      task.facilityScope, task.excludePreviousFacility ? task.previousFacilityId : undefined);
    const selected = {start:task.selectedStart,end:task.selectedEnd,participantIds:pending.participantIds,
      durationMinutes:pending.durationMinutes,availableFacilityIds:live.available};
    const replaceSlot = (slots: BookableAvailabilitySlot[]) => [...slots.filter(s=>s.start!==selected.start || s.end!==selected.end),selected];
    pending = {...pending, availability:replaceSlot(pending.availability), allFacilityAvailability:replaceSlot(pending.allFacilityAvailability ?? pending.availability)};
    run = {...run,context:pending};
    if (!live.facilityId) return {...run,status:"awaiting_user_input",updatedAt:new Date().toISOString(),result:{
      summary:"Checked the requested room at the saved meeting time.",assistantMessage:live.message,
      evidence:[`Room timelines checked for ${date}`],facilityAlternatives:live.alternatives,
    }};
    task.facilityQuery = live.facilityId;
  }
  const facilityId = resolveFacility(task.facilityQuery, pending.availability);
  const slot = pending.availability.find(
    (candidate) =>
      candidate.availableFacilityIds.includes(facilityId) &&
      (task.selectedStart === undefined || candidate.start === task.selectedStart) &&
      (task.selectedEnd === undefined || candidate.end === task.selectedEnd),
  );
  if (slot === undefined) {
    throw new Error(
      `${facilityId}には、指定した日時で参加者全員が空いている${pending.durationMinutes}分枠がありません。`,
    );
  }
  if (Date.parse(slot.start) < Date.now()) {
    throw new Error(
      "選択した開始時刻を過ぎたため登録できません。空き時間を再検索してください。",
    );
  }
  signal.throwIfAborted();
  const selectedDate = japanDateFromInstant(slot.start);

  if (run.approval?.approvedAt !== undefined) {
    const rebuilt = await ensurePreparedBookingFormForCandidate(page, pending, selectedDate, signal);
    if (rebuilt) await fillBookingForm(page, task, slot, facilityId, selectedDate);
    await page.locator('input[name="detail"]:visible').fill(task.title);
    await assertBookingFormMatches(
      page,
      task,
      slot,
      facilityId,
      selectedDate,
      pending.participantIds,
    );
    await openFacilityDialog(page);
    await verifyLiveFacilityAvailability(page, facilityId, slot, selectedDate);
    await cancelVisibleDialog(page, "利用設備");
    signal.throwIfAborted();
    const observationBefore = await observe(
      page,
      run.id,
      "before.png",
      artifactDirectory,
      "Verified the prepared DeskNet's booking form before handing final registration to the user.",
      ["Meeting title", "Date and time", "Participants", "Facility", "Email notification"],
    );
    const foregroundShown = await bringPreparedFormToFront(page);
    const handoffAction: BrowserAction = { type: "wait", milliseconds: 0 };
    return {
      ...run,
      status: "awaiting_user_input",
      updatedAt: new Date().toISOString(),
      steps: [
        ...run.steps,
        {
          sequence: run.steps.length + 1,
          observationBefore,
          reasoning:
            "The authenticated AzureChat user approved opening the prepared form; final registration remains a manual DeskNet's action.",
          action: handoffAction,
          observationAfter: observationBefore,
          verified: true,
        },
      ],
      result: {
        summary: "Displayed the prepared DeskNet's form for manual final confirmation.",
        assistantMessage: foregroundShown
          ? "DeskNet'sの予定追加画面を表示しました。内容を確認し、DeskNet's上の「追加」を手動で押してください。Agentは予定を登録していません。"
          : "DeskNet'sの予定追加画面を準備しました。専用EdgeをAlt + Tabで表示し、内容を確認して「追加」を手動で押してください。Agentは予定を登録していません。",
        evidence: [observationBefore.screenshotRef],
        manualActionRequest: {
          nativeFacilityId: await readNativeFacilityId(page, facilityId),
          ...(run.result?.approvalRequest?.nativeUserIds ? {nativeUserIds:run.result.approvalRequest.nativeUserIds} : {}),
          title: task.title,
          start: slot.start,
          end: slot.end,
          participantIds: pending.participantIds,
          facilityId,
          emailNotificationWillBeSent: task.sendEmail,
          selfNotificationSuppressed: false,
        },
      },
    };
  }

  await ensurePreparedBookingFormForCandidate(
    page,
    pending,
    selectedDate,
    signal,
  );

  await fillBookingForm(page, task, slot, facilityId, selectedDate);
  // Capture IDs only after verifying the visible form matches the selected people.
  await assertBookingFormMatches(page, task, slot, facilityId, selectedDate, pending.participantIds);
  const nativeUserIds = await page.locator('input[name="otherto"]').evaluateAll(elements =>
    elements.map(element => (element as HTMLInputElement).value));
  const verifiedNativeUserIds = nativeUserIds.length === pending.participantIds.length &&
    new Set(nativeUserIds).size === nativeUserIds.length && nativeUserIds.every(id => /^\d{1,20}$/.test(id))
    ? nativeUserIds : undefined;
  const nativeFacilityId = await readNativeFacilityId(page, facilityId);
  if (task.facilityOnlyChange) {
    await assertBookingFormMatches(page, task, slot, facilityId, selectedDate, pending.participantIds);
    const observation = await observe(page,run.id,"after.png",artifactDirectory,"Changed only the room; preserved the saved meeting.",["Date and time","Participants","Facility"]);
    await bringPreparedFormToFront(page);
    return {...run,status:"awaiting_user_input",updatedAt:new Date().toISOString(),result:{
      summary:"Displayed the changed room for manual final confirmation.",
      assistantMessage:"日時・参加者・会議時間を引き継ぎ、会議室を変更したDeskNet's画面を表示しました。最終登録はDeskNet'sの「追加」を手動で押してください。",
      evidence:[observation.screenshotRef],manualActionRequest:{nativeFacilityId,...(verifiedNativeUserIds ? {nativeUserIds:verifiedNativeUserIds} : {}),title:task.title,start:slot.start,end:slot.end,
        participantIds:pending.participantIds,facilityId,emailNotificationWillBeSent:task.sendEmail,selfNotificationSuppressed:false},
    }};
  }

  const observationBefore = await observe(
    page,
    run.id,
    "before.png",
    artifactDirectory,
    `Prepared ${task.title === "" ? "an editable blank agenda" : task.title}, ${formatJapanDateTime(slot.start)}-${formatJapanTime(slot.end)}, ${facilityId}, with email notification ${task.sendEmail ? "enabled" : "disabled"} and self-notification suppression disabled.`,
    ["Meeting title", "Date and time", "Participants", "Facility", "Email notification"],
  );
  await bringPreparedFormToFront(page);
  const preparationAction: BrowserAction = {
    type: "type_text",
    target: "予定フォーム",
    text: task.title,
  };
  assertActionAllowed(preparationAction, limits, "write");
  return {
    ...run,
    status: "awaiting_approval",
    updatedAt: new Date().toISOString(),
    approval: {
      requestedAt: new Date().toISOString(),
    },
    steps: [
      ...run.steps,
      {
        sequence: run.steps.length + 1,
        observationBefore,
        reasoning:
          "Prepare the DeskNet's booking form and wait for explicit approval from AzureChat before clicking Add.",
        action: preparationAction,
        observationAfter: observationBefore,
        verified: true,
      },
    ],
    result: {
      summary: "Prepared the DeskNet's booking form and requested explicit AzureChat approval.",
      assistantMessage: `以下の内容を確認し、AzureChatのオレンジのボタンを押してください。DeskNet'sの予定追加画面を表示します。メール送信は${task.sendEmail ? "オン" : "オフ"}、本人への通知はオンです。DeskNet's上の「追加」を手動で押すまで予定は登録されません。`,
      evidence: [observationBefore.screenshotRef],
      approvalRequest: {
        nativeFacilityId,
        ...(verifiedNativeUserIds ? {nativeUserIds:verifiedNativeUserIds} : {}),
        title: task.title,
        start: slot.start,
        end: slot.end,
        participantIds: pending.participantIds,
        facilityId,
        emailNotificationWillBeSent: task.sendEmail,
      },
    },
  };
}

export async function bringPreparedFormToFront(page: Page): Promise<boolean> {
  await page.bringToFront();
  if (process.platform !== "win32") return true;

  // Query the connected browser, since Edge can restart and invalidate PID files.
  const browser = page.context().browser();
  if (browser === null) return false;
  const session = await browser.newBrowserCDPSession();
  let processId: number | undefined;
  try {
    const processes = await session.send("SystemInfo.getProcessInfo");
    processId = processes.processInfo.find((entry) => entry.type === "browser")?.id;
  } finally {
    await session.detach();
  }
  if (processId === undefined || !Number.isInteger(processId) || processId <= 0) return false;

  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeskNetsWindowFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
}
'@
$targetProcessId = [int]$env:DESKNETS_EDGE_PROCESS_ID
$target = Get-Process -Id $targetProcessId -ErrorAction Stop
if ($target.MainWindowHandle -eq 0) { exit 2 }
[void][DeskNetsWindowFocus]::ShowWindowAsync($target.MainWindowHandle, 9)
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate($targetProcessId)
Start-Sleep -Milliseconds 100
[void][DeskNetsWindowFocus]::SetForegroundWindow($target.MainWindowHandle)
if ([DeskNetsWindowFocus]::GetForegroundWindow() -eq $target.MainWindowHandle) { exit 0 }
$currentThread = [DeskNetsWindowFocus]::GetCurrentThreadId()
$foregroundThread = [DeskNetsWindowFocus]::GetWindowThreadProcessId([DeskNetsWindowFocus]::GetForegroundWindow(), [IntPtr]::Zero)
$attached = [DeskNetsWindowFocus]::AttachThreadInput($currentThread, $foregroundThread, $true)
try {
  [void][DeskNetsWindowFocus]::SetForegroundWindow($target.MainWindowHandle)
} finally {
  if ($attached) { [void][DeskNetsWindowFocus]::AttachThreadInput($currentThread, $foregroundThread, $false) }
}
if ([DeskNetsWindowFocus]::GetForegroundWindow() -eq $target.MainWindowHandle) { exit 0 }
exit 3
`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const powershell = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    {
      env: {
        ...process.env,
        DESKNETS_EDGE_PROCESS_ID: String(processId),
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const result = await Promise.race([
    once(powershell, "exit").then(([code]) => ({
      kind: "exit" as const,
      code: typeof code === "number" ? code : null,
    })),
    once(powershell, "error").then(() => ({ kind: "error" as const })),
  ]);
  return result.kind === "exit" && result.code === 0;
}

export async function ensureScheduleList(page: Page): Promise<void> {
  if ((await page.locator(".jsch-startdate:visible").count()) === 1) {
    await discardPreparedForm(page);
  }
  if (
    (await page.locator('input[type="password"]:visible').count()) > 0 &&
    (await page.getByText("ログイン", { exact: true }).filter({ visible: true }).count()) > 0
  ) {
    throw new Error(
      "DeskNet's専用Edgeが未ログインです。専用Edgeで手動ログインし、スケジュール画面が表示されてから再実行してください。",
    );
  }
  const marker = page.getByText("氏名/組織名", { exact: true }).filter({ visible: true }).first();
  if (await marker.count() === 0) {
    // Cancel may return to equipment reservations, a personal calendar or the
    // portal. None exposes the group schedule's participant-selection header.
    const url = new URL(page.url());
    url.search = "?cmd=schindex";
    url.hash = "cmd=schweekgrp";
    // Force a document navigation even when only the hash differs, avoiding
    // stale asynchronous DeskNet's route updates.
    await page.goto(url.origin + url.pathname + url.search, {waitUntil:"load"});
    await page.goto(url.href, {waitUntil:"load"});
  }
  try {
    await marker.waitFor({state:"visible",timeout:10_000});
  } catch (cause) {
    throw new Error("DeskNet'sのスケジュール（組織週間）画面に戻れませんでした。専用Edgeのログイン状態と画面を確認してください。", {cause});
  }
}

interface CurrentUserProfile {
  organization?: string;
  displayName?: string;
}

// Failure here (profile DOM change, transient navigation error, etc.) must
// not block an availability search that doesn't end up needing a facility
// preference at all. Each field is independently omitted on failure to read
// it; the room-preference lookup then surfaces its own "会議室を指定して
// ください。" only if the user actually reaches a preference-dependent
// booking without naming a room. displayName is read from the schedule
// page's own username dropdown (#dn-h-username, the same element already
// used to reach the profile page) before navigating away, since it lets
// individual exceptions (someone whose real work location differs from
// their 代表組織-based default) be layered on top of the organization-level
// preference table without adding a new DOM dependency.
async function readCurrentUserProfile(page: Page): Promise<CurrentUserProfile> {
  const scheduleUrl = page.url();
  const displayName = await page
    .locator("#dn-h-username")
    .first()
    .innerText()
    .then((text) => text.trim())
    .catch(() => "");
  const profileUrl = new URL(scheduleUrl);
  profileUrl.hash = "";
  profileUrl.searchParams.set("cmd", "psetindex");
  try {
    await page.goto(profileUrl.href, { waitUntil: "load" });
    const organizationSelect = page.locator('select[name="Group"]:visible').first();
    await organizationSelect.waitFor({ state: "visible", timeout: 10_000 });
    const organization = await organizationSelect.evaluate((element) => {
      const select = element as HTMLSelectElement;
      return select.options[select.selectedIndex]?.text.trim() ?? "";
    });
    return {
      ...(organization === "" ? {} : { organization }),
      ...(displayName === "" ? {} : { displayName }),
    };
  } catch {
    return displayName === "" ? {} : { displayName };
  } finally {
    // A failure here must not override whatever the try/catch above already
    // decided to return — otherwise a return-navigation hiccup turns a
    // graceful "profile unreadable" result into a hard failure of the whole
    // availability search. ensureScheduleList() runs again right after this
    // function returns and will surface its own clear error if the page
    // truly isn't back on the schedule list.
    await page.goto(scheduleUrl, { waitUntil: "load" }).catch(() => {});
  }
}

async function openAvailabilityForm(
  page: Page,
  task: FindAvailabilityTask,
): Promise<ParticipantSchedule[]> {
  const currentUser = page.locator('input[type="checkbox"]:visible').first();
  if ((await currentUser.count()) !== 1) throw new Error("Current user schedule row was not found.");
  if (!(await currentUser.isChecked())) await currentUser.click({ noWaitAfter: true });
  const launcher = page.locator("a.jsch-btn-add");
  await launcher.waitFor({ state: "visible", timeout: 5_000 });
  await launcher.click({ noWaitAfter: true });
  await page.locator(".jsch-startdate:visible").waitFor({ state: "visible", timeout: 10_000 });
  await setFormDate(page, task.date);

  const chooser = page
    .locator("a.jsch-entry-target-chooser:visible")
    .filter({ hasText: "登録先" });
  if ((await chooser.count()) !== 1) throw new Error("Registration-target chooser was not found.");
  await chooser.click({ noWaitAfter: true });
  const dialog = page.locator(".co-sel-dialog:visible");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(1_500);

  const dayStart = `${task.date}T00:00:00+09:00`;
  let observedSchedules: ParticipantSchedule[] = [];
  const rememberVisibleSchedules = async (): Promise<void> => {
    const visibleSchedules = await extractParticipantSchedules(page.locator("body"), dayStart);
    // DeskNet's can clear an earlier row's painted blocks while adding a
    // later participant. Never replace observed busy intervals with that
    // transient empty rendering.
    observedSchedules = mergeParticipantScheduleObservations(
      observedSchedules,
      visibleSchedules,
    );
  };
  await rememberVisibleSchedules();

  for (let index = 0; index < task.participants.length; index += 1) {
    const selector = task.participants[index] as ParticipantSelector;
    try {
      await selectParticipant(dialog, page, selector);
    } catch (error) {
      // selectParticipant doesn't know its own position in task.participants,
      // but the caller (executeAvailabilityRun) needs it to update only the
      // specific ambiguous entry rather than every participant sharing that
      // name (e.g. "営業部の山本さんと、山本さん").
      if (error instanceof AmbiguousParticipantError) error.participantIndex = index;
      throw error;
    }
    await page.waitForTimeout(750);
    await rememberVisibleSchedules();
  }
  const expectedRows = task.participants.length + 1;
  const selectedRows = dialog.locator(".co-sel-bottom table tbody tr");
  if ((await selectedRows.count()) !== expectedRows) {
    throw new Error(`Expected ${expectedRows} selected participant rows.`);
  }
  const selectedParticipantIds = await selectedRows.evaluateAll((rows) =>
    rows.map((row) => row.querySelector(".name-text")?.textContent?.trim() ?? ""),
  );
  const schedulesByParticipant = new Map(
    observedSchedules.map((schedule) => [schedule.participantId, schedule]),
  );
  return selectedParticipantIds.map((participantId) => {
    const schedule = schedulesByParticipant.get(participantId);
    if (schedule === undefined) {
      throw new Error(`No schedule observation was captured for ${participantId}.`);
    }
    return schedule;
  });
}

// Thrown instead of a plain Error when a requested name (with no
// organization given to disambiguate) matches people in more than one
// organization. executeAvailabilityRun catches this specifically and turns
// it into an "awaiting_user_input" run asking the user to pick one, instead
// of failing the whole search outright. participantIndex is set by
// openAvailabilityForm's loop, not by selectParticipant itself (which has no
// visibility into its own position in the participants list).
class AmbiguousParticipantError extends Error {
  participantIndex: number | undefined;

  constructor(
    public readonly participantName: string,
    public readonly organizations: string[],
  ) {
    super(`Participant name is ambiguous: ${participantName}.`);
    this.name = "AmbiguousParticipantError";
  }
}

async function selectParticipant(
  dialog: Locator,
  page: Page,
  selector: ParticipantSelector,
): Promise<void> {
  const searchTab = dialog.locator("li.co-sel-search a").first();
  await searchTab.click({ noWaitAfter: true });
  const nameField = dialog.locator('input[name="name"]:visible').first();
  await nameField.waitFor({ state: "visible", timeout: 5_000 });
  await nameField.fill(selector.name);
  const keyField = dialog.locator('input[name="key"]:visible').first();
  if ((await keyField.count()) === 1) await keyField.fill("");

  const resultsTable = participantResultsTable(dialog);
  const previousResultsHtml = await participantResultsBaseline(resultsTable);
  // Clicking the search form's submit input does not reliably submit the name
  // search (it can land on an unrelated default listing); pressing Enter in the
  // name field submits the correct form.
  await nameField.press("Enter");
  await resultsTable.waitFor({ state: "visible", timeout: 10_000 });
  await waitForResultsToRefresh(resultsTable, previousResultsHtml);
  await page.waitForTimeout(300);

  const rows = resultsTable.locator("tbody tr");
  // Read all results in one browser round trip, retaining row indices and
  // exact matching semantics for the subsequent ambiguity checks.
  const candidates = await rows.evaluateAll((elements) => elements.map((row, index) => {
    const names = row.querySelectorAll<HTMLElement>("span.co-sel-name");
    const organizations = row.querySelectorAll<HTMLElement>("span.co-busyo-def");
    return {
      index,
      name: names.length === 1 ? names[0]!.innerText.trim() : null,
      organization: organizations.length === 1 ? organizations[0]!.innerText.trim() : "",
    };
  }));
  const nameMatches = candidates
    .filter((candidate) => candidate.name?.startsWith(selector.name))
    .map((candidate) => ({ row: rows.nth(candidate.index), organization: candidate.organization }));

  if (nameMatches.length === 0) {
    throw new Error(`Participant was not found: ${selector.name}`);
  }
  const matches = preferParticipantOrganization(nameMatches, selector);
  if (matches.length === 0) {
    throw new Error(
      `Participant ${selector.name} was found, but none belong to the requested organization: ${selector.organization}`,
    );
  }
  if (matches.length > 1) {
    // Exclude rows DeskNet's didn't expose an organization for — offering ""
    // as a choice would be unusable, and (server-side) an empty string would
    // wrongly substring-match any reply at all.
    const distinctOrganizations = Array.from(
      new Set(matches.map((match) => match.organization).filter((organization) => organization !== "")),
    );
    if (distinctOrganizations.length > 1) {
      throw new AmbiguousParticipantError(selector.name, distinctOrganizations);
    }
    throw new Error(`Participant name is ambiguous: ${selector.name}.`);
  }

  const matchedRow = matches[0] as { row: Locator; organization: string };
  const addControl = matchedRow.row.locator("td.co-sel-button").getByText("追加", { exact: true });
  if ((await addControl.count()) !== 1) throw new Error(`Add control was not found for: ${selector.name}`);
  await addControl.click({ noWaitAfter: true });
  await page.waitForTimeout(350);
}

async function waitForResultsToRefresh(
  resultsTable: Locator,
  previousHtml: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await resultsTable.innerHTML()) !== previousHtml) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function openParticipantDialog(page: Page): Promise<void> {
  const chooser = page
    .locator("a.jsch-entry-target-chooser:visible")
    .filter({ hasText: "登録先" });
  if ((await chooser.count()) !== 1) throw new Error("Registration-target chooser was not found.");
  await chooser.click({ noWaitAfter: true });
  const dialog = page.locator(".co-sel-dialog:visible");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function setFormDate(page: Page, date: string): Promise<void> {
  const displayDate = date.replaceAll("-", "/");
  let changed = false;
  for (const selector of [".jsch-startdate:visible", ".jsch-enddate:visible"]) {
    const input = page.locator(selector);
    if (await input.inputValue() === displayDate) continue;
    await input.fill(displayDate);
    await input.press("Tab");
    changed = true;
  }
  if (changed) await page.waitForTimeout(300);
}

async function fillBookingForm(
  page: Page,
  task: BookMeetingTask,
  slot: BookableAvailabilitySlot,
  facilityId: string,
  date: string,
): Promise<void> {
  await setFormDate(page, date);
  const start = readJapanClock(slot.start);
  const end = readJapanClock(slot.end);
  const hours = page.locator("select.co-timepicker-hour:visible");
  const minutes = page.locator("select.co-timepicker-minute:visible");
  if ((await hours.count()) !== 2 || (await minutes.count()) !== 2) {
    throw new Error("DeskNet's time controls were not found.");
  }
  await hours.nth(0).selectOption({ label: `${start.hour}時` });
  await minutes.nth(0).selectOption({ label: `${start.minute}分` });
  await hours.nth(1).selectOption({ label: `${end.hour}時` });
  await minutes.nth(1).selectOption({ label: `${end.minute}分` });
  await page.locator('input[name="detail"]:visible').fill(task.title);

  await openFacilityDialog(page);
  await verifyLiveFacilityAvailability(page, facilityId, slot, date);
  const dialog = locateVisibleDialog(page, "利用設備");
  await selectExactFacility(dialog, facilityId);
  await confirmVisibleDialog(page, "利用設備");

  const checkboxes = page.locator('input[type="checkbox"]:visible');
  let emailCheckbox;
  let suppressSelfNotificationCheckbox;
  for (let index = 0; index < (await checkboxes.count()); index += 1) {
    const checkbox = checkboxes.nth(index);
    const label = (await checkbox.locator("..").innerText()).trim();
    if (label === "メール") emailCheckbox = checkbox;
    if (label.includes("自分には通知しない")) suppressSelfNotificationCheckbox = checkbox;
  }
  if (emailCheckbox === undefined) throw new Error("Email notification checkbox was not found.");
  if (suppressSelfNotificationCheckbox === undefined) {
    throw new Error("Self-notification suppression checkbox was not found.");
  }
  if (task.sendEmail && !(await emailCheckbox.isChecked())) await emailCheckbox.check();
  if (!task.sendEmail && (await emailCheckbox.isChecked())) await emailCheckbox.uncheck();
  if (await suppressSelfNotificationCheckbox.isChecked()) {
    await suppressSelfNotificationCheckbox.uncheck();
  }
}

export async function readNativeFacilityId(page: Page, facilityName: string): Promise<string | undefined> {
  const selected = await page.locator('.sch-row-plant input[name="pids"]').evaluateAll(elements => elements.map(element => {
    const input = element as HTMLInputElement;
    const label = input.closest('.co-selitem')?.querySelector('a[data-pid]');
    return {id:input.value,label:label?.textContent?.trim(),labelId:label?.getAttribute('data-pid')};
  }));
  const room = selected[0];
  return selected.length === 1 && room && /^\d{1,20}$/.test(room.id) &&
    room.label === facilityName && room.labelId === room.id ? room.id : undefined;
}

export async function selectExactFacility(dialog: Locator, facilityId: string): Promise<void> {
  const rows = dialog.locator(".sch-entry-plant-reserve-list table tbody tr");
  const room = rows.getByText(facilityId, { exact: true });
  if ((await room.count()) !== 1) throw new Error(`Facility row was not found: ${facilityId}`);

  const checkbox = room
    .locator("xpath=ancestor::tr[1]")
    .locator('input[type="checkbox"]');
  if ((await checkbox.count()) !== 1) {
    throw new Error(`Facility checkbox was not found: ${facilityId}`);
  }

  // A booking has exactly one facility. Reusing a prepared form must replace
  // its prior selection, not accumulate additional rooms.
  const previousSelections = await rows.evaluateAll((elements, requested) => elements.flatMap((row, index) => {
    const name = row.querySelector(".sch-entry-plant-name")?.textContent?.trim();
    const selected = row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked;
    return selected && name !== requested ? [index] : [];
  }), facilityId);
  for (const index of previousSelections) {
    const previous = rows.nth(index).locator('input[type="checkbox"]');
    await previous.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
    try {
      await previous.uncheck({ timeout: 3_000 });
    } catch (error) {
      await previous.evaluate((element) => {
        const input = element as HTMLInputElement;
        if (input.checked) input.click();
      });
      if (await previous.isChecked()) throw error;
    }
  }

  // DeskNet's keeps the facility rows in a nested scrolling pane. Playwright's
  // normal checkbox action can repeatedly scroll the outer dialog and still
  // consider a valid row outside the viewport, so center the exact DOM-backed
  // row first and use a native click as a narrowly scoped fallback.
  await checkbox.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  try {
    await checkbox.check({ timeout: 3_000 });
  } catch (error) {
    await checkbox.evaluate((element) => {
      const input = element as HTMLInputElement;
      if (!input.checked) input.click();
    });
    if (!(await checkbox.isChecked())) throw error;
  }
  if (!(await checkbox.isChecked())) {
    throw new Error(`Facility checkbox did not stay selected: ${facilityId}`);
  }
  const selectedNames = await rows.evaluateAll((elements) => elements
    .filter((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)
    .map((row) => row.querySelector(".sch-entry-plant-name")?.textContent?.trim()));
  if (selectedNames.length !== 1 || selectedNames[0] !== facilityId) {
    throw new Error("会議室を1件だけに変更できませんでした。利用設備の選択を確認してください。");
  }
}

async function assertPreparedBookingForm(page: Page, participantIds: string[]): Promise<void> {
  if ((await page.locator(".jsch-startdate:visible").count()) !== 1) {
    throw new Error("The pending unsaved schedule form is no longer open.");
  }
  const body = await page.locator("body").innerText();
  for (const participantId of participantIds) {
    if (!body.includes(participantId)) throw new Error(`Prepared form is missing ${participantId}.`);
  }
}

/**
 * Reuses the pending DeskNet's form only when it is still open and contains
 * the expected participants. A user may close that form, return to the saved
 * candidates, and choose another slot; a different/stale form may also be
 * visible after manual browser interaction. In either case, rebuild the form
 * from the conversation context instead of failing the booking run.
 */
async function ensurePreparedBookingFormForCandidate(
  page: Page,
  pending: PendingBookingContext,
  selectedDate: string,
  signal: AbortSignal,
): Promise<boolean> {
  const formIsVisible =
    (await page.locator(".jsch-startdate:visible").count()) === 1;
  if (formIsVisible) {
    try {
      await assertPreparedBookingForm(page, pending.participantIds);
      await confirmRegistrationTargetDialogIfVisible(page);
      return false;
    } catch {
      // The visible form is stale or belongs to another selection. The
      // schedule-list transition below safely discards it before rebuilding.
    }
  }

  if (pending.participants === undefined) {
    throw new Error(
      "予約フォームが閉じられており、参加者情報が失われているため再作成できません。空き時間を再検索してください。",
    );
  }

  await ensureScheduleList(page);
  signal.throwIfAborted();
  await openAvailabilityForm(page, {
    type: "find_availability",
    participants: pending.participants,
    date: selectedDate,
    endDate: selectedDate,
    durationMinutes: pending.durationMinutes,
  });
  await assertPreparedBookingForm(page, pending.participantIds);
  await confirmRegistrationTargetDialogIfVisible(page);
  return true;
}

/**
 * openAvailabilityForm intentionally leaves the registration-target dialog
 * open while availability is inspected. A reconstructed booking form does
 * not perform that inspection, so it must commit the selected participants
 * before fillBookingForm can click the facility chooser behind the dialog.
 * This also recovers a dialog left visible by an earlier interrupted retry.
 */
async function confirmRegistrationTargetDialogIfVisible(
  page: Page,
): Promise<void> {
  const dialog = page.locator(".ui-dialog.co-sel-dialog:visible");
  const count = await dialog.count();
  if (count === 0) return;
  if (count !== 1) {
    throw new Error(`Expected at most one visible 登録先 dialog, found ${count}.`);
  }
  const ok = dialog.getByText("OK", { exact: true });
  if ((await ok.count()) !== 1) {
    throw new Error("登録先 dialog OK button was not found.");
  }
  await ok.click({ noWaitAfter: true });
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  await page.waitForTimeout(300);
}

async function assertBookingFormMatches(
  page: Page,
  task: BookMeetingTask,
  slot: BookableAvailabilitySlot,
  facilityId: string,
  date: string,
  participantIds: string[],
): Promise<void> {
  await assertPreparedBookingForm(page, participantIds);
  const title = await page.locator('input[name="detail"]:visible').inputValue();
  if (title !== task.title) throw new Error("The prepared meeting title changed before approval.");

  const expectedDate = date.replaceAll("-", "/");
  for (const selector of [".jsch-startdate:visible", ".jsch-enddate:visible"]) {
    if ((await page.locator(selector).inputValue()) !== expectedDate) {
      throw new Error("The prepared meeting date changed before approval.");
    }
  }

  const hours = page.locator("select.co-timepicker-hour:visible");
  const minutes = page.locator("select.co-timepicker-minute:visible");
  const start = readJapanClock(slot.start);
  const end = readJapanClock(slot.end);
  const expectedTimes = [
    `${start.hour}時`,
    `${start.minute}分`,
    `${end.hour}時`,
    `${end.minute}分`,
  ];
  const actualTimes = await Promise.all([
    hours.nth(0).locator("option:checked").innerText(),
    minutes.nth(0).locator("option:checked").innerText(),
    hours.nth(1).locator("option:checked").innerText(),
    minutes.nth(1).locator("option:checked").innerText(),
  ]);
  if (actualTimes.some((value, index) => value.trim() !== expectedTimes[index])) {
    throw new Error("The prepared meeting time changed before approval.");
  }

  const body = await page.locator("body").innerText();
  if (!body.includes(facilityId)) throw new Error("The prepared facility changed before approval.");
  const emailIsChecked = await page.locator('input[type="checkbox"]:visible').evaluateAll((elements) => {
    const matches = elements.filter((element) => element.parentElement?.innerText.trim() === "メール");
    return (matches.at(-1) as HTMLInputElement | undefined)?.checked;
  });
  if (emailIsChecked === undefined) throw new Error("Email notification checkbox is missing.");
  if (emailIsChecked !== task.sendEmail) {
    throw new Error("Email notification choice changed before approval.");
  }
}

async function verifyLiveFacilityAvailability(
  page: Page, facilityId: string, slot: BookableAvailabilitySlot, date: string,
): Promise<void> {
  const schedules = await extractFacilitySchedules(page.locator("body"), `${date}T00:00:00+09:00`);
  assertFacilityAvailable(schedules, facilityId, slot);
}

function resolveFacility(
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
  if (matches.length === 0) throw new Error(`設備が見つからないか、空きがありません: ${query}`);
  if (matches.length > 1) throw new Error(`設備名が曖昧です: ${matches.join("、")}`);
  return matches[0] as string;
}

function normalizeFacilityName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

function deduplicateFacilitySchedules<T extends { facilityId: string }>(
  facilities: T[],
): T[] {
  const seen = new Set<string>();
  return facilities.filter((facility) => {
    if (seen.has(facility.facilityId)) return false;
    seen.add(facility.facilityId);
    return true;
  });
}

async function confirmVisibleDialog(page: Page, label: string): Promise<void> {
  const dialog = locateVisibleDialog(page, label);
  const dialogCount = await dialog.count();
  if (dialogCount !== 1) {
    throw new Error(
      `Expected one visible ${label} dialog, found ${dialogCount} (visible UI dialogs: ${await page.locator(".ui-dialog:visible").count()}, participant contents: ${await page.locator(".co-sel-dialog:visible").count()}).`,
    );
  }
  const ok = dialog.getByText("OK", { exact: true });
  if ((await ok.count()) !== 1) throw new Error(`${label} dialog OK button was not found.`);
  await ok.click({ noWaitAfter: true });
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  await page.waitForTimeout(300);
}

async function cancelVisibleDialog(page: Page, label: string): Promise<void> {
  const dialog = locateVisibleDialog(page, label);
  if ((await dialog.count()) !== 1) throw new Error(`Expected one visible ${label} dialog.`);
  const cancel = dialog.getByText("キャンセル", { exact: true });
  if ((await cancel.count()) !== 1) throw new Error(`${label} dialog Cancel button was not found.`);
  await cancel.click({ noWaitAfter: true });
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  await page.waitForTimeout(300);
}

function locateVisibleDialog(page: Page, label: string): Locator {
  if (label === "登録先") {
    return page.locator(".ui-dialog:visible");
  }
  if (label === "利用設備") {
    return page
      .locator(".ui-dialog:visible")
      .filter({ has: page.locator(".sch-entry-plant-reserve-list") });
  }
  return page.locator(".ui-dialog:visible");
}

export function formatAvailabilityMessage(
  date: string,
  endDate: string,
  durationMinutes: number,
  availability: BookableAvailabilitySlot[] | Array<{ start: string; end: string }>,
): string {
  const candidates = [...availability].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, 50);
  if (candidates.length === 0) return `${date}〜${endDate}は、現在以降に${durationMinutes}分の打ち合わせを設定できる候補がありません。`;
  const lines = candidates.map((slot, index) => `${index + 1}. ${formatJapanDateTime(slot.start)}〜${formatJapanTime(slot.end)}（${durationMinutes}分）`);
  return `${date}〜${endDate}の候補は開始時刻順です。${availability.length > 50 ? "先頭50件を表示します。" : ""}\n${lines.join("\n")}\n「では、1で」のように番号で選択してください。会議室は登録済みの優先順位、メール送信と本人への通知はオンを初期値にします。`;
}

function japanDateFromInstant(value: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid slot date: ${value}`);
  }
  return `${year}-${month}-${day}`;
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  while (cursor.getTime() <= endMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (dates.length === 0 || dates.length > 31) throw new Error("Date range must contain 1 to 31 days.");
  return dates;
}

function readJapanClock(value: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
  const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error(`Invalid slot time: ${value}`);
  return { hour, minute };
}

function formatJapanTime(value: string): string {
  const { hour, minute } = readJapanClock(value);
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function formatJapanDateTime(value: string): string {
  const date = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
  return `${date} ${formatJapanTime(value)}`;
}


function assertPreparedParticipantDialog(page: Page, pageUrl: URL): void {
  const hash = new URLSearchParams(pageUrl.hash.replace(/^#/, ""));
  if (hash.get("cmd") !== "schadd") {
    throw new Error("Open an unsaved DeskNet's schedule form before starting the run.");
  }
  // This synchronous assertion is completed by the caller's first extraction,
  // which requires exactly one visible participant timeline table.
  void page;
}

function readRouteDate(pageUrl: URL): string {
  const hash = new URLSearchParams(pageUrl.hash.replace(/^#/, ""));
  const value = hash.get("date");
  if (value === null || !/^\d{8}$/.test(value)) {
    throw new Error("DeskNet's schedule form URL does not contain a valid date.");
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

async function closeSelectionDialog(page: Page, label: string): Promise<void> {
  const dialog = page.locator(".ui-dialog:visible");
  if ((await dialog.count()) !== 1) {
    throw new Error(`Expected one visible ${label} dialog.`);
  }
  const cancel = dialog
    .locator(".ui-dialog-buttonpane button")
    .filter({ hasText: "キャンセル" });
  if ((await cancel.count()) !== 1) {
    throw new Error(`${label} dialog cancel button was not found.`);
  }
  await cancel.click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  await page.waitForTimeout(300);
}

export async function recordFailure(directory: string, page: Page | undefined, phase: string, error: unknown): Promise<void> {
  // Diagnostics must never replace the original exception or include credentials.
  try {
    const state = page === undefined || page.isClosed() ? null : await Promise.race([page.evaluate(() => {
      const visible = (e: Element) => (e as HTMLElement).getClientRects().length > 0;
      return {
        command: new URLSearchParams(location.hash.slice(1)).get("cmd"),
        dates: Array.from(document.querySelectorAll<HTMLInputElement>(".jsch-startdate,.jsch-enddate")).map(e => ({value:e.value,visible:visible(e)})),
        dialogs: Array.from(document.querySelectorAll<HTMLElement>(".ui-dialog")).filter(visible).map(e => e.innerText.slice(0, 1500)),
      };
    }).catch(() => null), new Promise<null>(resolve => setTimeout(() => resolve(null), 2000))]);
    await writeFile(resolve(directory, `failure-${phase}.json`), JSON.stringify({
      at: new Date().toISOString(), phase, message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined, state,
    }, null, 2), {encoding:"utf8",mode:0o600});
    if (page !== undefined && !page.isClosed()) await page.screenshot({path:resolve(directory,`failure-${phase}.png`),timeout:3000}).catch(() => {});
  } catch { /* Failure reporting is best-effort. */ }
}

export async function discardPreparedForm(page: Page): Promise<void> {
  const dialog = page.locator(".ui-dialog:visible");
  if ((await dialog.count()) === 1) {
    const cancel = dialog
      .locator(".ui-dialog-buttonpane button")
      .filter({ hasText: "キャンセル" });
    if ((await cancel.count()) === 1) {
      await cancel.click();
      await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    }
  }

  // Do not depend on a generic CSS class or button order. Identify the
  // non-destructive control explicitly by its accessible name.
  const formCancel = page
    .getByRole("button", { name: "キャンセル", exact: true })
    .filter({ visible: true })
    .first();
  if ((await formCancel.count()) !== 1) {
    if ((await page.locator(".jsch-startdate:visible").count()) === 1) {
      throw new Error("The unsaved schedule form is open, but its Cancel button was not found.");
    }
    return;
  }
  await formCancel.click({ noWaitAfter: true });

  const visibleForm = page.locator(".jsch-startdate:visible");
  const confirmationYes = page
    .locator(".ui-dialog:visible")
    .getByRole("button", { name: "はい", exact: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await visibleForm.count()) === 0) return;
    if ((await confirmationYes.count()) === 1) {
      await confirmationYes.click({ noWaitAfter: true });
      await visibleForm.waitFor({ state: "hidden", timeout: 10_000 });
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("DeskNet's did not close the unsaved schedule form after Cancel.");
}

async function observe(
  page: Page,
  runId: string,
  filename: "before.png" | "after.png",
  artifactDirectory: string,
  summary: string,
  visibleElements: string[],
): Promise<Observation> {
  const screenshotPath = resolve(artifactDirectory, filename);
  let screenshotSummary = summary;
  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: false,
      animations: "disabled",
      timeout: 3_000,
    });
  } catch {
    await writeFile(screenshotPath, FALLBACK_SCREENSHOT);
    screenshotSummary = `${summary} Screenshot capture timed out; a placeholder artifact was recorded.`;
  }
  const url = new URL(page.url());
  return {
    id: `${runId}-${filename}`,
    capturedAt: new Date().toISOString(),
    pageUrl: `${url.origin}${url.pathname}?cmd=schindex#cmd=schadd`,
    pageTitle: await page.title(),
    screenshotRef: `/browser-agent/runs/${runId}/artifacts/${filename}`,
    visibleElements,
    summary: screenshotSummary,
  };
}

const FALLBACK_SCREENSHOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function assertLoopbackEndpoint(value: string): void {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname)
  ) {
    throw new Error("DESKNETS_CDP_ENDPOINT must be an HTTP loopback URL.");
  }
}

function readLimitsFromEnvironment(): RunLimits {
  const allowedDomains = (process.env.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  return {
    allowedDomains,
    maxSteps: readPositiveInteger(process.env.MAX_AGENT_STEPS, 30),
    maxRunDurationMs: readPositiveInteger(
      process.env.MAX_RUN_DURATION_MS,
      300_000,
    ),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function assertWithinDuration(startedAt: number, maximumMs: number): void {
  if (Date.now() - startedAt > maximumMs) {
    throw new Error("The browser run exceeded its maximum duration.");
  }
}
