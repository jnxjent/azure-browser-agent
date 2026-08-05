import { randomUUID } from "node:crypto";
import type { BrowserRun, CreateRunInput } from "./contracts.js";

export function createRun(input: CreateRunInput): BrowserRun {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    input,
    status: "queued",
    steps: [],
  };
}

export function validateCreateRunInput(value: unknown): CreateRunInput {
  if (!isRecord(value)) {
    throw new TypeError("Request body must be a JSON object.");
  }

  const prompt = readRequiredString(value, "prompt");
  const userId = readOptionalString(value, "userId") ?? "poc-user";
  const threadId = readOptionalString(value, "threadId") ?? randomUUID();
  const site = value.site ?? "mock";
  const mode = value.mode ?? "read";

  if (site !== "mock" && site !== "desknets") {
    throw new TypeError("site must be either 'mock' or 'desknets'.");
  }

  if (mode !== "read" && mode !== "write") {
    throw new TypeError("mode must be either 'read' or 'write'.");
  }

  return { userId, threadId, site, prompt, mode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const result = readOptionalString(value, key);
  if (result === undefined) {
    throw new TypeError(`${key} must be a non-empty string.`);
  }
  return result;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new TypeError(`${key} must be a non-empty string.`);
  }
  return candidate.trim();
}
