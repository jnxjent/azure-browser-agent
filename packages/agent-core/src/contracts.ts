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
  userId: string;
  threadId: string;
  site: "mock" | "desknets";
  prompt: string;
  mode: RunMode;
}

export interface FindAvailabilityTask {
  type: "find_availability";
  participantNames: string[];
  date: string;
  endDate: string;
  durationMinutes: number;
  title?: string;
}

export interface BookMeetingTask {
  type: "book_meeting";
  facilityQuery: string;
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

export type DeskNetsTask =
  | FindAvailabilityTask
  | ChangeAvailabilityDurationTask
  | FindFacilityAvailabilityTask
  | SelectBookingCandidateTask
  | SetEmailNotificationTask
  | BookMeetingTask;

export interface PendingBookingContext {
  date: string;
  endDate?: string;
  durationMinutes: number;
  participantNames?: string[];
  title?: string;
  participantIds: string[];
  availability: BookableAvailabilitySlot[];
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
  title: string;
  start: string;
  end: string;
  participantIds: string[];
  facilityId: string;
  emailNotificationWillBeSent: boolean;
}

export interface ManualBookingActionRequest {
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
    meetingProposal?: MeetingProposal;
    approvalRequest?: BookingApprovalRequest;
    manualActionRequest?: ManualBookingActionRequest;
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
