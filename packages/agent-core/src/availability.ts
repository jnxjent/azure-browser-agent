export interface TimeInterval {
  start: string;
  end: string;
}

export interface ParticipantSchedule {
  participantId: string;
  busy: TimeInterval[];
}

export interface FacilitySchedule {
  facilityId: string;
  busy: TimeInterval[];
}

export interface CommonAvailabilityRequest {
  window: TimeInterval;
  durationMinutes: number;
  incrementMinutes?: number;
  schedules: ParticipantSchedule[];
}

export interface CommonAvailabilitySlot extends TimeInterval {
  participantIds: string[];
  durationMinutes: number;
}

export interface BookableAvailabilityRequest extends CommonAvailabilityRequest {
  facilities: FacilitySchedule[];
}

export interface BookableAvailabilitySlot extends CommonAvailabilitySlot {
  availableFacilityIds: string[];
}

interface NumericInterval {
  start: number;
  end: number;
}

const MINUTE_MS = 60_000;

export function filterFutureAvailability<T extends TimeInterval>(
  slots: T[],
  now: Date = new Date(),
): T[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date.");
  return slots.filter((slot) => {
    const start = Date.parse(slot.start);
    if (!Number.isFinite(start)) {
      throw new TypeError("availability slot must contain a valid start date-time.");
    }
    return start >= nowMs;
  });
}

export function findCommonAvailability(
  request: CommonAvailabilityRequest,
): CommonAvailabilitySlot[] {
  const window = parseInterval(request.window, "window");
  const durationMinutes = readPositiveInteger(
    request.durationMinutes,
    "durationMinutes",
  );
  const incrementMinutes = readPositiveInteger(
    request.incrementMinutes ?? durationMinutes,
    "incrementMinutes",
  );

  if (request.schedules.length === 0) {
    throw new TypeError("At least one participant schedule is required.");
  }

  const participantIds = request.schedules.map((schedule) => {
    const id = schedule.participantId.trim();
    if (id === "") {
      throw new TypeError("participantId must be a non-empty string.");
    }
    return id;
  });
  if (new Set(participantIds).size !== participantIds.length) {
    throw new TypeError("participantId values must be unique.");
  }

  const busyByParticipant = request.schedules.map((schedule) =>
    mergeIntervals(
      schedule.busy
        .map((interval, index) =>
          parseInterval(interval, `${schedule.participantId}.busy[${index}]`),
        )
        .filter(
          (interval) => interval.end > window.start && interval.start < window.end,
        )
        .map((interval) => ({
          start: Math.max(interval.start, window.start),
          end: Math.min(interval.end, window.end),
        })),
    ),
  );

  const durationMs = durationMinutes * MINUTE_MS;
  const incrementMs = incrementMinutes * MINUTE_MS;
  const slots: CommonAvailabilitySlot[] = [];

  for (
    let candidateStart = window.start;
    candidateStart + durationMs <= window.end;
    candidateStart += incrementMs
  ) {
    const candidateEnd = candidateStart + durationMs;
    const everyoneIsFree = busyByParticipant.every((busyIntervals) =>
      busyIntervals.every(
        (busy) => busy.start >= candidateEnd || busy.end <= candidateStart,
      ),
    );

    if (everyoneIsFree) {
      slots.push({
        start: new Date(candidateStart).toISOString(),
        end: new Date(candidateEnd).toISOString(),
        participantIds: [...participantIds],
        durationMinutes,
      });
    }
  }

  return slots;
}

export function findBookableAvailability(
  request: BookableAvailabilityRequest,
): BookableAvailabilitySlot[] {
  if (request.facilities.length === 0) {
    throw new TypeError("At least one facility schedule is required.");
  }

  const facilityIds = request.facilities.map((facility) =>
    readIdentifier(facility.facilityId, "facilityId"),
  );
  if (new Set(facilityIds).size !== facilityIds.length) {
    throw new TypeError("facilityId values must be unique.");
  }

  const facilities = request.facilities.map((facility) => ({
    facilityId: readIdentifier(facility.facilityId, "facilityId"),
    busy: facility.busy.map((interval, index) =>
      parseInterval(interval, `${facility.facilityId}.busy[${index}]`),
    ),
  }));

  return findCommonAvailability(request).flatMap((slot) => {
    const candidate = parseInterval(slot, "candidate slot");
    const availableFacilityIds = facilities
      .filter((facility) =>
        facility.busy.every(
          (busy) => busy.start >= candidate.end || busy.end <= candidate.start,
        ),
      )
      .map((facility) => facility.facilityId);

    return availableFacilityIds.length === 0
      ? []
      : [{ ...slot, availableFacilityIds }];
  });
}

function parseInterval(interval: TimeInterval, label: string): NumericInterval {
  const start = Date.parse(interval.start);
  const end = Date.parse(interval.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new TypeError(`${label} must contain valid ISO date-time values.`);
  }
  if (start >= end) {
    throw new TypeError(`${label}.start must be earlier than ${label}.end.`);
  }
  return { start, end };
}

function readPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function readIdentifier(value: string, label: string): string {
  const identifier = value.trim();
  if (identifier === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return identifier;
}

function mergeIntervals(intervals: NumericInterval[]): NumericInterval[] {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  const merged: NumericInterval[] = [];

  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || interval.start > previous.end) {
      merged.push({ ...interval });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
  }

  return merged;
}
