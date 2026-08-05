import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertActionAllowed,
  assertRunAllowed,
  type BrowserAction,
  type BrowserRun,
  type Observation,
  type RunExecutor,
  type RunLimits,
} from "@azure-browser-agent/agent-core";
import { chromium, type Page } from "playwright";

const DEFAULT_LIMITS: RunLimits = {
  allowedDomains: ["mock.local"],
  maxSteps: 30,
  maxRunDurationMs: 300_000,
};

export class MockBrowserWorker implements RunExecutor {
  constructor(private readonly limits: RunLimits = DEFAULT_LIMITS) {}

  async execute(run: BrowserRun, signal: AbortSignal): Promise<BrowserRun> {
    assertRunAllowed(run, this.limits);
    signal.throwIfAborted();

    if (run.input.site !== "mock") {
      throw new Error(
        "DeskNet's execution is not enabled yet. Use the mock site for this milestone.",
      );
    }

    const startedAt = Date.now();
    const artifactDirectory = resolve(process.cwd(), "screenshots", run.id);
    await mkdir(artifactDirectory, { recursive: true });

    const browser = await chromium.launch({ headless: readHeadlessSetting() });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      await page.setContent(MOCK_PORTAL_HTML, { waitUntil: "domcontentloaded" });
      const observationBefore = await observe(
        page,
        run.id,
        "before.png",
        artifactDirectory,
      );

      const action = planSingleAction(run.input.prompt);
      assertActionAllowed(action, this.limits);
      signal.throwIfAborted();
      await executeAction(page, action);
      await page.getByRole("heading", { name: "Team schedule" }).waitFor();
      assertWithinDuration(startedAt, this.limits.maxRunDurationMs);

      const observationAfter = await observe(
        page,
        run.id,
        "after.png",
        artifactDirectory,
      );
      const verified = observationAfter.visibleElements.includes("Schedule table");
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
              "The schedule link is visible, so the safest next action is one DOM-backed click into the read-only schedule.",
            action,
            observationAfter,
            verified,
          },
        ],
        result: {
          summary: verified
            ? "Chromium opened the mock schedule and verified its visible table."
            : "Chromium completed the action, but the expected table was not verified.",
          evidence: [
            observationBefore.screenshotRef,
            observationAfter.screenshotRef,
            `Page title: ${observationAfter.pageTitle}`,
          ],
        },
      };
    } finally {
      await browser.close();
    }
  }
}

function planSingleAction(_prompt: string): BrowserAction {
  return { type: "click", target: "Schedule link" };
}

async function executeAction(page: Page, action: BrowserAction): Promise<void> {
  if (action.type !== "click" || action.target !== "Schedule link") {
    throw new Error(`Unsupported mock action: ${action.type}`);
  }
  await page.getByRole("link", { name: "Schedule" }).click();
}

async function observe(
  page: Page,
  runId: string,
  filename: "before.png" | "after.png",
  artifactDirectory: string,
): Promise<Observation> {
  await page.screenshot({
    path: resolve(artifactDirectory, filename),
    fullPage: true,
  });
  const visibleElements = await page
    .locator("[data-agent-label]:visible")
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute("data-agent-label"))
        .filter((label): label is string => label !== null),
    );
  const pageTitle = await page.title();

  return {
    id: `${runId}-${filename}`,
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    pageTitle,
    screenshotRef: `/browser-agent/runs/${runId}/artifacts/${filename}`,
    visibleElements,
    summary:
      filename === "before.png"
        ? "Chromium captured the mock portal with its schedule link."
        : "Chromium captured the read-only team schedule after the click.",
  };
}

function assertWithinDuration(startedAt: number, maximumMs: number): void {
  if (Date.now() - startedAt > maximumMs) {
    throw new Error("The browser run exceeded its maximum duration.");
  }
}

function readHeadlessSetting(): boolean {
  return process.env.BROWSER_HEADLESS?.toLowerCase() !== "false";
}

const MOCK_PORTAL_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Mock Portal</title>
    <style>
      :root { font-family: Inter, system-ui, sans-serif; color: #172235; background: #edf3f9; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      header { height: 72px; display: flex; align-items: center; justify-content: space-between; padding: 0 42px; background: #10243d; color: white; }
      header strong { font-size: 21px; }
      main { width: min(980px, calc(100% - 48px)); margin: 48px auto; }
      .eyebrow { color: #52708f; text-transform: uppercase; letter-spacing: .12em; font-size: 12px; font-weight: 800; }
      h1 { margin: 8px 0 10px; font-size: 42px; }
      p { color: #60738a; line-height: 1.6; }
      .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 32px; }
      .card { min-height: 180px; padding: 24px; border-radius: 18px; background: white; box-shadow: 0 16px 48px rgba(27,55,88,.1); }
      .card a { display: inline-block; margin-top: 24px; padding: 11px 18px; border-radius: 10px; background: #1677d2; color: white; text-decoration: none; font-weight: 800; }
      table { width: 100%; margin-top: 28px; border-collapse: collapse; border-radius: 14px; overflow: hidden; background: white; box-shadow: 0 16px 48px rgba(27,55,88,.1); }
      th, td { padding: 17px; text-align: left; border-bottom: 1px solid #dce6f0; }
      th { background: #e2eef9; color: #284767; }
      .free { color: #087d52; font-weight: 800; }
      .busy { color: #a23b4a; font-weight: 800; }
    </style>
  </head>
  <body>
    <header><strong>Northwind Workspace</strong><span data-agent-label="User menu">PoC User ▾</span></header>
    <main id="content">
      <div class="eyebrow">Mock intranet</div>
      <h1>Good afternoon</h1>
      <p>This isolated page contains no external content or network requests.</p>
      <div class="cards">
        <section class="card"><h2>Schedule</h2><p>Review team availability.</p><a href="#schedule" data-agent-label="Schedule link">Schedule</a></section>
        <section class="card"><h2>Messages</h2><p>12 unread messages.</p></section>
        <section class="card"><h2>Documents</h2><p>Recently shared files.</p></section>
      </div>
    </main>
    <template id="schedule-template">
      <div class="eyebrow">Read-only view</div>
      <h1 data-agent-label="Schedule heading">Team schedule</h1>
      <p data-agent-label="Date range">Wednesday, August 5 · 09:00–18:00</p>
      <table data-agent-label="Schedule table">
        <thead><tr><th>Participant</th><th>09:00–10:00</th><th>10:00–11:00</th><th>11:00–12:00</th></tr></thead>
        <tbody>
          <tr><td>A</td><td class="free">Free</td><td class="busy">Busy</td><td class="free">Free</td></tr>
          <tr><td>B</td><td class="free">Free</td><td class="free">Free</td><td class="busy">Busy</td></tr>
          <tr><td>C</td><td class="free">Free</td><td class="busy">Busy</td><td class="free">Free</td></tr>
        </tbody>
      </table>
    </template>
    <script>
      document.querySelector('a[href="#schedule"]').addEventListener("click", () => {
        document.title = "Mock Schedule";
        document.querySelector("#content").innerHTML = document.querySelector("#schedule-template").innerHTML;
      });
    </script>
  </body>
</html>`;
