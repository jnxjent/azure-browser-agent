import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readStructuredCommand,
  readStructuredCommandOrUndefined,
} from "./structured-command.js";

const command = {
  action: "change_facility",
  participants: [],
  dateStart: null,
  dateEnd: null,
  startTime: null,
  endTime: null,
  durationMinutes: null,
  candidateNumber: null,
  facility: {
    preferred: "アクト応接室",
    fallbackLocation: "アクト",
    fallbackType: "meeting_room",
    anyAvailable: true,
  },
  title: null,
  sendEmail: null,
};

describe("readStructuredCommand", () => {
  it("validates a structured facility change", () => {
    assert.deepEqual(readStructuredCommand({ structuredCommand: command }), command);
  });

  it("keeps the field backward compatible", () => {
    assert.equal(readStructuredCommand({ prompt: "従来のリクエスト" }), undefined);
  });

  it("rejects an invalid command at the API boundary", () => {
    assert.throws(
      () => readStructuredCommand({ structuredCommand: { ...command, action: "delete_all" } }),
      /action is invalid/,
    );
  });

  it("allows the request path to fall back to the raw prompt", () => {
    let warned = false;
    assert.equal(
      readStructuredCommandOrUndefined(
        { structuredCommand: { ...command, action: "delete_all" } },
        () => { warned = true; },
      ),
      undefined,
    );
    assert.equal(warned, true);
  });
});
