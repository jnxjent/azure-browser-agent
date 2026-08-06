import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertActionAllowed,
  assertRunAllowed,
  findBookableAvailability,
  type BrowserAction,
  type BrowserRun,
  type Observation,
  type RunExecutor,
  type RunLimits,
} from "@azure-browser-agent/agent-core";
import { chromium, type Browser, type Page } from "playwright";
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

    const browser = await chromium.connectOverCDP(this.cdpEndpoint);
    let page: Page | undefined;
    try {
      page = await findSingleDeskNetsPage(browser, this.limits);
      const pageUrl = new URL(page.url());
      assertActionAllowed({ type: "open_page", url: pageUrl.href }, this.limits);
      assertPreparedParticipantDialog(page, pageUrl);

      const date = readRouteDate(pageUrl);
      const dayStart = `${date}T00:00:00+09:00`;
      const participantSchedules = await extractParticipantSchedules(
        page.locator("body"),
        dayStart,
      );
      if (participantSchedules.length < 2) {
        throw new Error(
          "Select at least two participants in the open 登録先 dialog before starting the run.",
        );
      }

      const observationBefore = await observe(
        page,
        run.id,
        "before.png",
        artifactDirectory,
        `Verified ${participantSchedules.length} selected participant rows.`,
        ["Participant selector", "Participant availability grid"],
      );

      await closeSelectionDialog(page, "登録先");
      const action: BrowserAction = { type: "click", target: "利用設備" };
      assertActionAllowed(action, this.limits);
      signal.throwIfAborted();
      await page
        .locator("a.jsch-entry-target-chooser:visible")
        .filter({ hasText: "利用設備" })
        .click();
      await page
        .locator(".ui-dialog:visible .sch-entry-plant-reserve-list table tbody tr")
        .first()
        .waitFor({ state: "attached", timeout: 10_000 });

      const facilitySchedules = await extractFacilitySchedules(
        page.locator("body"),
        dayStart,
      );
      const observationAfter = await observe(
        page,
        run.id,
        "after.png",
        artifactDirectory,
        `Verified ${facilitySchedules.length} company-wide facility rows.`,
        ["Facility selector", "Facility availability grid"],
      );

      const availability = findBookableAvailability({
        window: {
          start: `${date}T08:00:00+09:00`,
          end: `${date}T18:00:00+09:00`,
        },
        durationMinutes: 60,
        incrementMinutes: 30,
        schedules: participantSchedules,
        facilities: facilitySchedules,
      });
      assertWithinDuration(startedAt, this.limits.maxRunDurationMs);
      signal.throwIfAborted();

      const verified =
        participantSchedules.length >= 2 && facilitySchedules.length > 0;
      const now = new Date().toISOString();
      return {
        ...run,
        status: "completed",
        updatedAt: now,
        steps: [
          ...run.steps,
          {
            sequence: run.steps.length + 1,
            observationBefore,
            reasoning:
              "The prepared participant grid is visible. Read it, then inspect company-wide facilities without submitting the schedule form.",
            action,
            observationAfter,
            verified,
          },
        ],
        result: {
          summary: `DeskNet's verified ${participantSchedules.length} participants and ${facilitySchedules.length} facilities, and found ${availability.length} bookable one-hour slots.`,
          evidence: [
            observationBefore.screenshotRef,
            observationAfter.screenshotRef,
            `Participant rows: ${participantSchedules.length}`,
            `Facility rows: ${facilitySchedules.length}`,
          ],
          availability,
        },
      };
    } finally {
      if (page !== undefined) {
        await discardPreparedForm(page);
      }
      await browser.close();
    }
  }
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
  await page.screenshot({
    path: resolve(artifactDirectory, filename),
    fullPage: true,
  });
  const url = new URL(page.url());
  return {
    id: `${runId}-${filename}`,
    capturedAt: new Date().toISOString(),
    pageUrl: `${url.origin}${url.pathname}?cmd=schindex#cmd=schadd`,
    pageTitle: await page.title(),
    screenshotRef: `/browser-agent/runs/${runId}/artifacts/${filename}`,
    visibleElements,
    summary,
  };
}

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
