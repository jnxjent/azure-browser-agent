import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export interface DeskNetsCredentials {
  origin: string;
  basic?: { username: string; password: string };
  app?: { username: string; password: string };
}
export interface CredentialLease {
  credentials: DeskNetsCredentials;
  blocked(kind: "basic" | "app"): Promise<boolean>;
  block(kind: "basic" | "app"): Promise<void>;
  clear(kind: "basic" | "app"): Promise<void>;
}
const execute = promisify(execFile);

export function validateCredentials(value: unknown): DeskNetsCredentials {
  if (!value || typeof value !== "object") throw new Error("Invalid credentials");
  const c = value as DeskNetsCredentials;
  const url = new URL(c.origin);
  if (url.protocol !== "https:" || url.origin !== c.origin || url.username || url.password) throw new Error("Invalid credential origin");
  for (const pair of [c.basic, c.app]) {
    if (pair !== undefined && (typeof pair.username !== "string" || !pair.username || typeof pair.password !== "string" || !pair.password)) throw new Error("Invalid credentials");
  }
  if (!c.basic && !c.app) throw new Error("Missing credentials");
  return c;
}

/** DPAPI LocalMachine blob, in an ACL-restricted directory created by enrollment. */
export async function loadDeskNetsCredentials(
  file = process.env.DESKNETS_CREDENTIAL_FILE,
): Promise<CredentialLease | undefined> {
  if (!file) return undefined;
  try {
    if (process.platform !== "win32") throw new Error("Windows required");
    const encrypted = await readFile(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!encrypted) return undefined;
    const revision = createHash("sha256").update(encrypted).digest("hex");
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:DESKNETS_CREDENTIAL_FILE); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write([Text.Encoding]::UTF8.GetString($p))";
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 10_000, maxBuffer: 65536,
      env: { ...process.env, DESKNETS_CREDENTIAL_FILE: file },
    });
    const credentials = validateCredentials(JSON.parse(stdout.replace(/^\uFEFF/, "")));
    const lockFile = `${file}.blocked`;
    async function readBlocked(): Promise<string[]> {
      try {
        const value = JSON.parse(await readFile(lockFile, "utf8"));
        return value.revision === revision && Array.isArray(value.kinds) ? value.kinds : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error("Credential lock unreadable");
      }
    }
    let tail: Promise<unknown> = Promise.resolve();
    const update = (kind: string, add: boolean): Promise<void> => {
      const operation = tail.then(async () => {
        const kinds = (await readBlocked()).filter(k => k !== kind);
        if (add) kinds.push(kind);
        await writeFile(lockFile, JSON.stringify({ revision, kinds }), { mode: 0o600 });
      });
      tail = operation;
      return operation;
    };
    return { credentials,
      blocked: async kind => (await readBlocked()).includes(kind),
      block: kind => update(kind, true),
      clear: kind => update(kind, false),
    };
  } catch {
    // Never propagate subprocess output, plaintext, or credential file contents.
    throw new Error("DeskNet'sの認証情報を読み込めません。VM上で認証情報を再登録してください。");
  }
}
