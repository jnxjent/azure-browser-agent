import { createDecipheriv } from "node:crypto";

export interface CredentialEnvelope {
  version: 1;
  issuedAt: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

function transportKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("DeskNet's credential transport key is not configured.");
  }
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("DeskNet's credential transport key is invalid.");
  return key;
}

/** Decrypts only a short-lived, user-bound enrollment request. */
export function openCredentialEnvelope(
  value: unknown,
  userId: string,
  configuredKey = process.env.DESKNETS_CREDENTIAL_TRANSPORT_KEY,
): { username: string; password: string } {
  const key = transportKey(configuredKey);
  try {
    if (!value || typeof value !== "object") throw new TypeError("Invalid credential envelope.");
    const body = value as Partial<CredentialEnvelope>;
    if (body.version !== 1 || !Number.isSafeInteger(body.issuedAt) ||
        Math.abs(Date.now() - body.issuedAt!) > 300_000 ||
        typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(body.nonce) ||
        typeof body.tag !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.tag) ||
        typeof body.ciphertext !== "string" || !/^[A-Za-z0-9_-]{1,8192}$/.test(body.ciphertext)) {
      throw new TypeError("Invalid credential envelope.");
    }
    const nonce = Buffer.from(body.nonce, "base64url");
    const tag = Buffer.from(body.tag, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) throw new TypeError("Invalid credential envelope.");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`v1:${userId}:${body.issuedAt}`, "utf8"));
    decipher.setAuthTag(tag);
    let plaintext: Buffer | undefined;
    try {
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(body.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const credentials: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!credentials || typeof credentials !== "object" ||
          typeof (credentials as Record<string, unknown>).username !== "string" ||
          typeof (credentials as Record<string, unknown>).password !== "string") {
        throw new TypeError("Invalid DeskNet's credentials.");
      }
      return credentials as { username: string; password: string };
    } finally {
      plaintext?.fill(0);
    }
  } catch {
    throw new TypeError("DeskNet's credential enrollment could not be decrypted.");
  } finally {
    key.fill(0);
  }
}
