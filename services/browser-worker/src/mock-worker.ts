import { randomUUID } from "node:crypto";
import {
  assertActionAllowed,
  assertRunAllowed,
  type BrowserAction,
  type BrowserRun,
  type Observation,
  type RunExecutor,
  type RunLimits,
} from "@azure-browser-agent/agent-core";

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
    const observationBefore = observeLandingPage();
    const action = planSingleAction(run.input.prompt);
    assertActionAllowed(action, this.limits);

    await pause(150, signal);
    assertWithinDuration(startedAt, this.limits.maxRunDurationMs);

    const observationAfter = observeSchedulePage();
    const step = {
      sequence: run.steps.length + 1,
      observationBefore,
      reasoning:
        "The schedule link is visible, so the safest next action is to open the read-only mock schedule page.",
      action,
      observationAfter,
      verified: observationAfter.visibleElements.includes("Schedule table"),
    };

    const now = new Date().toISOString();
    return {
      ...run,
      status: "completed",
      updatedAt: now,
      steps: [...run.steps, step],
      result: {
        summary:
          "The mock schedule page was opened and verified after one browser action.",
        evidence: [
          observationAfter.screenshotRef,
          `Page title: ${observationAfter.pageTitle}`,
          "Visible element: Schedule table",
        ],
      },
    };
  }
}

function planSingleAction(_prompt: string): BrowserAction {
  return { type: "open_page", url: "https://mock.local/schedule" };
}

function observeLandingPage(): Observation {
  return {
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    pageUrl: "https://mock.local/",
    pageTitle: "Mock Portal",
    screenshotRef: "mock://screenshots/landing.png",
    visibleElements: ["Schedule link", "User menu"],
    summary: "A mock portal landing page with a visible schedule link.",
  };
}

function observeSchedulePage(): Observation {
  return {
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    pageUrl: "https://mock.local/schedule",
    pageTitle: "Mock Schedule",
    screenshotRef: "mock://screenshots/schedule.png",
    visibleElements: ["Schedule table", "Date range", "Participant selector"],
    summary: "The read-only mock schedule page is visible.",
  };
}

function assertWithinDuration(startedAt: number, maximumMs: number): void {
  if (Date.now() - startedAt > maximumMs) {
    throw new Error("The browser run exceeded its maximum duration.");
  }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Run cancelled."));
      },
      { once: true },
    );
  });
}
