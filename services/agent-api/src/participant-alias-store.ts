import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ParticipantAlias {
  alias: string;
  formalName: string;
}

export class ParticipantAliasStore {
  private aliases: ParticipantAlias[] | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(): Promise<ParticipantAlias[]> {
    await this.ensureLoaded();
    return [...(this.aliases ?? [])].sort((left, right) =>
      left.alias.localeCompare(right.alias, "ja"),
    );
  }

  async upsert(aliasValue: unknown, formalNameValue: unknown): Promise<ParticipantAlias> {
    const alias = validateDictionaryValue(aliasValue, "alias");
    const formalName = validateDictionaryValue(formalNameValue, "formalName");
    if (normalizeKey(alias) === normalizeKey(formalName)) {
      throw new TypeError("呼称と正式名には異なる値を指定してください。");
    }
    const entry = { alias, formalName };
    await this.enqueueMutation(async () => {
      await this.ensureLoaded();
      const aliases = this.aliases ?? [];
      const index = aliases.findIndex(
        (candidate) => normalizeKey(candidate.alias) === normalizeKey(alias),
      );
      if (index === -1) aliases.push(entry);
      else aliases[index] = entry;
      this.aliases = aliases;
      await this.persist();
    });
    return entry;
  }

  async remove(aliasValue: unknown): Promise<boolean> {
    const alias = validateDictionaryValue(aliasValue, "alias");
    let removed = false;
    await this.enqueueMutation(async () => {
      await this.ensureLoaded();
      const aliases = this.aliases ?? [];
      const next = aliases.filter(
        (candidate) => normalizeKey(candidate.alias) !== normalizeKey(alias),
      );
      removed = next.length !== aliases.length;
      if (removed) {
        this.aliases = next;
        await this.persist();
      }
    });
    return removed;
  }

  async replaceAliases(prompt: string): Promise<string> {
    const normalizedPrompt = prompt.normalize("NFKC");
    const aliases = (await this.list()).sort(
      (left, right) => right.alias.length - left.alias.length,
    );
    if (aliases.length === 0) return normalizedPrompt;

    const byKey = new Map(aliases.map((entry) => [normalizeKey(entry.alias), entry.formalName]));
    const alternatives = aliases.map((entry) => escapeRegExp(entry.alias.normalize("NFKC"))).join("|");
    const pattern = new RegExp(
      `(^|[\\s、,，・と])(${alternatives})(?=さん|$|[\\s、,，・とではがをにの])`,
      "giu",
    );
    return normalizedPrompt.replace(pattern, (_match, prefix: string, alias: string) =>
      `${prefix}${byKey.get(normalizeKey(alias)) ?? alias}`,
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.aliases !== undefined) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.aliases = parseStoredAliases(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.aliases = [];
        return;
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ aliases: await this.list() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.filePath);
  }

  private async enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.catch(() => {});
    await next;
  }
}

function parseStoredAliases(value: unknown): ParticipantAlias[] {
  if (!isRecord(value) || !Array.isArray(value.aliases)) {
    throw new TypeError("Participant alias dictionary must contain an aliases array.");
  }
  const aliases = value.aliases.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("Participant alias entry must be an object.");
    return {
      alias: validateDictionaryValue(entry.alias, "alias"),
      formalName: validateDictionaryValue(entry.formalName, "formalName"),
    };
  });
  if (new Set(aliases.map((entry) => normalizeKey(entry.alias))).size !== aliases.length) {
    throw new TypeError("Participant alias dictionary contains duplicate aliases.");
  }
  return aliases;
}

function validateDictionaryValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized === "" || normalized.length > 40) {
    throw new TypeError(`${field} must contain between 1 and 40 characters.`);
  }
  if (/[\r\n\t、,，・]/.test(normalized)) {
    throw new TypeError(`${field} contains an unsupported separator.`);
  }
  return normalized;
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
