import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const usage = `Usage:
  npm run auth:desknets -- https://your-desknets.example/path

Opens Microsoft Edge with a dedicated local profile and a loopback-only DevTools
port. Log in manually in Edge. Credentials are never read by the application,
and the profile is stored under the Git-ignored .auth directory.`;

const urlArgument = process.argv[2];
if (urlArgument === undefined || urlArgument === "--help") {
  console.log(usage);
  process.exit(urlArgument === "--help" ? 0 : 1);
}

if (process.platform !== "win32") {
  throw new Error("The DeskNet's Edge session helper currently supports Windows only.");
}

const startUrl = readStartUrl(urlArgument);
const port = readPort(process.env.DESKNETS_CDP_PORT, 9222);
const projectDirectory = resolve(import.meta.dirname, "../../..");
const profileDirectory = resolve(projectDirectory, ".auth", "desknets-edge-cdp-profile");
const edgeExecutable =
  process.env.EDGE_EXECUTABLE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

await access(edgeExecutable, constants.X_OK);
await mkdir(profileDirectory, { recursive: true });

const edge = spawn(
  edgeExecutable,
  [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    startUrl.href,
  ],
  { stdio: "inherit", windowsHide: false },
);

const exited = once(edge, "exit").then(([code, signal]) => ({
  code: typeof code === "number" ? code : null,
  signal: typeof signal === "string" ? signal : null,
}));

const startup = await Promise.race([
  waitForDevTools(port).then(() => ({ kind: "ready" as const })),
  exited.then((result) => ({ kind: "exit" as const, result })),
]);

if (startup.kind === "exit") {
  throw new Error(
    `Edge exited before the DevTools endpoint became ready (code=${startup.result.code}, signal=${startup.result.signal}).`,
  );
}

console.log(`DeskNet's Edge session is ready at http://127.0.0.1:${port}.`);
console.log("Log in manually and leave this Edge window open while the PoC is running.");
const result = await exited;
if (result.code !== 0 && result.code !== null) {
  process.exitCode = result.code;
}

async function waitForDevTools(portNumber: number): Promise<void> {
  const endpoint = `http://127.0.0.1:${portNumber}/json/version`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // Edge may need a few seconds before the loopback endpoint is available.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Edge DevTools endpoint did not become ready: ${endpoint}`);
}

function readStartUrl(value: string): URL {
  let result: URL;
  try {
    result = new URL(value);
  } catch {
    throw new TypeError("DeskNet's URL must be an absolute URL.");
  }

  const isLocalhost = result.hostname === "localhost" || result.hostname === "127.0.0.1";
  if (result.protocol !== "https:" && !isLocalhost) {
    throw new TypeError("DeskNet's URL must use HTTPS.");
  }
  if (result.username !== "" || result.password !== "") {
    throw new TypeError("Do not include credentials in the DeskNet's URL.");
  }
  return result;
}

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const portNumber = Number.parseInt(value, 10);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new TypeError(`Invalid DESKNETS_CDP_PORT: ${value}`);
  }
  return portNumber;
}
