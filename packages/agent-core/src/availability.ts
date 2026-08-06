export interface TimeInterval {
  start: string;
  end: string;
}

export interface ParticipantSchedule {
  participantId: string;
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

interface NumericInterval {
  start: number;
  end: number;
}

const MINUTE_MS = 60_000;

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
