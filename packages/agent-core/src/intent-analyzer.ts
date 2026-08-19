import type { DeskNetsTask } from "./contracts.js";
import { parseDeskNetsTask } from "./desknets-intent.js";

export interface IntentAnalysis {
  task: DeskNetsTask;
  source: "azure_openai" | "deterministic";
}

export interface AzureOpenAIIntentConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
}

export interface AnalyzeIntentOptions {
  config?: AzureOpenAIIntentConfig;
  fetchImplementation?: typeof fetch;
}

interface StructuredIntent {
  intent: "find_availability" | "change_availability_duration" | "find_facility_availability" | "select_booking_candidate" | "set_email_notification" | "book_meeting";
  participantNames: string[];
  dateStart: string | null;
  dateEnd: string | null;
  durationMinutes: number | null;
  facilityQuery: string | null;
  candidateNumber: number | null;
  sendEmail: boolean | null;
  title: string | null;
  selectedStart: string | null;
  selectedEnd: string | null;
}

export async function analyzeDeskNetsIntent(
  prompt: string,
  now: Date = new Date(),
  options: AnalyzeIntentOptions = {},
): Promise<IntentAnalysis> {
  const config = options.config ?? readAzureOpenAIIntentConfig();
  if (config === undefined) {
    return { task: parseDeskNetsTask(prompt, now), source: "deterministic" };
  }
  try {
    const structured = await requestStructuredIntent(
      prompt,
      now,
      config,
      options.fetchImplementation ?? fetch,
    );
    return { task: validateStructuredIntent(structured), source: "azure_openai" };
  } catch {
    return { task: parseDeskNetsTask(prompt, now), source: "deterministic" };
  }
}

export function readAzureOpenAIIntentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AzureOpenAIIntentConfig | undefined {
  const endpoint = environment.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = environment.AZURE_OPENAI_API_KEY?.trim();
  const deployment = environment.AZURE_OPENAI_DEPLOYMENT?.trim();
  if (!endpoint || !apiKey || !deployment) return undefined;
  return { endpoint, apiKey, deployment };
}

