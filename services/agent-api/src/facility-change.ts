import type { DeskNetsStructuredCommand } from "./structured-command.js";

export interface FacilityChangeRequest {
  excludePrevious?: boolean;
  preferredQuery: string;
  preferredType?: "meeting_room" | "reception_room" | "any";
  fallbackQuery?: string;
  fallbackType?: "meeting_room" | "reception_room" | "any";
}

const FACILITY_WORD = /(?:会議室|応接室|ミーティングルーム|ルーム|設備)/;
const CHANGE_WORD = /(?:変更|変えて|替えて|かえて|にして)/;
const FALLBACK_PREFIX = /(?:空いてい?なければ|あいてい?なければ|空いてい?なかったら|あいてい?なかったら|空きがなければ|埋まっていれば|埋まっていたら|埋まってたら|予約済みなら|使用中なら|なければ|だめなら)/;

export function mergeFacilityChangeRequests(
  structured: FacilityChangeRequest | undefined,
  parsed: FacilityChangeRequest | undefined,
): FacilityChangeRequest | undefined {
  if (parsed?.excludePrevious) return parsed;
  if (structured === undefined) return parsed;
  if (parsed === undefined || structured.fallbackQuery !== undefined) return structured;
  return {
    ...structured,
    ...(parsed.fallbackQuery === undefined
      ? {}
      : {
          fallbackQuery: parsed.fallbackQuery,
          fallbackType: parsed.fallbackType ?? "any",
        }),
  };
}

export function facilityChangeFromStructuredCommand(
  command: DeskNetsStructuredCommand | undefined,
): FacilityChangeRequest | undefined {
  if (command?.action !== "change_facility") return undefined;
  const preferred = parseFlexibleFacilityQuery(
    command.facility.preferred ??
      (command.facility.anyAvailable ? command.facility.fallbackLocation : null) ??
      undefined,
  );
  if (preferred === undefined) return undefined;
  const fallbackQuery = cleanQuery(command.facility.fallbackLocation ?? undefined);
  const usesFallbackAsPrimary = command.facility.preferred === null;
  const preferredType = preferred.facilityType ??
    (command.facility.anyAvailable && (fallbackQuery === undefined || usesFallbackAsPrimary)
      ? command.facility.fallbackType ?? undefined
      : undefined);
  return {
    preferredQuery: preferred.query,
    ...(preferredType === undefined ? {} : { preferredType }),
    ...(command.facility.anyAvailable && fallbackQuery !== undefined && !usesFallbackAsPrimary
      ? {
          fallbackQuery,
          fallbackType: command.facility.fallbackType ?? "any",
        }
      : {}),
  };
}

export function parseFacilityChangeRequest(
  prompt: string,
): FacilityChangeRequest | undefined {
  const normalized = prompt.normalize("NFKC").trim();
  const alternative = parseAlternativeFacilityRequest(normalized);
  if (alternative !== undefined) return alternative;
  if (!FACILITY_WORD.test(normalized) || !CHANGE_WORD.test(normalized)) {
    return undefined;
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[。.!！]+$/g, ""))
    .filter(Boolean);
  const preferredLine = lines.find(
    (line, index) =>
      index > 0 &&
      FACILITY_WORD.test(line) &&
      !CHANGE_WORD.test(line) &&
      !FALLBACK_PREFIX.test(line),
  );
  const inline = normalized.match(
    /(?:会議室|設備)\s*(?:は|を)\s*[、,]?\s*(.+?)\s*(?:に変更|へ変更|にして|[へに](?:変えて|替えて|かえて))/,
  )?.[1] ?? normalized.match(
    /(?:^|[。.!！？]\s*)([^。.!！？]{2,60}?(?:会議室|応接室|ミーティングルーム|ルーム))\s*[へに](?:変更|変えて|替えて|かえて)/,
  )?.[1];
  const preferred = parseFlexibleFacilityQuery(preferredLine ?? inline);
  if (preferred === undefined || preferred.query === "以下") return undefined;

  const fallbackMatch = normalized.match(
    /(?:空いてい?なければ|あいてい?なければ|空いてい?なかったら|あいてい?なかったら|空きがなければ|埋まっていれば|埋まっていたら|埋まってたら|予約済みなら|使用中なら|なければ|だめなら)[、,\s]*(?:代わりに)?([^\s、。\n]{2,30}?)(?:の(?:どの|いずれの|空いている)?(会議室|応接室|ミーティングルーム|ルーム|設備)|なら|で)/,
  );
  const fallbackQuery = cleanQuery(fallbackMatch?.[1]);
  const fallbackType = readFallbackType(fallbackMatch?.[2]);
  return {
    preferredQuery: preferred.query,
    ...(preferred.facilityType === undefined
      ? {}
      : { preferredType: preferred.facilityType }),
    ...(fallbackQuery === undefined
      ? {}
      : { fallbackQuery, fallbackType: fallbackType ?? "any" }),
  };
}

