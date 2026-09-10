const ACTIONS = new Set([
  "find_availability",
  "select_time",
  "select_candidate",
  "change_duration",
  "change_facility",
  "set_email_notification",
  "show_candidates",
  "confirm_booking",
  "cancel",
  "unknown",
]);
const FALLBACK_TYPES = new Set(["meeting_room", "reception_room", "any"]);

export interface DeskNetsStructuredCommand {
  action: string;
  participants: Array<{ name: string; organization: string | null }>;
  dateStart: string | null;
  dateEnd: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  candidateNumber: number | null;
  facility: {
    preferred: string | null;
    fallbackLocation: string | null;
    fallbackType: "meeting_room" | "reception_room" | "any" | null;
    anyAvailable: boolean;
  };
  title: string | null;
  sendEmail: boolean | null;
}

/** Validate all model-produced data again at the Browser Agent trust boundary. */
export function readStructuredCommand(
  body: unknown,
): DeskNetsStructuredCommand | undefined {
  if (!isRecord(body) || body.structuredCommand === undefined) return undefined;
  const value = body.structuredCommand;
  if (!isRecord(value) || typeof value.action !== "string" || !ACTIONS.has(value.action)) {
    throw new TypeError("structuredCommand.action is invalid.");
  }
  if (!Array.isArray(value.participants) || value.participants.length > 100) {
    throw new TypeError("structuredCommand.participants is invalid.");
  }
  const participants = value.participants.map((participant) => {
    if (!isRecord(participant)) throw new TypeError("structuredCommand participant is invalid.");
    return {
      name: readText(participant.name, "participant.name", false),
      organization: readText(participant.organization, "participant.organization", true),
    };
  });
  if (!isRecord(value.facility)) throw new TypeError("structuredCommand.facility is invalid.");
  const fallbackType = value.facility.fallbackType;
  if (fallbackType !== null && (typeof fallbackType !== "string" || !FALLBACK_TYPES.has(fallbackType))) {
    throw new TypeError("structuredCommand.facility.fallbackType is invalid.");
  }
  if (typeof value.facility.anyAvailable !== "boolean") {
    throw new TypeError("structuredCommand.facility.anyAvailable must be boolean.");
  }
  const durationMinutes = readNullableInteger(value.durationMinutes, "durationMinutes", 1, 480);
  const candidateNumber = readNullableInteger(value.candidateNumber, "candidateNumber", 1, 10_000);
  const sendEmail = value.sendEmail;
  if (sendEmail !== null && typeof sendEmail !== "boolean") {
    throw new TypeError("structuredCommand.sendEmail must be boolean or null.");
  }
  return {
    action: value.action,
    participants,
    dateStart: readText(value.dateStart, "dateStart", true),
    dateEnd: readText(value.dateEnd, "dateEnd", true),
    startTime: readText(value.startTime, "startTime", true),
    endTime: readText(value.endTime, "endTime", true),
    durationMinutes,
    candidateNumber,
    facility: {
      preferred: readText(value.facility.preferred, "facility.preferred", true),
      fallbackLocation: readText(value.facility.fallbackLocation, "facility.fallbackLocation", true),
      fallbackType: fallbackType as DeskNetsStructuredCommand["facility"]["fallbackType"],
      anyAvailable: value.facility.anyAvailable,
    },
    title: readText(value.title, "title", true),
    sendEmail,
  };
}

/** Invalid model output must not break the existing raw-prompt path. */
export function readStructuredCommandOrUndefined(
  body: unknown,
  onInvalid: (error: unknown) => void = () => undefined,
): DeskNetsStructuredCommand | undefined {
  try {
    return readStructuredCommand(body);
  } catch (error) {
    onInvalid(error);
    return undefined;
  }
}

function readText(value: unknown, label: string, nullable: true): string | null;
function readText(value: unknown, label: string, nullable: false): string;
function readText(value: unknown, label: string, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new TypeError(`structuredCommand.${label} is invalid.`);
  }
  return value.trim();
}

function readNullableInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`structuredCommand.${label} is invalid.`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
