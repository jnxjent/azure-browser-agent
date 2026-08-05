import type { BrowserAction, BrowserRun, RunLimits } from "./contracts.js";

export class PolicyViolationError extends Error {
  override readonly name = "PolicyViolationError";
}

export function assertRunAllowed(run: BrowserRun, limits: RunLimits): void {
  if (run.input.mode !== "read") {
    throw new PolicyViolationError(
      "The initial PoC only permits read-only runs.",
    );
  }

  if (run.steps.length >= limits.maxSteps) {
    throw new PolicyViolationError("The run exceeded its maximum step count.");
  }
}

export function assertActionAllowed(
  action: BrowserAction,
  limits: RunLimits,
): void {
  if (action.type !== "open_page") {
    return;
  }

  const hostname = new URL(action.url).hostname.toLowerCase();
  const allowed = limits.allowedDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );

  if (!allowed) {
    throw new PolicyViolationError(`Domain is not allowed: ${hostname}`);
  }
}
