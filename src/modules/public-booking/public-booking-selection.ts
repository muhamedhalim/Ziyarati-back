import {
  SESSION_UNSET,
  type SessionPatch,
} from '../ai-orchestrator/conversation-session.service';

/**
 * What a public-booking selection writes to the conversation session, in one
 * place, for BOTH booking paths: the AI `select_*` tools
 * (`AiToolDispatchService`) and the deterministic flow
 * (`PublicBookingFlowService`). FR-P003 requires that neither path can book
 * something the other would refuse; the cascade below is part of that — a
 * selection must invalidate every choice that depended on it.
 *
 * Every reset uses `SESSION_UNSET`, never `undefined`: `ConversationSessionService`
 * drops `undefined` to PRESERVE the stored value, so an `undefined` "reset" is a
 * silent no-op (the AI-006 / F-21 bug).
 */
export type SelectionPatch = Pick<
  SessionPatch,
  | 'selectedClinicId'
  | 'selectedBranchId'
  | 'selectedDoctorId'
  | 'selectedServiceIds'
  | 'selectedStartAt'
>;

/** A new clinic invalidates every downstream choice; a single-branch clinic needs no branch pick. */
export function clinicSelectedPatch(
  clinicId: string,
  onlyBranchId?: string,
): SelectionPatch {
  return {
    selectedClinicId: clinicId,
    selectedBranchId: onlyBranchId,
    selectedDoctorId: SESSION_UNSET,
    selectedServiceIds: SESSION_UNSET,
    selectedStartAt: SESSION_UNSET,
  };
}

/** Doctors and services are branch-specific, so a branch change invalidates them and the time. */
export function branchSelectedPatch(
  clinicId: string,
  branchId: string,
): SelectionPatch {
  return {
    selectedClinicId: clinicId,
    selectedBranchId: branchId,
    selectedDoctorId: SESSION_UNSET,
    selectedServiceIds: SESSION_UNSET,
    selectedStartAt: SESSION_UNSET,
  };
}

/** Records the service set only. */
export function servicesSelectedPatch(serviceIds: string[]): SelectionPatch {
  return { selectedServiceIds: serviceIds };
}

/** A different doctor has a different calendar, so a previously chosen time is stale. */
export function doctorSelectedPatch(staffId: string): SelectionPatch {
  return { selectedDoctorId: staffId, selectedStartAt: SESSION_UNSET };
}

export function slotSelectedPatch(startAt: string): SelectionPatch {
  return { selectedStartAt: startAt };
}
