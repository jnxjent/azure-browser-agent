import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  loadDeskNetsCredentials,
  type CredentialLease,
} from "./desknets-credentials.js";

const USER_ID = /^[a-f0-9]{64}$/;
const ORIGIN = "https://desknets.midac.jp";

function credentialFile(userId: string): string {
  if (!USER_ID.test(userId)) throw new TypeError("Invalid user ID.");
  const sharedFile = process.env.DESKNETS_CREDENTIAL_FILE;
  if (!sharedFile) throw new Error("Shared DeskNet's credentials are not configured.");
  return join(dirname(sharedFile), "users", `${userId}.bin`);
}

async function protectOnThisMachine(secret: string): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("Windows is required.");
  // The password is sent only on stdin. Neither the command line nor the
  // subprocess environment contains it.
  // Base64 keeps non-ASCII passwords independent of PowerShell's stdin encoding.
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); try { $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); [Console]::Write([Convert]::ToBase64String($p)) } finally { [Array]::Clear($b,0,$b.Length) }";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 65536) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(text) : reject(new Error("Credential encryption failed.")));
    child.stdin.end(Buffer.from(secret, "utf8").toString("base64"));
  });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(output.trim())) {
    throw new Error("Credential encryption failed.");
  }
  const encrypted = Buffer.from(output.trim(), "base64");
  if (!encrypted.length) throw new Error("Credential encryption failed.");
  return encrypted;
}

export async function hasDeskNetsUserCredentials(userId: string): Promise<boolean> {
  if (!USER_ID.test(userId)) throw new TypeError("Invalid user ID.");
  if (!process.env.DESKNETS_CREDENTIAL_FILE) return false;
  const file = credentialFile(userId);
  return stat(file).then((entry) => entry.isFile()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export async function deleteDeskNetsUserCredentials(userId: string): Promise<void> {
  const file = credentialFile(userId);
  await rm(file, { force: true });
  await rm(`${file}.blocked`, { force: true });
}

export async function sharedDeskNetsEntranceReady(): Promise<boolean> {
  const shared = await loadDeskNetsCredentials();
  return shared?.credentials.origin === ORIGIN && shared.credentials.basic !== undefined;
}

export async function saveDeskNetsUserCredentials(
  userId: string,
  username: string,
  password: string,
): Promise<void> {
  const file = credentialFile(userId);
  if (!username.trim() || username.length > 200 || !password || password.length > 1024) {
    throw new TypeError("Invalid DeskNet's login credentials.");
  }
  const shared = await loadDeskNetsCredentials();
  if (!shared?.credentials.basic || shared.credentials.origin !== ORIGIN) {
    throw new Error("The shared DeskNet's entrance credentials must be configured first.");
  }
  const value = JSON.stringify({ origin: ORIGIN, app: { username, password } });
  const encrypted = await protectOnThisMachine(value);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    encrypted.fill(0);
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function loadDeskNetsUserCredentials(userId: string): Promise<CredentialLease> {
  const [shared, personal] = await Promise.all([
    loadDeskNetsCredentials(),
    loadDeskNetsCredentials(credentialFile(userId)),
  ]);
  if (!personal) {
    throw new Error("DeskNet's の個人ログインが未登録です。TestSite でご自身の ID とパスワードを登録してください。");
  }
  if (!shared?.credentials.basic || !personal.credentials.app ||
      shared.credentials.origin !== ORIGIN || personal.credentials.origin !== ORIGIN) {
    throw new Error("DeskNet's credentials are incomplete.");
  }
  return {
    credentials: { origin: ORIGIN, basic: shared.credentials.basic, app: personal.credentials.app },
    blocked: (kind) => kind === "basic" ? shared.blocked(kind) : personal.blocked(kind),
    block: (kind) => kind === "basic" ? shared.block(kind) : personal.block(kind),
    clear: (kind) => kind === "basic" ? shared.clear(kind) : personal.clear(kind),
  };
}
