import type { Page } from "playwright";
import type { ParticipantSelector } from "@azure-browser-agent/agent-core";

const SELF_ORGANIZATION_REFERENCES = new Set([
  "当部",
  "当部署",
  "自部署",
  "同じ部",
  "同じ部署",
  "自部門",
  "同じ部門",
]);

function isSelfOrganizationReference(value: string | undefined): boolean {
  if (value === undefined) return false;
  return SELF_ORGANIZATION_REFERENCES.has(
    value.normalize("NFKC").replace(/\s+/g, "").trim(),
  );
}

export function resolveSelfOrganizationParticipants(
  participants: ParticipantSelector[],
  currentUserOrganization: string | undefined,
  prompt = "",
): ParticipantSelector[] {
  const selfDepartmentRequested = /当部|当部署|自部署|同じ部|自部門/.test(prompt);
  if (!selfDepartmentRequested && !participants.some((participant) => isSelfOrganizationReference(participant.organization))) {
    return participants;
  }

  const organization = currentUserOrganization?.normalize("NFKC").trim();
  if (!organization) {
    throw new Error(
      "ログインユーザーの所属部署をdesknet'sから取得できないため、「当部」の参加者を特定できません。正式な部署名を指定してください。",
    );
  }

  return participants.map((participant) =>
    (isSelfOrganizationReference(participant.organization) ||
      participant.organization === undefined ||
      (selfDepartmentRequested && participant.organization === organization))
      ? { ...participant, organization, organizationFallback: true }
      : participant,
  );
}

export function preferParticipantOrganization<T extends { organization: string }>(
  matches: T[], selector: ParticipantSelector,
): T[] {
  if (!selector.organization) return matches;
  const requested = normalizeOrganizationForLookup(selector.organization);
  const local = matches.filter(match => normalizeOrganizationForLookup(match.organization).includes(requested));
  return local.length === 0 && selector.organizationFallback ? matches : local;
}

function normalizeOrganizationForLookup(value: string): string {
  return value.normalize("NFKC").toUpperCase()
    .replace(/(?:株式会社|\(株\)|㈱)/g, "")
    .replace(/グループ/g, "G")
    .replace(/[\sの・･()（）_\-]/g, "");
}

/** The common spelling 高田 refers to 髙田 in this workflow. */
export function participantNameSearchVariants(name: string): string[] {
  const normalized = name.normalize("NFKC").trim();
  const spellings = normalized.startsWith("高田")
    ? [`髙田${normalized.slice(2)}`, normalized]
    : normalized.startsWith("髙田") ? [normalized, `高田${normalized.slice(2)}`] : [normalized];
  return [...new Set(spellings.flatMap(spelling => [
    spelling.replace(/\s+/g, ""), spelling, spelling.replace(/\s+/g, "　"),
  ]))];
}

/** Ignore name separators, while retaining every character of the requested name. */
export function participantNameMatches(candidate: string | null, requested: string, searchName: string): boolean {
  if (candidate === null) return false;
  const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
  const actual = compact(candidate);
  const expected = compact(searchName);
  // An explicitly separated surname + given name must not select a longer name.
  return /\s/.test(requested.trim()) ? actual === expected : actual.startsWith(expected);
}

/** Remove only a uniquely identified requester using the UI's explicit remove control. */
export async function removeRequesterFromRegistration(page: Page, displayName: string | undefined): Promise<string> {
  if (!displayName?.trim()) throw new Error("登録者の表示名を確認できないため、本人を除外できません。再検索してください。");
  const dialog = page.locator(".co-sel-dialog:visible");
  const rows = dialog.locator(".co-sel-bottom table tbody tr");
  const names = await rows.evaluateAll(elements => elements.map(row => row.querySelector(".name-text")?.textContent?.trim() ?? ""));
  const indices = names.flatMap((name, index) => name === displayName.trim() ? [index] : []);
  if (indices.length !== 1) throw new Error("登録者の行を一意に確認できないため、本人を除外できません。参加者を確認してください。");
  const row = rows.nth(indices[0]!);
  const controls = row.getByRole("button", { name: /^(削除|解除|取り除く|除外|Remove|Delete)$/i })
    .or(row.getByRole("link", { name: /^(削除|解除|取り除く|除外|Remove|Delete)$/i }))
    .or(row.locator('a.co-sel-icon.remove-item[title="選択を解除"], a.remove-item[title="選択解除"]'));
  if (await controls.count() !== 1) throw new Error("登録先の本人削除ボタンを確認できません。本人を含む予約フォームは引き渡しません。");
  await controls.click();
  await page.waitForFunction(({ name, expected }) => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(".co-sel-dialog")).filter(e => e.getClientRects().length > 0);
    const labels = dialogs.flatMap(e => Array.from(e.querySelectorAll(".co-sel-bottom table tbody tr .name-text")).map(e => e.textContent?.trim() ?? ""));
    return labels.length === expected.length && !labels.includes(name) && labels.every((label, index) => label === expected[index]);
  }, { name: displayName.trim(), expected: names.filter((_, index) => index !== indices[0]) }, { timeout: 5000 });
  return displayName.trim();
}
