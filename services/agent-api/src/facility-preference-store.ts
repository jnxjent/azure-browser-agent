import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FacilityPreferenceEntry {
  userId: string;
  facilities: string[];
  updatedAt: string;
}

interface StoredPreferences {
  version: 1;
  users: Record<string, Omit<FacilityPreferenceEntry, "userId">>;
}

export class FacilityPreferenceStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(userId: string): Promise<FacilityPreferenceEntry | undefined> {
    const normalizedUserId = readUserId(userId);
    const stored = await this.read();
    const entry = stored.users[normalizedUserId];
    return entry === undefined
      ? undefined
      : { userId: normalizedUserId, ...entry, facilities: [...entry.facilities] };
  }

  async upsert(userId: unknown, facilities: unknown): Promise<FacilityPreferenceEntry> {
    const normalizedUserId = readUserId(userId);
    const normalizedFacilities = readFacilities(facilities);
    let saved: FacilityPreferenceEntry | undefined;
    await this.enqueue(async () => {
      const stored = await this.read();
      saved = {
        userId: normalizedUserId,
        facilities: normalizedFacilities,
        updatedAt: new Date().toISOString(),
      };
      stored.users[normalizedUserId] = {
        facilities: [...normalizedFacilities],
        updatedAt: saved.updatedAt,
      };
      await this.write(stored);
    });
    return saved as FacilityPreferenceEntry;
  }

  async remove(userId: string): Promise<boolean> {
    const normalizedUserId = readUserId(userId);
    let removed = false;
    await this.enqueue(async () => {
      const stored = await this.read();
      if (stored.users[normalizedUserId] === undefined) return;
      delete stored.users[normalizedUserId];
      removed = true;
      await this.write(stored);
    });
    return removed;
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.updateQueue.then(operation, operation);
    this.updateQueue = pending.catch(() => undefined);
    await pending;
  }

  private async read(): Promise<StoredPreferences> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.users)) {
        throw new Error("Meeting-room preference file has an invalid structure.");
      }
      const users: StoredPreferences["users"] = {};
      for (const [userId, value] of Object.entries(parsed.users)) {
        if (!isRecord(value) || typeof value.updatedAt !== "string") {
          throw new Error("Meeting-room preference file has an invalid user entry.");
        }
        users[readUserId(userId)] = {
          facilities: readFacilities(value.facilities),
          updatedAt: value.updatedAt,
        };
      }
      return { version: 1, users };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, users: {} };
      }
      throw error;
    }
  }

  private async write(stored: StoredPreferences): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

export function parseFacilityPreferenceRegistration(prompt: string): string[] | undefined {
  const normalized = prompt.normalize("NFKC").trim();
  const match = normalized.match(
    /会議室(?:の)?優先順位(?:を|は|[:：])?[、,\s]*([\s\S]+?)(?:の順(?:番)?(?:で|に)?|として)?登録して(?:ください)?[。.!！]?$/,
  );
  if (match?.[1] === undefined) return undefined;
  const facilities = match[1]
    .replace(/[「」『』"']/g, "")
    .split(/\s*(?:、|,|→|>|＞|次に|その次(?:に)?|優先で)\s*/)
    .map((value) => value.trim().replace(/^(?:まず|第一優先は|第\d+優先は)/, "").trim())
    .filter(Boolean);
  return facilities.length === 0 ? undefined : readFacilities(facilities);
}

function readUserId(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("userId must be a string.");
  const userId = value.normalize("NFKC").trim();
  if (userId === "" || userId.length > 200 || /[\r\n\t]/.test(userId)) {
    throw new TypeError("userId must be a non-empty single-line string.");
  }
  return userId;
}

function readFacilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new TypeError("facilities must be an array containing 1 to 20 names.");
  }
  const facilities = value.map((item) => {
    if (typeof item !== "string") throw new TypeError("facility names must be strings.");
    const facility = item.normalize("NFKC").trim();
    if (facility === "" || facility.length > 100 || /[\r\n\t]/.test(facility)) {
      throw new TypeError("facility names must be non-empty single-line strings.");
    }
    return facility;
  });
  return Array.from(new Set(facilities));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
