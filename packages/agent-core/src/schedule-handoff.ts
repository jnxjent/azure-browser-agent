import type { BookingApprovalRequest } from "./contracts.js";
import { upsertWebMeetingBlock } from "./web-meeting.js";

export type CalendarTarget = { provider: "desknets" | "microsoft365"; connectionId: string };
export type ScheduleIdentity = {
  displayName: string;
  // A name from the legacy worker is not a provider ID.
  resolution: { status: "unresolved" } | { status: "resolved"; providerId: string };
};
export interface ScheduleDraft {
  schemaVersion: 1;
  id: string;
  revision: number;
  ownerId: string;
  threadId: string;
  target: CalendarTarget;
  expiresAt: string;
  title: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
  attendees: ScheduleIdentity[];
  resources: ScheduleIdentity[];
  notificationIntent: "send" | "do_not_send";
  confirmation: "native_manual";
}

export interface TeamsMeetingInformation {
  joinUrl: string;
  meetingId?: string;
  passcode?: string;
}

/**
 * Pure formatting only: this never creates a Teams meeting or sends invitations.
 * Superseded by `upsertWebMeetingBlock`, which also replaces a changed block instead of
 * only suppressing an identical one at the end. Kept as the narrow entry point used where
 * only a join URL and optional ID/passcode are known.
 */
export function appendTeamsInformation(description: string, meeting: TeamsMeetingInformation): string {
  return upsertWebMeetingBlock(description, {
    joinUrl: meeting.joinUrl,
    ...(meeting.meetingId === undefined ? {} : {meetingId: meeting.meetingId}),
    ...(meeting.passcode === undefined
      ? {passcodeAvailability: "unavailable" as const}
      : {passcode: meeting.passcode, passcodeAvailability: "required" as const}),
  });
}

export function draftFromDeskNetsApproval(
  approval: BookingApprovalRequest,
  metadata: Pick<ScheduleDraft, "id" | "ownerId" | "threadId" | "expiresAt"> & { connectionId: string },
): ScheduleDraft {
  const unresolved = (displayName: string): ScheduleIdentity => ({displayName, resolution:{status:"unresolved"}});
  return {
    schemaVersion:1, id:metadata.id, revision:1, ownerId:metadata.ownerId,
    threadId:metadata.threadId, expiresAt:metadata.expiresAt,
    target:{provider:"desknets",connectionId:metadata.connectionId},
    title:approval.title, description:"", start:approval.start, end:approval.end,
    timeZone:"Asia/Tokyo", attendees:approval.participantIds.map(unresolved),
    resources:approval.facilityId ? [unresolved(approval.facilityId)] : [],
    notificationIntent:approval.emailNotificationWillBeSent ? "send" : "do_not_send",
    confirmation:"native_manual",
  };
}

/** Trusted adapter result. A prepared native form is explicitly NOT a booking. */
export interface NativeFormPreparation {
  draftId: string;
  revision: number;
  status: "awaiting_native_confirmation";
  registered: false;
  message: string;
}

export function validateDraftForHandoff(
  draft: ScheduleDraft,
  request: { ownerId: string; threadId: string; revision: number; target: CalendarTarget },
  now: Date = new Date(),
): void {
  if (draft.schemaVersion !== 1 || draft.confirmation !== "native_manual") throw new Error("Unsupported draft.");
  if (!draft.id || !draft.ownerId || !draft.threadId || !draft.target.connectionId ||
      draft.ownerId !== request.ownerId || draft.threadId !== request.threadId ||
      draft.target.provider !== request.target.provider || draft.target.connectionId !== request.target.connectionId) {
    throw new Error("Draft ownership or target mismatch.");
  }
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 1 || draft.revision !== request.revision) {
    throw new Error("Stale draft revision.");
  }
  const instant = (value: string): number => {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid instant.");
    return Date.parse(value);
  };
  if (!Number.isFinite(now.getTime()) || instant(draft.expiresAt) <= now.getTime()) throw new Error("Draft expired.");
  if (instant(draft.start) <= now.getTime() || instant(draft.end) <= instant(draft.start)) throw new Error("Invalid meeting interval.");
  new Intl.DateTimeFormat("en", {timeZone:draft.timeZone});
  if (!draft.title.trim() || draft.attendees.length === 0) throw new Error("Incomplete draft.");
  for (const identities of [draft.attendees, draft.resources]) {
    const ids = new Set<string>();
    for (const identity of identities) {
      if (!identity.displayName.trim() || identity.resolution.status !== "resolved" || !identity.resolution.providerId.trim()) {
        throw new Error("Unresolved participant or resource.");
      }
      if (ids.has(identity.resolution.providerId)) throw new Error("Duplicate provider identity.");
      ids.add(identity.resolution.providerId);
    }
  }
}

/** Call only after the adapter compares every native form field with this revision. */
export function nativeFormPrepared(draft: ScheduleDraft): NativeFormPreparation {
  return {draftId:draft.id, revision:draft.revision, status:"awaiting_native_confirmation",
    registered:false, message:"入力内容を確認し、接続先の追加・保存ボタンを手動で押してください。まだ登録されていません。"};
}
