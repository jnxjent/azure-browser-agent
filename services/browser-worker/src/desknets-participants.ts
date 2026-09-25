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
      "ログインユーザーの所属部署をDeskNet'sから取得できないため、「当部」の参加者を特定できません。正式な部署名を指定してください。",
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
  const local = matches.filter(match => match.organization.includes(selector.organization!));
  return local.length === 0 && selector.organizationFallback ? matches : local;
}

/** The common spelling 高田 refers to 髙田 in this workflow. */
export function participantNameSearchVariants(name: string): string[] {
  if (name.startsWith("高田")) return [`髙田${name.slice(2)}`, name];
  if (name.startsWith("髙田")) return [name, `高田${name.slice(2)}`];
  return [name];
}
