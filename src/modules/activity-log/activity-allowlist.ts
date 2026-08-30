/**
 * Spec 014 (Clinic Platform Completion) — T023 (S7, FR-U007). The
 * clinic-facing activity log's allow-list, modeled exactly on
 * `SupportActivityService`/`SUPPORT_VISIBLE_AUDIT_ACTIONS`: `audit_logs.action`
 * is an open string written by dozens of services, so only actions named
 * HERE are ever surfaced. The default is EXCLUSION — an action nobody added
 * to this list is invisible, not a bug to fix later (FR-U007). A clinic-
 * facing controller does NOT belong on `PLATFORM_AND_PUBLIC_SURFACES`
 * (that set is for HTTP entitlement, unrelated to this).
 *
 * Seeded from contracts/internal-seams.md §9's own example list — the
 * action strings this spec's OWN stories introduce. Each story that emits
 * one of these (or a new action of its own) is responsible for keeping it
 * here; an action added to a writer but never added here silently never
 * appears in the clinic's activity log, which is the intended failure mode.
 */
export const ACTIVITY_VISIBLE_AUDIT_ACTIONS = [
  // Patient self-service (S1, S2)
  'appointment.cancelled_by_patient',
  'appointment.rescheduled_by_patient',
  // Clinical records (S6)
  'clinical.entry.created',
  'clinical.entry.corrected',
  // Campaigns / email marketing (S7 email, S8 segmentation)
  'campaign.launched',
  'campaign.unsubscribed',
  // Recurring billing (S5)
  'subscription.renewal_attempted',
  'subscription.renewal_declined',
  'subscription.renewal_settled',
  // Report export (S13)
  'report.exported',
  // Invoice PDF (S12)
  'invoice.document_downloaded',
  // Queue management (S10)
  'queue.patient_checked_in',
  // Waitlist (S9)
  'waitlist.offer_accepted',
  // Public booking (S4/US4)
  'appointment.booked_publicly',
] as const;

export type ActivityVisibleAction =
  (typeof ACTIVITY_VISIBLE_AUDIT_ACTIONS)[number];

const ALLOWED_SET: ReadonlySet<string> = new Set(
  ACTIVITY_VISIBLE_AUDIT_ACTIONS,
);

/** Whether `action` may ever be surfaced in the clinic-facing activity log. */
export function isActivityVisible(action: string): boolean {
  return ALLOWED_SET.has(action);
}
