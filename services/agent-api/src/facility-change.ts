import type { DeskNetsStructuredCommand } from "./structured-command.js";

export interface FacilityChangeRequest {
  preferredQuery: string;
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
  const preferredQuery = cleanQuery(command.facility.preferred ?? undefined);
  if (preferredQuery === undefined) return undefined;
  const fallbackQuery = cleanQuery(command.facility.fallbackLocation ?? undefined);
  return {
    preferredQuery,
    ...(command.facility.anyAvailable && fallbackQuery !== undefined
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
  const preferredQuery = cleanQuery(preferredLine ?? inline);
  if (!preferredQuery || preferredQuery === "以下") return undefined;

  const fallbackMatch = normalized.match(
    /(?:空いてい?なければ|あいてい?なければ|空いてい?なかったら|あいてい?なかったら|空きがなければ|埋まっていれば|埋まっていたら|埋まってたら|予約済みなら|使用中なら|なければ|だめなら)[、,\s]*(?:代わりに)?([^\s、。\n]{2,30}?)(?:の(?:どの|いずれの|空いている)?(会議室|応接室|ミーティングルーム|ルーム|設備)|なら|で)/,
  );
  const fallbackQuery = cleanQuery(fallbackMatch?.[1]);
  const fallbackType = readFallbackType(fallbackMatch?.[2]);
  return {
    preferredQuery,
    ...(fallbackQuery === undefined
      ? {}
      : { fallbackQuery, fallbackType: fallbackType ?? "any" }),
  };
}

export function parseExplicitFacilityQuery(prompt: string): string | undefined {
  const normalized = prompt.normalize("NFKC");
  const match = normalized.match(
    /(?:会議室|設備)\s*(?:は|を)\s*[、,]?\s*([^、。\n]{1,60}?)(?:\s*(?:で(?:お願いします)?|に(?:して)?)(?=[、。\s]|$)|[、。\n]|$)/,
  );
  return cleanQuery(match?.[1]);
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
