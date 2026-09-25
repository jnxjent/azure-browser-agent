import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { it } from "node:test";
import { openCredentialEnvelope } from "./credential-envelope.js";

it("opens a fresh user-bound credential envelope and rejects tampering or replay age", () => {
  const key = randomBytes(32);
  const userId = "a".repeat(64);
  const issuedAt = Date.now();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`v1:${userId}:${issuedAt}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ username: "employee", password: "test-secret" }), "utf8"),
    cipher.final(),
  ]);
  const envelope = {
    version: 1,
    issuedAt,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  const encodedKey = key.toString("base64url");
  assert.deepEqual(openCredentialEnvelope(envelope, userId, encodedKey), {
    username: "employee", password: "test-secret",
  });
  assert.throws(() => openCredentialEnvelope(envelope, "b".repeat(64), encodedKey));
  assert.throws(() => openCredentialEnvelope({ ...envelope, issuedAt: issuedAt - 360_000 }, userId, encodedKey));
  assert.throws(() => openCredentialEnvelope({ ...envelope, ciphertext: "AAAA" }, userId, encodedKey));
});
