import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  type RunExecutor,
  type RunLimits,
} from "@azure-browser-agent/agent-core";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  extractFacilitySchedules,
  extractParticipantSchedules,
} from "./desknets-dom.js";

interface DeskNetsWorkerOptions {
  cdpEndpoint?: string;
  limits?: RunLimits;
}

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

export class DeskNetsBrowserWorker implements RunExecutor {
  private readonly cdpEndpoint: string;
  private readonly limits: RunLimits;
  private browserConnection: Promise<Browser> | undefined;

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
    try {
      page = await findSingleDeskNetsPage(browser, this.limits);
      const pageUrl = new URL(page.url());
      assertActionAllowed({ type: "open_page", url: pageUrl.href }, this.limits);
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
        preservePreparedForm = true;
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
    } finally {
      if (page !== undefined && !preservePreparedForm) {
        await discardPreparedForm(page);
      }
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browserConnection === undefined) {
      const connection = chromium.connectOverCDP(this.cdpEndpoint);
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
  const { run, task, page, signal, limits, artifactDirectory, startedAt } = context;
  await ensureScheduleList(page);
  signal.throwIfAborted();
  const action: BrowserAction = { type: "click", target: "利用設備" };
  assertActionAllowed(action, limits, "read");
  const dates = enumerateDates(task.date, task.endDate);
  const participantAvailability: BookableAvailabilitySlot[] = [];
  const availability: BookableAvailabilitySlot[] = [];
  let participantIds: string[] = [];
  let participantRowCount = 0;
  let facilityRowCount = 0;
  let observationBefore: Observation | undefined;
  let observationAfter: Observation | undefined;

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index] as string;
    if (index > 0) {
      await discardPreparedForm(page);
      await ensureScheduleList(page);
    }
    await openAvailabilityForm(page, { ...task, date, endDate: date });
    const dayStart = `${date}T00:00:00+09:00`;
    const participantSchedules = await extractParticipantSchedules(page.locator("body"), dayStart);
    participantRowCount = participantSchedules.length;
    if (participantRowCount !== task.participantNames.length + 1) {
      throw new Error(`Expected ${task.participantNames.length + 1} participant rows, found ${participantRowCount}.`);
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
    const facilitySchedules = deduplicateFacilitySchedules(
      await extractFacilitySchedules(page.locator("body"), dayStart),
    );
    facilityRowCount = facilitySchedules.length;
    if (index === dates.length - 1) {
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
      window: { start: `${date}T08:00:00+09:00`, end: `${date}T18:00:00+09:00` },
      durationMinutes: task.durationMinutes,
      incrementMinutes: 30,
      schedules: participantSchedules,
    };
    participantAvailability.push(
      ...filterFutureAvailability(findCommonAvailability(availabilityRequest)).map((slot) => ({
        ...slot,
        availableFacilityIds: [],
      })),
    );
    availability.push(...filterFutureAvailability(findBookableAvailability({
      ...availabilityRequest,
      facilities: facilitySchedules,
    })));
    assertWithinDuration(startedAt, limits.maxRunDurationMs);
    signal.throwIfAborted();
  }
  if (observationBefore === undefined || observationAfter === undefined) {
    throw new Error("The requested date range produced no observable schedule data.");
  }
  assertWithinDuration(startedAt, limits.maxRunDurationMs);
  signal.throwIfAborted();

