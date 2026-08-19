import type { BrowserAction, BrowserRun, RunLimits } from "./contracts.js";

export class PolicyViolationError extends Error {
  override readonly name = "PolicyViolationError";
}

export function assertRunAllowed(run: BrowserRun, limits: RunLimits): void {
  if (
    run.input.mode === "write" &&
    (run.task?.type !== "book_meeting" || run.context === undefined)
  ) {
    throw new PolicyViolationError(
      "Write runs require an explicit booking instruction and pending availability context.",
    );
  }

  if (run.steps.length >= limits.maxSteps) {
    throw new PolicyViolationError("The run exceeded its maximum step count.");
  }
}

export function assertActionAllowed(
  action: BrowserAction,
  limits: RunLimits,
  mode: "read" | "write" = "read",
  explicitlyApproved = false,
): void {
  if (
    action.type === "click" &&
    ["追加", "登録", "保存", "送信", "削除", "submit"].includes(
      action.target.trim().toLowerCase(),
    ) &&
    (mode !== "write" || !explicitlyApproved)
  ) {
    throw new PolicyViolationError(
      `Explicit final approval is required for action: ${action.target}`,
    );
  }

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
