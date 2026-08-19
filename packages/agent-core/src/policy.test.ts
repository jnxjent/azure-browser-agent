import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserRun } from "./contracts.js";
import {
  assertActionAllowed,
  assertRunAllowed,
  PolicyViolationError,
} from "./policy.js";

const limits = {
  allowedDomains: ["desknets.example"],
  maxSteps: 30,
  maxRunDurationMs: 300_000,
};

describe("assertActionAllowed", () => {
  it("rejects final write controls in the read-only milestone", () => {
    for (const target of ["追加", "登録", "保存", "送信", "削除", "Submit"]) {
      assert.throws(
        () => assertActionAllowed({ type: "click", target }, limits),
        PolicyViolationError,
      );
    }
  });

  it("allows the participant selector without confusing it with registration", () => {
    assert.doesNotThrow(() =>
      assertActionAllowed({ type: "click", target: "登録先" }, limits),
    );
  });

  it("still rejects the final Add in write mode without explicit approval", () => {
    assert.throws(
      () => assertActionAllowed({ type: "click", target: "追加" }, limits, "write"),
      PolicyViolationError,
    );
  });

  it("allows the final Add only after explicit approval", () => {
    assert.doesNotThrow(() =>
      assertActionAllowed({ type: "click", target: "追加" }, limits, "write", true),
    );
  });
});

describe("assertRunAllowed", () => {
  it("requires an explicit booking task and pending context for write runs", () => {
    const run: BrowserRun = {
      id: "run-1",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
      input: {
        userId: "user-1",
        threadId: "thread-1",
        site: "desknets",
        prompt: "会議をセットしてください",
        mode: "write",
      },
      status: "queued",
      steps: [],
    };
    assert.throws(() => assertRunAllowed(run, limits), PolicyViolationError);
  });
});
