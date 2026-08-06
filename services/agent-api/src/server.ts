import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRun,
  validateCreateRunInput,
  type BrowserRun,
} from "@azure-browser-agent/agent-core";
import {
  DeskNetsBrowserWorker,
  MockBrowserWorker,
} from "@azure-browser-agent/browser-worker";

const runs = new Map<string, BrowserRun>();
const controllers = new Map<string, AbortController>();
const mockWorker = new MockBrowserWorker();
const deskNetsWorker = new DeskNetsBrowserWorker();

export const server = createServer(async (request, response) => {
  setCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
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
    request.method === "POST" &&
    segments.length === 2 &&
    segments[0] === "browser-agent" &&
    segments[1] === "runs"
  ) {
    const input = validateCreateRunInput(await readJsonBody(request));
    const run = createRun(input);
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
      sendJson(response, 409, {
        error: "This read-only milestone does not create approval requests.",
      });
      return;
    }
  }

  sendJson(response, 404, { error: "Route not found." });
}

function startRun(runId: string): void {
  const run = runs.get(runId);
  if (run === undefined) {
    return;
  }

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
  void worker
    .execute(running, controller.signal)
    .then((completed) => runs.set(runId, completed))
    .catch((error: unknown) => {
      const current = runs.get(runId);
      if (current?.status === "cancelled") {
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      if (current !== undefined) {
        runs.set(runId, {
          ...current,
          status: "failed",
          updatedAt: new Date().toISOString(),
          error: message,
        });
      }
    })
    .finally(() => controllers.delete(runId));
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