async function requestStructuredIntent(
  prompt: string,
  now: Date,
  config: AzureOpenAIIntentConfig,
  fetchImplementation: typeof fetch,
): Promise<StructuredIntent> {
  const response = await fetchImplementation(chatCompletionsUrl(config.endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": config.apiKey },
    body: JSON.stringify({
      model: config.deployment,
      messages: [
        {
          role: "system",
          content: [
            "Analyze a Japanese DeskNet's scheduling request into the supplied JSON schema.",
            `Current instant: ${now.toISOString()}. Calendar timezone: Asia/Tokyo.`,
            "Resolve 今日, 明日, N週間以内, 今週, 来週, 今月中, and explicit ranges to inclusive YYYY-MM-DD dates.",
            "For N週間以内, start today and include N*7 calendar days including today.",
            "Use change_availability_duration when a follow-up only changes the meeting length.",
            "For a direct booking, return selectedStart and selectedEnd as ISO 8601 instants with the Asia/Tokyo offset represented correctly.",
            "Never authorize a browser write. Application policy performs separate final approval.",
            "Use null for fields that do not apply. Keep Japanese names exactly as written, removing さん from participant names.",
          ].join("\n"),
        },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "desknets_intent", strict: true, schema: INTENT_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Azure OpenAI intent request failed: ${response.status}`);
  const body = (await response.json()) as unknown;
  return JSON.parse(readCompletionContent(body)) as StructuredIntent;
}

function validateStructuredIntent(value: StructuredIntent): DeskNetsTask {
  if (value.intent === "find_availability") {
    if (value.participantNames.length === 0) throw new TypeError("LLM intent omitted participants.");
    const date = readIsoDate(value.dateStart, "dateStart");
    const endDate = readIsoDate(value.dateEnd, "dateEnd");
    if (endDate < date) throw new TypeError("LLM intent returned an invalid date range.");
    const title = value.title === null ? undefined : readText(value.title, "title");
    return {
      type: "find_availability",
      participantNames: value.participantNames.map((name) => readText(name, "participant")),
      date,
      endDate,
      durationMinutes: readDuration(value.durationMinutes),
      ...(title === undefined ? {} : { title }),
    };
  }
  if (value.intent === "find_facility_availability") {
    return { type: "find_facility_availability", facilityQuery: readText(value.facilityQuery, "facilityQuery") };
  }
  if (value.intent === "change_availability_duration") {
    return { type: "change_availability_duration", durationMinutes: readDuration(value.durationMinutes) };
  }
  if (value.intent === "select_booking_candidate") {
    if (!Number.isSafeInteger(value.candidateNumber) || (value.candidateNumber ?? 0) < 1) {
      throw new TypeError("LLM intent returned an invalid candidate number.");
    }
    return { type: "select_booking_candidate", candidateNumber: value.candidateNumber as number };
  }
  if (value.intent === "set_email_notification") {
    if (typeof value.sendEmail !== "boolean") throw new TypeError("LLM intent omitted email choice.");
    return { type: "set_email_notification", sendEmail: value.sendEmail };
  }
  const selectedStart = readOptionalInstant(value.selectedStart, "selectedStart");
  const selectedEnd = readOptionalInstant(value.selectedEnd, "selectedEnd");
  if ((selectedStart === undefined) !== (selectedEnd === undefined)) {
    throw new TypeError("LLM intent must return both selectedStart and selectedEnd.");
  }
  const booking = {
    type: "book_meeting",
    facilityQuery: readText(value.facilityQuery, "facilityQuery"),
    title: value.title === null ? "" : readText(value.title, "title"),
    sendEmail: value.sendEmail ?? false,
  } as const;
  if (selectedStart === undefined) return booking;
  if (selectedEnd === undefined) throw new TypeError("LLM intent omitted selectedEnd.");
  return { ...booking, selectedStart, selectedEnd };
}

function readCompletionContent(value: unknown): string {
  if (typeof value !== "object" || value === null || !("choices" in value) || !Array.isArray(value.choices)) {
    throw new TypeError("Azure OpenAI response is missing choices.");
  }
  const first = value.choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) {
    throw new TypeError("Azure OpenAI response is missing a message.");
  }
  const message = first.message;
  if (typeof message !== "object" || message === null || !("content" in message) || typeof message.content !== "string") {
    throw new TypeError("Azure OpenAI response is missing structured content.");
  }
  return message.content;
}

function readIsoDate(value: string | null, label: string): string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`LLM intent omitted ${label}.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`LLM intent returned invalid ${label}.`);
  }
  return value;
}

function readText(value: string | null, label: string): string {
  const text = value?.trim();
  if (!text) throw new TypeError(`LLM intent omitted ${label}.`);
  return text;
}

function readOptionalInstant(value: string | null, label: string): string | undefined {
  if (value === null) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`LLM intent returned invalid ${label}.`);
  return parsed.toISOString();
}

function readDuration(value: number | null): number {
  if (value === null) return 60;
  if (!Number.isSafeInteger(value) || value < 30 || value > 480) throw new TypeError("LLM intent returned an invalid duration.");
  return value;
}

function chatCompletionsUrl(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/openai/v1")
    ? `${normalized}/chat/completions`
    : `${normalized}/openai/v1/chat/completions`;
}

const nullableString = { type: ["string", "null"] } as const;
const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["find_availability", "change_availability_duration", "find_facility_availability", "select_booking_candidate", "set_email_notification", "book_meeting"] },
    participantNames: { type: "array", items: { type: "string" } },
    dateStart: nullableString,
    dateEnd: nullableString,
    durationMinutes: { type: ["integer", "null"] },
    facilityQuery: nullableString,
    candidateNumber: { type: ["integer", "null"] },
    sendEmail: { type: ["boolean", "null"] },
    title: nullableString,
    selectedStart: nullableString,
    selectedEnd: nullableString,
  },
  required: ["intent", "participantNames", "dateStart", "dateEnd", "durationMinutes", "facilityQuery", "candidateNumber", "sendEmail", "title", "selectedStart", "selectedEnd"],
  additionalProperties: false,
} as const;
