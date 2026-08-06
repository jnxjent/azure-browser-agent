import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findCommonAvailability } from "./availability.js";

describe("findCommonAvailability", () => {
  it("returns only slots where every participant is free", () => {
    const slots = findCommonAvailability({
      window: {
        start: "2026-08-05T09:00:00+09:00",
        end: "2026-08-05T12:00:00+09:00",
      },
      durationMinutes: 60,
      schedules: [
        {
          participantId: "A",
          busy: [
            {
              start: "2026-08-05T10:00:00+09:00",
              end: "2026-08-05T11:00:00+09:00",
            },
          ],
        },
        {
          participantId: "B",
          busy: [
            {
              start: "2026-08-05T11:00:00+09:00",
              end: "2026-08-05T12:00:00+09:00",
            },
          ],
        },
        {
          participantId: "C",
          busy: [
            {
              start: "2026-08-05T10:00:00+09:00",
              end: "2026-08-05T11:00:00+09:00",
            },
          ],
        },
      ],
    });

    assert.deepEqual(
      slots.map(({ start, end }) => ({ start, end })),
      [
        {
          start: "2026-08-05T00:00:00.000Z",
          end: "2026-08-05T01:00:00.000Z",
        },
      ],
    );
    assert.deepEqual(slots[0]?.participantIds, ["A", "B", "C"]);
  });

  it("supports rolling candidates and merges overlapping busy intervals", () => {
    const slots = findCommonAvailability({
      window: {
        start: "2026-08-05T09:00:00Z",
        end: "2026-08-05T11:00:00Z",
      },
      durationMinutes: 30,
      incrementMinutes: 15,
      schedules: [
        {
          participantId: "A",
          busy: [
            {
              start: "2026-08-05T09:15:00Z",
              end: "2026-08-05T09:30:00Z",
            },
            {
              start: "2026-08-05T09:20:00Z",
              end: "2026-08-05T09:45:00Z",
            },
          ],
        },
      ],
    });

    assert.deepEqual(
      slots.map((slot) => slot.start),
      [
        "2026-08-05T09:45:00.000Z",
        "2026-08-05T10:00:00.000Z",
        "2026-08-05T10:15:00.000Z",
        "2026-08-05T10:30:00.000Z",
      ],
    );
  });

  it("treats a meeting ending at slot start as non-overlapping", () => {
    const slots = findCommonAvailability({
      window: {
        start: "2026-08-05T09:00:00Z",
        end: "2026-08-05T10:00:00Z",
      },
      durationMinutes: 30,
      schedules: [
        {
          participantId: "A",
          busy: [
            {
              start: "2026-08-05T08:30:00Z",
              end: "2026-08-05T09:00:00Z",
            },
          ],
        },
      ],
    });

    assert.equal(slots.length, 2);
  });

  it("rejects invalid ranges and duplicate participants", () => {
    assert.throws(
      () =>
        findCommonAvailability({
          window: {
            start: "2026-08-05T10:00:00Z",
            end: "2026-08-05T09:00:00Z",
          },
          durationMinutes: 30,
          schedules: [{ participantId: "A", busy: [] }],
        }),
      /start must be earlier/,
    );

    assert.throws(
      () =>
        findCommonAvailability({
          window: {
            start: "2026-08-05T09:00:00Z",
            end: "2026-08-05T10:00:00Z",
          },
          durationMinutes: 30,
          schedules: [
            { participantId: "A", busy: [] },
            { participantId: "A", busy: [] },
          ],
        }),
      /must be unique/,
    );
  });
});
