import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertActionAllowed, PolicyViolationError } from "./policy.js";

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
});