export function parseAlternativeFacilityRequest(prompt: string, previousScope?: string): FacilityChangeRequest | undefined {
  const text = prompt.normalize("NFKC").trim()
    .replace(/^(?:では|それでは|じゃあ|それなら)[、,\s]*/, "");
  const match = text.match(/^(?:(.+?)(?:の|内の|で))?(?:別の?|他の|ほかの)(会議室|応接室|ミーティングルーム|部屋)(?:で|にして|をお願い|を使|がいい|に(?:変更|変えて|替えて|かえて)|$)/);
  if (match === null) return undefined;
  const requestedScope = match[1]?.trim();
  const scope = requestedScope === "同じ場所" || requestedScope === "そこ" ? previousScope : requestedScope || previousScope;
  if (!scope) return undefined;
  return { preferredQuery: scope, preferredType: match[2] === "応接室" ? "reception_room" : "meeting_room", excludePrevious: true };
}

export function parseExplicitFacilityQuery(prompt: string): string | undefined {
  const normalized = prompt.normalize("NFKC");
  const match = normalized.match(
    /(?:会議室|設備)\s*(?:は|を)\s*[、,]?\s*([^、。\n]{1,60}?)(?:\s*(?:で(?:お願いします)?|に(?:して)?)(?=[、。\s]|$)|[、。\n]|$)/,
  );
  return parseFlexibleFacilityQuery(match?.[1])?.query;
}

/**
 * Convert a natural location-scoped room request into the stable token used
 * to match DeskNet's facility inventory. Exact room names are left untouched.
 */
export function parseFlexibleFacilityQuery(
  value: string | null | undefined,
): {
  query: string;
  facilityType?: "meeting_room" | "reception_room" | "any";
} | undefined {
  const cleaned = cleanQuery(value ?? undefined);
  if (cleaned === undefined) return undefined;

  const scopedRoom = cleaned.match(
    /^(.+?)(?:の|で)(?:(?:どこか|どれか|いずれか)(?:の)?|(?:空いている|空いてる|空きの))(会議室|応接室|ミーティングルーム|ルーム|設備)(?:なら)?(?:どこでも|どれでも|いずれでも)?(?:いい|よい)?$/,
  ) ?? cleaned.match(
    /^(.+?)の(会議室|応接室|ミーティングルーム|ルーム|設備)(?:なら)?(?:どこでも|どれでも|いずれでも)(?:いい|よい)?$/,
  ) ?? cleaned.match(
    /^([^、。!?！？\n]+?)の(会議室|応接室|ミーティングルーム|ルーム|設備)$/,
  );
  if (scopedRoom?.[1] === undefined || scopedRoom[2] === undefined) {
    return { query: cleaned };
  }

  const query = scopedRoom[1].trim();
  if (query === "") return { query: cleaned };
  return {
    query,
    facilityType: readFallbackType(scopedRoom[2]) ?? "any",
  };
}

function readFallbackType(
  value: string | undefined,
): FacilityChangeRequest["fallbackType"] | undefined {
  if (value === undefined || value === "設備" || value === "ルーム") return undefined;
  if (value === "応接室") return "reception_room";
  return "meeting_room";
}

function cleanQuery(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/^(?:会議室|設備)\s*(?:は|を)?\s*/, "")
    .replace(/[「」"']/g, "")
    .trim();
  return cleaned ? cleaned : undefined;
}
