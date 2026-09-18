export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_user_input",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunMode = "read" | "write";

export type BrowserAction =
  | { type: "open_page"; url: string }
  | { type: "click"; target: string }
  | { type: "type_text"; target: string; text: string }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "wait"; milliseconds: number };

export interface Observation {
  id: string;
  capturedAt: string;
  pageUrl: string;
  pageTitle: string;
  screenshotRef: string;
  visibleElements: string[];
  summary: string;
}

export interface RunStep {
  sequence: number;
  observationBefore: Observation;
  reasoning: string;
  action: BrowserAction;
  observationAfter: Observation;
  verified: boolean;
}

export interface CreateRunInput {
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  userId: string;
  threadId: string;
  site: "mock" | "desknets";
  prompt: string;
  mode: RunMode;
}

export interface ParticipantSelector {
  name: string;
  organization?: string;
  /** Self-department preference only: search company-wide if no local match. */
  organizationFallback?: boolean;
}

export interface FindAvailabilityTask {
  type: "find_availability";
  participants: ParticipantSelector[];
  date: string;
  endDate: string;
  durationMinutes: number;
  facilityQuery?: string;
  title?: string;
  /** Offer up to five chronological choices, marking the first as earliest. */
  selectionMode?: "earliest";
  /** Search ahead for several choices only when the user did not specify a period. */
  autoExtendSearch?: boolean;
}

export interface BookMeetingTask {
  /** Recheck rooms for the saved meeting; never submit the final registration. */
  facilityOnlyChange?: boolean;
  previousFacilityId?: string;
  facilityScope?: string;
  excludePreviousFacility?: boolean;
  type: "book_meeting";
  facilityQuery?: string;
  title: string;
  sendEmail: boolean;
  selectedStart?: string;
  selectedEnd?: string;
}

export interface ChangeAvailabilityDurationTask {
  type: "change_availability_duration";
  durationMinutes: number;
}

export interface FindFacilityAvailabilityTask {
  type: "find_facility_availability";
  facilityQuery: string;
}

export interface SelectBookingCandidateTask {
  type: "select_booking_candidate";
  candidateNumber: number;
}

export interface SetEmailNotificationTask {
  type: "set_email_notification";
  sendEmail: boolean;
}

/**
 * "やっぱりやめて、候補に戻して" — the user changed their mind about the
 * booking in progress and wants the last candidate list re-displayed. This
 * is a pure re-display of data already held in the thread's conversation
 * state; it never touches the browser.
 */
export interface ShowCandidatesTask {
  type: "show_candidates";
}

export type DeskNetsTask =
  | { type: "clarify"; question: string }
  | FindAvailabilityTask
  | ChangeAvailabilityDurationTask
  | FindFacilityAvailabilityTask
  | SelectBookingCandidateTask
  | SetEmailNotificationTask
  | ShowCandidatesTask
  | BookMeetingTask;

/**
 * A requested participant name matched people in more than one
 * organization (e.g. two people named 山本, one in 経営企画部 and one in
 * 三晃) and no organization was named in the request to disambiguate. This
 * carries what's needed to re-dispatch the same find_availability search
 * once the user picks one, since (unlike PendingBookingContext) no search
 * has actually succeeded yet at this point.
 */
export interface PendingParticipantChoice {
  task: FindAvailabilityTask;
  /**
   * Position of the ambiguous participant within task.participants. Resolving
   * by index (not by name) matters when the same name appears more than once
   * in the request (e.g. "営業部の山本さんと、山本さん") — only the specific
   * ambiguous one should be updated with the chosen organization.
   */
  participantIndex: number;
  ambiguousName: string;
  organizations: string[];
}

export interface PendingBookingContext {
  selectionMode?: "earliest";
  autoExtendSearch?: boolean;
  originalAvailability?: BookableAvailabilitySlot[];
  originalAllFacilityAvailability?: BookableAvailabilitySlot[];
  date: string;
  endDate?: string;
  durationMinutes: number;
  participants?: ParticipantSelector[];
  facilityQuery?: string;
  title?: string;
  participantIds: string[];
  availability: BookableAvailabilitySlot[];
  /** Company-wide facility availability retained for changing location later. */
  allFacilityAvailability?: BookableAvailabilitySlot[];
  /** The requesting user's DeskNet's "代表組織", read from their own profile. */
  userOrganization?: string;
  /** The requesting user's DeskNet's display name, read from the schedule page's username control. */
  userDisplayName?: string;
}

export interface BookingResult {
  title: string;
  start: string;
  end: string;
  participantIds: string[];
  facilityId: string;
  emailNotificationConfigured: boolean;
  verified: boolean;
}

export interface BookingApprovalRequest {
  /** Verified native user IDs, not the legacy participantIds display names. */
  nativeUserIds?: string[];
  title: string;
  start: string;
  end: string;
  participantIds: string[];
  facilityId: string;
  emailNotificationWillBeSent: boolean;
}

export interface ManualBookingActionRequest {
  nativeUserIds?: string[];
  title: string;
  start: string;
  end: string;
  participantIds: string[];
  facilityId: string;
  emailNotificationWillBeSent: boolean;
  selfNotificationSuppressed: false;
}

export interface MeetingProposal {
  title: string;
  start: string;
  end: string;
  participantIds: string[];
  facilityId: string;
}

export interface RunApproval {
  requestedAt: string;
  approvedAt?: string;
}

export interface BrowserRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  input: CreateRunInput;
  task?: DeskNetsTask;
  intentSource?: "azure_openai" | "deterministic";
  context?: PendingBookingContext;
  approval?: RunApproval;
  status: RunStatus;
  steps: RunStep[];
  result?: {
    summary: string;
    assistantMessage?: string;
    evidence: string[];
    availability?: Array<CommonAvailabilitySlot | BookableAvailabilitySlot>;
    pendingBooking?: PendingBookingContext;
    participantChoice?: PendingParticipantChoice;
    meetingProposal?: MeetingProposal;
    approvalRequest?: BookingApprovalRequest;
    manualActionRequest?: ManualBookingActionRequest;
    facilityAlternatives?: string[];
    booking?: BookingResult;
  };
  error?: string;
}

export interface RunLimits {
  allowedDomains: string[];
  maxSteps: number;
  maxRunDurationMs: number;
}

export interface RunExecutor {
  execute(run: BrowserRun, signal: AbortSignal): Promise<BrowserRun>;
}
import type {
  BookableAvailabilitySlot,
  CommonAvailabilitySlot,
} from "./availability.js";
