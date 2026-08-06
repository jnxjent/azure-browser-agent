export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_user_input",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunMode = "read" | "write";

export type BrowserAction =
  | { type: "open_page"; url: string }
  | { type: "click"; target: string }
  | { type: "type_text"; target: string; text: string }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "wait"; milliseconds: number };

export interface Observation {
  id: string;
  capturedAt: string;
  pageUrl: string;
  pageTitle: string;
  screenshotRef: string;
  visibleElements: string[];
  summary: string;
}

export interface RunStep {
  sequence: number;
  observationBefore: Observation;
  reasoning: string;
  action: BrowserAction;
  observationAfter: Observation;
  verified: boolean;
}

export interface CreateRunInput {
  userId: string;
  threadId: string;
  site: "mock" | "desknets";
  prompt: string;
  mode: RunMode;
}

export interface BrowserRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  input: CreateRunInput;
  status: RunStatus;
  steps: RunStep[];
  result?: {
    summary: string;
    evidence: string[];
    availability?: CommonAvailabilitySlot[];
  };
  error?: string;
}

export interface RunLimits {
  allowedDomains: string[];
  maxSteps: number;
  maxRunDurationMs: number;
}

export interface RunExecutor {
  execute(run: BrowserRun, signal: AbortSignal): Promise<BrowserRun>;
}
import type { CommonAvailabilitySlot } from "./availability.js";
