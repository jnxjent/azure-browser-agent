import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeDeskNetsIntent } from "./intent-analyzer.js";

const config = { endpoint: "https://example.openai.azure.com", apiKey: "test-key", deployment: "intent-model" };

describe("analyzeDeskNetsIntent", () => {
  it("uses Azure OpenAI structured output for a relative date range", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "find_availability",
        participantNames: ["安全太郎"],
        dateStart: "2026-08-06",
        dateEnd: "2026-08-12",
        durationMinutes: 60,
        facilityQuery: null,
        candidateNumber: null,
        sendEmail: null,
        title: null,
        selectedStart: null,
        selectedEnd: null,
      }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await analyzeDeskNetsIntent("安全太郎さんと1週間以内で空いている時間", new Date("2026-08-06T16:00:00+09:00"), { config, fetchImplementation });
    assert.equal(result.source, "azure_openai");
    assert.deepEqual(result.task, {
      type: "find_availability",
      participantNames: ["安全太郎"],
      date: "2026-08-06",
      endDate: "2026-08-12",
      durationMinutes: 60,
    });
    assert.equal((requestBody?.response_format as { type?: string }).type, "json_schema");
  });

  it("falls back deterministically when Azure OpenAI is unavailable", async () => {
    const fetchImplementation: typeof fetch = async () => { throw new Error("offline"); };
    const result = await analyzeDeskNetsIntent("髙田さんと今月中で空いている時間", new Date("2026-08-06T16:00:00+09:00"), { config, fetchImplementation });
    assert.equal(result.source, "deterministic");
    assert.equal(result.task.type, "find_availability");
    if (result.task.type === "find_availability") {
      assert.equal(result.task.date, "2026-08-06");
      assert.equal(result.task.endDate, "2026-08-31");
    }
  });
});
