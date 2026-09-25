import assert from "node:assert/strict";
import { it } from "node:test";
import { server } from "./server.js";

it("keeps personal credential status private and reports missing shared entrance setup", async () => {
  const previous = {
    key: process.env.AGENT_API_KEY,
    enabled: process.env.DESKNETS_MULTI_USER_ENABLED,
    file: process.env.DESKNETS_CREDENTIAL_FILE,
  };
  process.env.AGENT_API_KEY = "local-fixture-api-key";
  process.env.DESKNETS_MULTI_USER_ENABLED = "true";
  delete process.env.DESKNETS_CREDENTIAL_FILE;
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not start.");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(`${base}/browser-agent/credentials`, {
      headers: { "x-user-id": "a".repeat(64) },
    });
    assert.equal(unauthorized.status, 401);
    const credentials = await fetch(`${base}/browser-agent/credentials`, {
      headers: {
        authorization: "Bearer local-fixture-api-key",
        "x-user-id": "a".repeat(64),
      },
    });
    assert.equal(credentials.status, 200);
    assert.deepEqual(await credentials.json(), { registered: false, sharedReady: false, transportReady: false });
    const queue = await fetch(`${base}/browser-agent/queue?threadId=thread-a`, {
      headers: {
        authorization: "Bearer local-fixture-api-key",
        "x-user-id": "a".repeat(64),
        "x-chat-thread-id": "thread-a",
      },
    });
    assert.equal(queue.status, 200);
    assert.equal((await queue.json()).status, "idle");
    const wrongThread = await fetch(`${base}/browser-agent/queue?threadId=thread-b`, {
      headers: {
        authorization: "Bearer local-fixture-api-key",
        "x-user-id": "a".repeat(64),
        "x-chat-thread-id": "thread-a",
      },
    });
    assert.equal(wrongThread.status, 400);
    const wrongRunOwner = await fetch(`${base}/browser-agent/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-fixture-api-key",
        "content-type": "application/json",
        "x-user-id": "a".repeat(64),
        "x-chat-thread-id": "thread-a",
      },
      body: JSON.stringify({ userId: "b".repeat(64), threadId: "thread-a", site: "desknets", mode: "read", prompt: "私の予定を確認" }),
    });
    assert.equal(wrongRunOwner.status, 403);
    assert.match((await wrongRunOwner.json()).message, /利用者情報が一致/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous.key === undefined) delete process.env.AGENT_API_KEY;
    else process.env.AGENT_API_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.DESKNETS_MULTI_USER_ENABLED;
    else process.env.DESKNETS_MULTI_USER_ENABLED = previous.enabled;
    if (previous.file === undefined) delete process.env.DESKNETS_CREDENTIAL_FILE;
    else process.env.DESKNETS_CREDENTIAL_FILE = previous.file;
  }
});
