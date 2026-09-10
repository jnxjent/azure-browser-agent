import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveUniqueAppointmentHref } from "./desknets-appointments.js";

describe("resolveUniqueAppointmentHref", () => {
  it("treats repeated participant-row links to the same appointment as one result", () => {
    assert.equal(
      resolveUniqueAppointmentHref([
        "https://example.test/#sid=meeting-1",
        "https://example.test/#sid=meeting-1",
      ]),
      "https://example.test/#sid=meeting-1",
    );
  });

  it("rejects different appointments sharing the same title and time", () => {
    assert.equal(
      resolveUniqueAppointmentHref([
        "https://example.test/#sid=meeting-1",
        "https://example.test/#sid=meeting-2",
      ]),
      undefined,
    );
  });

  it("rejects missing appointment identities", () => {
    assert.equal(resolveUniqueAppointmentHref([null, ""]), undefined);
  });
});
