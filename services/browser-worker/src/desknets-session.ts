import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { ensureSingleDeskNetsTab } from "./desknets-tabs.js";

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
const processIdFile = resolve(projectDirectory, ".auth", "desknets-edge.pid");
const edgeExecutable =
  process.env.EDGE_EXECUTABLE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// Running the login command again must reuse Edge rather than launch it with
// another URL argument (which opens a duplicate tab in an existing profile).
const existingSession = await fetch(`http://127.0.0.1:${port}/json/version`, {
  signal: AbortSignal.timeout(2_000),
}).then((response) => response.ok).catch(() => false);
if (existingSession) {
  await reuseScheduleTab();
  console.log(`既存のDeskNet's専用Edgeを再利用しました（ポート${port}）。`);
  process.exit(0);
}

await access(edgeExecutable, constants.X_OK);
await mkdir(profileDirectory, { recursive: true });

const edge = spawn(
  edgeExecutable,
  [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    "about:blank",
  ],
  // The interactive browser must outlive this command and its terminal.
  { stdio: "ignore", detached: true, windowsHide: false },
);
edge.unref();

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

const edgeProcessId = edge.pid;
if (edgeProcessId === undefined) {
  throw new Error("Could not determine the dedicated Edge process ID.");
}
await writeFile(processIdFile, `${edgeProcessId}\n`, "utf8");
const needsManualAuthentication = await reuseScheduleTab();
if (!needsManualAuthentication) {
  // A native prompt is optional; failure to inspect it must not terminate Edge.
  await clickNativeEdgeSignIn(edgeProcessId).catch(() => {
    console.log("Edgeのサインイン画面が表示されている場合は手動で操作してください。");
  });
}

console.log(`DeskNet's Edge session is ready at http://127.0.0.1:${port}.`);
console.log("Log in manually and leave this Edge window open while the PoC is running.");
console.log("起動コマンドは終了します。専用Edgeは独立して動作しますので、ウィンドウを開いたままにしてください。");

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

async function reuseScheduleTab(): Promise<boolean> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let needsManualAuthentication = false;
  try {
    let page = await ensureSingleDeskNetsTab(browser, [startUrl.hostname]);
    if (page === undefined) {
      const context = browser.contexts()[0];
      if (context === undefined) throw new Error("専用Edgeのブラウザコンテキストが見つかりません。");
      page = context.pages().find((candidate) => candidate.url() === "about:blank") ?? await context.newPage();
      try {
        const response = await page.goto(startUrl.href);
        needsManualAuthentication = response?.status() === 401 || response?.status() === 407;
      } catch (error) {
        if (!(error instanceof Error) || !/net::ERR_(?:INVALID_AUTH_CREDENTIALS|MISSING_AUTH_CREDENTIALS)/.test(error.message)) {
          throw error;
        }
        needsManualAuthentication = true;
      }
    }
    await page.bringToFront();
    if (needsManualAuthentication) {
      console.log("DeskNet'sへのアクセスに認証が必要です。専用Edgeは開いたままにします。");
      console.log(`専用Edgeのアドレスバーに次のURLを貼り付けてEnterを押し、表示される認証画面を手動で操作してください: ${startUrl.href}`);
      console.log("認証情報はチャットや.env.localに入力せず、ブラウザの認証画面で入力してください。");
    }
    return needsManualAuthentication;
  } finally {
    // For a CDP connection this disconnects Playwright; Edge stays running.
    await browser.close();
  }
}

async function clickNativeEdgeSignIn(processId: number): Promise<boolean> {
  const script = `
Add-Type -AssemblyName UIAutomationClient
$targetProcessId = [int]$env:DESKNETS_EDGE_PROCESS_ID
$deadline = [DateTime]::UtcNow.AddSeconds(8)
$nameCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  'サインイン'
)

while ([DateTime]::UtcNow -lt $deadline) {
  $candidates = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $nameCondition
  )
  foreach ($candidate in $candidates) {
    try {
      if (
        $candidate.Current.ProcessId -eq $targetProcessId -and
        $candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button
      ) {
        $invoke = $candidate.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        Write-Output 'clicked'
        exit 0
      }
    } catch {
      # The native dialog may close while UI Automation is inspecting it.
    }
  }
  Start-Sleep -Milliseconds 250
}

Write-Output 'not_found'
exit 2
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let stdout = "";
  let stderr = "";
  powershell.stdout.setEncoding("utf8");
  powershell.stderr.setEncoding("utf8");
  powershell.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  powershell.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await Promise.race([
    once(powershell, "exit").then(([code, signal]) => ({
      kind: "exit" as const,
      code: typeof code === "number" ? code : null,
      signal: typeof signal === "string" ? signal : null,
    })),
    once(powershell, "error").then(([error]) => ({
      kind: "error" as const,
      error: error as Error,
    })),
  ]);
  if (result.kind === "error") {
    throw new Error("Could not inspect the dedicated Edge sign-in prompt.", {
      cause: result.error,
    });
  }
  if (result.code === 0 && stdout.includes("clicked")) return true;
  if (result.code === 2 && stdout.includes("not_found")) return false;
  throw new Error(
    `Native Edge sign-in helper failed (code=${result.code}, signal=${result.signal}): ${stderr.trim()}`,
  );
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
