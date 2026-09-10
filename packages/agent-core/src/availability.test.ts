import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterFutureAvailability,
  findBookableAvailability,
  findCommonAvailability,
} from "./availability.js";

describe("filterFutureAvailability", () => {
  it("omits past dates and already-started same-day slots", () => {
    const slots = [
      { start: "2026-08-05T17:00:00+09:00", end: "2026-08-05T18:00:00+09:00" },
      { start: "2026-08-06T16:00:00+09:00", end: "2026-08-06T17:00:00+09:00" },
      { start: "2026-08-06T16:30:00+09:00", end: "2026-08-06T17:30:00+09:00" },
      { start: "2026-08-07T08:00:00+09:00", end: "2026-08-07T09:00:00+09:00" },
    ];

    assert.deepEqual(
      filterFutureAvailability(slots, new Date("2026-08-06T16:09:00+09:00")),
      slots.slice(2),
    );
  });

  it("rejects an invalid current time", () => {
    assert.throws(() => filterFutureAvailability([], new Date("invalid")), /valid date/);
  });
});

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

  it("excludes every candidate overlapping a participant's partial-hour meetings", () => {
    const slots = findCommonAvailability({
      window: {
        start: "2026-09-17T08:00:00+09:00",
        end: "2026-09-17T18:00:00+09:00",
      },
      durationMinutes: 60,
      incrementMinutes: 30,
      schedules: [
        {
          participantId: "髙田",
          busy: [
            {
              start: "2026-09-17T11:30:00+09:00",
              end: "2026-09-17T13:30:00+09:00",
            },
            {
              start: "2026-09-17T14:30:00+09:00",
              end: "2026-09-17T15:00:00+09:00",
            },
          ],
        },
      ],
    });

    const labels = slots.map((slot) =>
      `${new Date(slot.start).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })}-${new Date(slot.end).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })}`,
    );
    assert.equal(labels.includes("12:00-13:00"), false);
    assert.equal(labels.includes("14:00-15:00"), false);
    assert.equal(labels.includes("13:30-14:30"), true);
    assert.equal(labels.includes("15:00-16:00"), true);
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

describe("findBookableAvailability", () => {
  it("returns participant slots only when at least one facility is also free", () => {
    const slots = findBookableAvailability({
      window: {
        start: "2026-08-07T13:00:00+09:00",
        end: "2026-08-07T16:00:00+09:00",
      },
      durationMinutes: 60,
      schedules: [
        {
          participantId: "A",
          busy: [
            {
              start: "2026-08-07T13:00:00+09:00",
              end: "2026-08-07T14:00:00+09:00",
            },
          ],
        },
        { participantId: "B", busy: [] },
      ],
      facilities: [
        {
          facilityId: "Room 1",
          busy: [
            {
              start: "2026-08-07T14:00:00+09:00",
              end: "2026-08-07T15:00:00+09:00",
            },
          ],
        },
        {
          facilityId: "Room 2",
          busy: [
            {
              start: "2026-08-07T15:00:00+09:00",
              end: "2026-08-07T16:00:00+09:00",
            },
          ],
        },
      ],
    });

    assert.deepEqual(
      slots.map((slot) => ({
        start: slot.start,
        availableFacilityIds: slot.availableFacilityIds,
      })),
      [
        {
          start: "2026-08-07T05:00:00.000Z",
          availableFacilityIds: ["Room 2"],
        },
        {
          start: "2026-08-07T06:00:00.000Z",
          availableFacilityIds: ["Room 1"],
        },
      ],
    );
  });

  it("keeps only facilities matching the user's location filter", () => {
    const slots = findBookableAvailability({
      window: {
        start: "2026-09-17T09:00:00+09:00",
        end: "2026-09-17T10:00:00+09:00",
      },
      durationMinutes: 60,
      schedules: [{ participantId: "髙田", busy: [] }],
      facilities: [
        { facilityId: "アクト大会議室", busy: [] },
        { facilityId: "アクトミーティングルームC", busy: [] },
        { facilityId: "有玉大会議室", busy: [] },
        { facilityId: "7180プリウス（アクト総務）", busy: [] },
      ],
      facilityQuery: "アクト",
    });

    assert.deepEqual(slots[0]?.availableFacilityIds, [
      "アクト大会議室",
      "アクトミーティングルームC",
    ]);
  });

  it("distinguishes 奥山 from the more specific 奥山の杜CC location", () => {
    const request = {
      window: {
        start: "2026-09-17T09:00:00+09:00",
        end: "2026-09-17T10:00:00+09:00",
      },
      durationMinutes: 60,
      schedules: [{ participantId: "髙田", busy: [] }],
      facilities: [
        { facilityId: "奥山応接室(1階)", busy: [] },
        { facilityId: "奥山会議室(2階)", busy: [] },
        { facilityId: "奥山の杜CC", busy: [] },
      ],
    };

    assert.deepEqual(
      findBookableAvailability({ ...request, facilityQuery: "奥山" })[0]?.availableFacilityIds,
      ["奥山応接室(1階)", "奥山会議室(2階)"],
    );
    assert.deepEqual(
      findBookableAvailability({ ...request, facilityQuery: "奥山の杜CC" })[0]?.availableFacilityIds,
      ["奥山の杜CC"],
    );
  });

  it("omits a participant slot when every facility is occupied", () => {
    const slots = findBookableAvailability({
      window: {
        start: "2026-08-07T14:00:00+09:00",
        end: "2026-08-07T15:00:00+09:00",
      },
      durationMinutes: 60,
      schedules: [{ participantId: "A", busy: [] }],
      facilities: [
        {
          facilityId: "Room 1",
          busy: [
            {
              start: "2026-08-07T14:00:00+09:00",
              end: "2026-08-07T15:00:00+09:00",
            },
          ],
        },
      ],
    });

    assert.deepEqual(slots, []);
  });

  it("rejects missing and duplicate facility identifiers", () => {
    const request = {
      window: {
        start: "2026-08-07T14:00:00+09:00",
        end: "2026-08-07T15:00:00+09:00",
      },
      durationMinutes: 60,
      schedules: [{ participantId: "A", busy: [] }],
    };

    assert.throws(
      () => findBookableAvailability({ ...request, facilities: [] }),
      /At least one facility/,
    );
    assert.throws(
      () =>
        findBookableAvailability({
          ...request,
          facilities: [
            { facilityId: "Room 1", busy: [] },
            { facilityId: "Room 1", busy: [] },
          ],
        }),
      /must be unique/,
    );
  });
});
