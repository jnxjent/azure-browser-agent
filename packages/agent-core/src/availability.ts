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
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;

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
  facilityQuery?: string;
}

export interface BookableAvailabilitySlot extends CommonAvailabilitySlot {
  availableFacilityIds: string[];
}

export interface MultiLocationAvailabilitySlot extends BookableAvailabilitySlot {
  facilitiesByLocation: Record<string, string[]>;
}

interface NumericInterval {
  start: number;
  end: number;
}

const MINUTE_MS = 60_000;
const KNOWN_FACILITY_LOCATIONS = [
  "ミダックこなん",
  "奥山の杜CC",
  "浜名湖CC",
  "遠州CC",
  "御殿山",
  "富士宮",
  "名古屋",
  "アクト",
  "有玉",
  "品川",
  "奥山",
  "都田",
].map(normalizeFacilityName).sort((left, right) => right.length - left.length);

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

  const readBuffer = (value: number | undefined): number => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 1440))
      throw new TypeError("Schedule buffers must be integers between 0 and 1440 minutes.");
    return (value ?? 0) * MINUTE_MS;
  };
  const beforeMs = readBuffer(request.bufferBeforeMinutes);
  const afterMs = readBuffer(request.bufferAfterMinutes);
  const busyByParticipant = request.schedules.map((schedule) =>
    mergeIntervals(
      schedule.busy
        .map((interval, index) =>
          parseInterval(interval, `${schedule.participantId}.busy[${index}]`),
        )
        .map(interval => ({ start: interval.start - afterMs, end: interval.end + beforeMs }))
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

  const normalizedFacilityQuery = request.facilityQuery === undefined
    ? undefined
    : normalizeFacilityName(readIdentifier(request.facilityQuery, "facilityQuery"));
  const facilities = request.facilities.map((facility) => ({
    facilityId: readIdentifier(facility.facilityId, "facilityId"),
    busy: facility.busy.map((interval, index) =>
      parseInterval(interval, `${facility.facilityId}.busy[${index}]`),
    ),
  })).filter(
    (facility) =>
      normalizedFacilityQuery === undefined ||
      matchesFacilityQuery(facility.facilityId, normalizedFacilityQuery),
  );

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

/** Intersect people and one free meeting room at every requested location. */
export function findMultiLocationAvailability(
  request: BookableAvailabilityRequest & {
    requiredFacilityLocations: string[];
    requiredFacilityQueries?: string[];
  },
): MultiLocationAvailabilitySlot[] {
  const locations = request.requiredFacilityLocations.map((location) => location.trim());
  if (locations.length < 2 || locations.length > 10 ||
      new Set(locations.map(normalizeFacilityName)).size !== locations.length) {
    throw new TypeError("Between two and ten distinct facility locations are required.");
  }
  const queries = request.requiredFacilityQueries?.map((query) => query.trim());
  if (queries !== undefined &&
      (queries.length !== locations.length || queries.some((query) => query === ""))) {
    throw new TypeError("requiredFacilityQueries must correspond to requiredFacilityLocations.");
  }
  const byLocation = locations.map((location, index) => ({
    location,
    // findBookableAvailability uses normalized substring matching, so a user
    // query such as "有玉大会議室" also matches the registered desknet's name
    // "有玉大会議室 AER～アリア～".
    slots: findBookableAvailability({
      ...request,
      facilityQuery: queries?.[index] ?? location,
    }),
  }));
  const otherLocations = byLocation.slice(1);
  return (byLocation[0]?.slots ?? []).flatMap((first) => {
    const matching = otherLocations.map(({ location, slots }) => ({
      location,
      slot: slots.find((slot) => slot.start === first.start && slot.end === first.end),
    }));
    if (matching.some(({ slot }) => slot === undefined)) return [];
    const facilitiesByLocation = Object.fromEntries([
      [locations[0], first.availableFacilityIds],
      ...matching.map(({ location, slot }) => [location, slot!.availableFacilityIds]),
    ]) as Record<string, string[]>;
    return [{
      ...first,
      availableFacilityIds: Object.values(facilitiesByLocation).flat(),
      facilitiesByLocation,
    }];
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

function normalizeFacilityName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

export function facilityMatchesQuery(facilityId: string, query: string): boolean {
  return matchesFacilityQuery(facilityId, normalizeFacilityName(query));
}

function matchesFacilityQuery(
  facilityId: string,
  normalizedQuery: string,
): boolean {
  const normalizedFacilityId = normalizeFacilityName(facilityId);
  // Extract a shared location token rather than comparing an entire phrase
  // such as アクト事務所内 against the literal equipment name. Longest known
  // names win (奥山の杜CC must not become 奥山); multiple sites stay explicit.
  const locations = KNOWN_FACILITY_LOCATIONS.filter(location => normalizedQuery.includes(location))
    .filter(location => !KNOWN_FACILITY_LOCATIONS.some(other => other !== location && other.includes(location) && normalizedQuery.includes(other)));
  if (locations.length === 1) {
    const location = locations[0]!;
    const remainder = normalizedQuery.replace(location, "")
      .replace(/の?(?:事務所|オフィス|社屋|拠点|敷地|建物|構内|社内)(?:内)?/g, "")
      .replace(/^(?:の|内|に|で|ある)+/, "")
      .replace(/^(?:空いている|空いてる|空き)/, "");
    const facilityLocation = KNOWN_FACILITY_LOCATIONS.find(candidate => normalizedFacilityId.includes(candidate));
    const hasRoomQualifier = /室|ルーム|ホール|ブース/.test(remainder);
    const excludesLocation = /以外|除く|除外|ではない|じゃない/.test(remainder);
    if (!excludesLocation && (!hasRoomQualifier || ["会議室", "応接室"].includes(remainder))) {
      const isRoom = normalizedFacilityId.startsWith(location) || /会議|応接|ルーム|研修室|面談室|打合せ|打ち合わせ|ホール|ブース/.test(normalizedFacilityId);
      return facilityLocation === location && isRoom &&
        (remainder === "会議室" || remainder === "応接室" ? normalizedFacilityId.includes(remainder) : true);
    }
    // A named room remains a named room. Removing office wording must not
    // expand 大会議室 or 応接室A to every room at the location.
    return normalizedFacilityId.includes(normalizedQuery) || normalizedFacilityId.includes(location + remainder);
  }
  return normalizedFacilityId.includes(normalizedQuery);
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