  const pendingBooking = {
    date: task.date,
    endDate: task.endDate,
    durationMinutes: task.durationMinutes,
    participantNames: task.participantNames,
    ...(task.title === undefined ? {} : { title: task.title }),
    participantIds,
    availability,
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
        participantAvailability,
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
  const { run, task, page, signal, limits, artifactDirectory } = context;
  const pending = run.context;
  if (pending === undefined) throw new Error("Pending booking context is missing.");
  await assertPreparedBookingForm(page, pending.participantIds);

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
  await fillBookingForm(page, task, slot, facilityId, selectedDate);

  const observationBefore = await observe(
    page,
    run.id,
    "before.png",
    artifactDirectory,
    `Prepared ${task.title === "" ? "an editable blank agenda" : task.title}, ${formatJapanDateTime(slot.start)}-${formatJapanTime(slot.end)}, ${facilityId}, with email notification ${task.sendEmail ? "enabled" : "disabled"} and self-notification suppression disabled.`,
    ["Meeting title", "Date and time", "Participants", "Facility", "Email notification"],
  );
  const windowFocused = await bringPreparedFormToFront(page);
  const preparationAction: BrowserAction = {
    type: "type_text",
    target: "予定フォーム",
    text: task.title,
  };
  assertActionAllowed(preparationAction, limits, "write");
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
          "Prepare the DeskNet's booking form and hand the final Add action to the user without clicking it automatically.",
        action: preparationAction,
        observationAfter: observationBefore,
        verified: true,
      },
    ],
    result: {
      summary: "Prepared the DeskNet's booking form for manual submission.",
      assistantMessage: task.title === ""
        ? `DeskNet'sの予約画面を${windowFocused ? "最前面に表示しました" : "専用Edgeに開きました"}。議題を入力し、日時・登録先・利用設備・メール設定を確認してから、DeskNet's上の「追加」を押してください。Agentは追加を押しません。`
        : `DeskNet'sの予約画面を${windowFocused ? "最前面に表示し" : "専用Edgeに開き"}、議題「${task.title}」を転記しました。内容を確認してから、DeskNet's上の「追加」を押してください。Agentは追加を押しません。`,
      evidence: [observationBefore.screenshotRef],
      manualActionRequest: {
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

async function bringPreparedFormToFront(page: Page): Promise<boolean> {
  await page.bringToFront();
  if (process.platform !== "win32") return true;

  const processIdPath = resolve(
    import.meta.dirname,
    "../../..",
    ".auth",
    "desknets-edge.pid",
  );
  let processId: number;
  try {
    processId = Number.parseInt((await readFile(processIdPath, "utf8")).trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(processId) || processId <= 0) return false;

  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeskNetsWindowFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$targetProcessId = [int]$env:DESKNETS_EDGE_PROCESS_ID
$target = Get-Process -Id $targetProcessId -ErrorAction Stop
if ($target.MainWindowHandle -eq 0) { exit 2 }
[void][DeskNetsWindowFocus]::ShowWindowAsync($target.MainWindowHandle, 9)
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate($targetProcessId)
Start-Sleep -Milliseconds 100
if ([DeskNetsWindowFocus]::SetForegroundWindow($target.MainWindowHandle)) { exit 0 }
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

async function ensureScheduleList(page: Page): Promise<void> {
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
  await page.getByText("氏名/組織名", { exact: true }).filter({ visible: true }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

async function openAvailabilityForm(page: Page, task: FindAvailabilityTask): Promise<void> {
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

  for (const name of task.participantNames) {
    const rows = dialog.locator("tr");
    let addControl;
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      if (!(await row.innerText()).includes(name)) continue;
      const candidate = row.getByText("追加", { exact: true });
      if ((await candidate.count()) === 1 && (await candidate.isVisible())) {
        if (addControl !== undefined) throw new Error(`Participant name is ambiguous: ${name}`);
        addControl = candidate;
      }
    }
    if (addControl === undefined) throw new Error(`Participant was not found: ${name}`);
    await addControl.click({ noWaitAfter: true });
    await page.waitForTimeout(350);
  }
  const expectedRows = task.participantNames.length + 1;
  const selectedRows = dialog.locator(".co-sel-bottom table tbody tr");
  if ((await selectedRows.count()) !== expectedRows) {
    throw new Error(`Expected ${expectedRows} selected participant rows.`);
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
  for (const selector of [".jsch-startdate:visible", ".jsch-enddate:visible"]) {
    const input = page.locator(selector);
    await input.fill(displayDate);
    await input.press("Tab");
  }
  await page.waitForTimeout(300);
}

async function openFacilityDialog(page: Page): Promise<void> {
  const chooser = page
    .locator("a.jsch-entry-target-chooser:visible")
    .filter({ hasText: "利用設備" });
  if ((await chooser.count()) !== 1) throw new Error("Facility chooser was not found.");
  await chooser.click({ noWaitAfter: true });
  await page
    .locator(".ui-dialog:visible .sch-entry-plant-reserve-list table tbody tr")
    .first()
    .waitFor({ state: "attached", timeout: 10_000 });
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

async function selectExactFacility(dialog: Locator, facilityId: string): Promise<void> {
  const room = dialog.getByText(facilityId, { exact: true });
  if ((await room.count()) !== 1) throw new Error(`Facility row was not found: ${facilityId}`);

  const checkbox = room
    .locator("xpath=ancestor::tr[1]")
    .locator('input[type="checkbox"]');
  if ((await checkbox.count()) !== 1) {
    throw new Error(`Facility checkbox was not found: ${facilityId}`);
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
    if (await checkbox.isChecked()) return;
    await checkbox.evaluate((element) => {
      const input = element as HTMLInputElement;
      if (!input.checked) input.click();
    });
    if (!(await checkbox.isChecked())) throw error;
  }
  if (!(await checkbox.isChecked())) {
    throw new Error(`Facility checkbox did not stay selected: ${facilityId}`);
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
  const actualTimes = [
    await hours.nth(0).locator("option:checked").innerText(),
    await minutes.nth(0).locator("option:checked").innerText(),
    await hours.nth(1).locator("option:checked").innerText(),
    await minutes.nth(1).locator("option:checked").innerText(),
  ];
  if (actualTimes.some((value, index) => value.trim() !== expectedTimes[index])) {
    throw new Error("The prepared meeting time changed before approval.");
  }

  const body = await page.locator("body").innerText();
  if (!body.includes(facilityId)) throw new Error("The prepared facility changed before approval.");
  const checkboxes = page.locator('input[type="checkbox"]:visible');
  let emailIsChecked: boolean | undefined;
  for (let index = 0; index < (await checkboxes.count()); index += 1) {
    const checkbox = checkboxes.nth(index);
    if ((await checkbox.locator("..").innerText()).trim() === "メール") {
      emailIsChecked = await checkbox.isChecked();
    }
  }
  if (emailIsChecked === undefined) throw new Error("Email notification checkbox is missing.");
  if (emailIsChecked !== task.sendEmail) {
    throw new Error("Email notification choice changed before approval.");
  }
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

async function confirmFinalRegistrationIfNeeded(page: Page): Promise<void> {
  const dialog = page.locator(".ui-dialog:visible").filter({ hasText: "確認" });
  if ((await dialog.count()) !== 1) return;
  const yes = dialog.getByText("はい", { exact: true });
  if ((await yes.count()) !== 1) throw new Error("Final confirmation dialog is missing Yes.");
  await yes.click({ noWaitAfter: true });
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}

async function verifyCreatedAppointment(
  page: Page,
  title: string,
  slot: BookableAvailabilitySlot,
  facilityId: string,
  participantIds: string[],
): Promise<boolean> {
  await page.waitForTimeout(800);
  const expectedTime = `${formatJapanTime(slot.start)} - ${formatJapanTime(slot.end)}`;
  const candidates = page
    .locator('a[href*="schreferdtl"]:visible')
    .filter({ hasText: title })
    .filter({ hasText: expectedTime });
  if ((await candidates.count()) !== 1) return false;
  await candidates.click({ noWaitAfter: true });
  await page.waitForTimeout(600);
  const detail = await page.locator("body").innerText();
  return (
    detail.includes(title) &&
    detail.includes(facilityId) &&
    participantIds.every((participantId) => detail.includes(participantId))
  );
}

function formatAvailabilityMessage(
  date: string,
  endDate: string,
  durationMinutes: number,
  availability: BookableAvailabilitySlot[] | Array<{ start: string; end: string }>,
): string {
  const ranges = availability
    .map((slot) => ({ start: Date.parse(slot.start), end: Date.parse(slot.end) }))
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || interval.start > previous.end) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  const dateLabel = date === endDate
    ? `${Number.parseInt(date.slice(5, 7), 10)}月${Number.parseInt(date.slice(8, 10), 10)}日`
    : `${Number.parseInt(date.slice(5, 7), 10)}月${Number.parseInt(date.slice(8, 10), 10)}日〜${Number.parseInt(endDate.slice(5, 7), 10)}月${Number.parseInt(endDate.slice(8, 10), 10)}日`;
  if (merged.length === 0) {
    return `${dateLabel}は、現在以降に${durationMinutes}分の打ち合わせを設定できる候補がありません。`;
  }
  const labels = merged.map((interval) => {
    const start = new Date(interval.start).toISOString();
    const end = new Date(interval.end).toISOString();
    return date === endDate
      ? `${formatJapanTime(start)}〜${formatJapanTime(end)}`
      : `${formatJapanDateTime(start)}〜${formatJapanTime(end)}`;
  });
  return `はい。${dateLabel}は、現在以降では${labels.join("、")}の範囲で${durationMinutes}分の打ち合わせを設定可能です。日付を開いて候補を確認するか、日時・会議室・メール送信有無を直接指定してください。`;
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

async function findSingleDeskNetsPage(
  browser: Browser,
  limits: RunLimits,
): Promise<Page> {
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => {
      try {
        const hostname = new URL(page.url()).hostname.toLowerCase();
        return limits.allowedDomains.some(
          (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
        );
      } catch {
        return false;
      }
    });
  if (pages.length !== 1) {
    throw new Error(
      `Expected exactly one allowed DeskNet's tab, found ${pages.length}. Close extra tabs before starting the run.`,
    );
  }
  return pages[0] as Page;
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

async function discardPreparedForm(page: Page): Promise<void> {
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

  const formCancel = page.locator("input.jco-input-list-page:visible").first();
  if ((await formCancel.count()) !== 1) return;
  await formCancel.click();
  await page.waitForTimeout(400);
  const confirmation = page.locator(".ui-dialog:visible").filter({ hasText: "確認" });
  if ((await confirmation.count()) === 1) {
    await confirmation.getByRole("button", { name: "はい", exact: true }).click();
  }
  await page
    .locator(".jsch-startdate:visible")
    .waitFor({ state: "hidden", timeout: 5_000 });
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
