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
 * Each story that emits one of these (or a new action of its own) is
 * responsible for keeping it here; an action added to a writer but never
 * added here silently never appears in the clinic's activity log, which is
 * the intended failure mode.
 *
 * THE INVERSE FAILURE — an action listed here with no writer anywhere — is
 * NOT intended, and was real: `clinical.entry.created`, `queue.
 * patient_checked_in` and `waitlist.offer_accepted` sat here for a full
 * release with nothing writing them, so the log promised activity it could
 * never show. `activity-allowlist.spec.ts` now scans `src/` and fails if any
 * entry below has no writer, so a dead entry cannot be introduced again.
 *
 * ONLY MEANINGFUL ACTIONS BELONG HERE. Reads, queries, renders and technical
 * operations are deliberately absent — high-volume clinical reads have their
 * own dedicated table (`clinical_access_logs`) precisely so they never reach
 * this surface (FR-H012).
 */
export const ACTIVITY_VISIBLE_AUDIT_ACTIONS = [
  // ── Appointments — staff-initiated (the clinic's core operational work) ──
  // Emitted for every source EXCEPT PUBLIC_AI, which has its own dedicated
  // action below; `cancelled`/`rescheduled` are emitted only for
  // STAFF-origin calls, since the patient-initiated variants are separate
  // actions. That split is what keeps one real-world event from producing
  // two audit rows.
  'appointment.created',
  'appointment.updated',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.status_changed',
  // Patient self-service (S1, S2) — actor-less by nature (a signed link).
  'appointment.cancelled_by_patient',
  'appointment.rescheduled_by_patient',
  // Public booking (S4/US4)
  'appointment.booked_publicly',
  // Clinical records (S6) — WRITES only; clinical reads never appear here.
  'clinical.entry.created',
  'clinical.entry.corrected',
  // Queue management (S10)
  'queue.patient_checked_in',
  // Waitlist (S9)
  'waitlist.offer_accepted',
  // ── Staff & access administration ───────────────────────────────────────
  // Already written to `audit_logs` with a tenant AND an actor by
  // `StaffService.auditRoleChange` / `StaffAccessService.audit` since well
  // before this surface existed — they were simply never allow-listed, so
  // the clinic could not see who changed whose access. Listing them needs no
  // new writer at all.
  'staff.role.assigned',
  'staff.role.changed',
  'staff.dashboard_access.invitation_resent',
  // ── Marketing (S7 email, S8 segmentation) ───────────────────────────────
  'campaign.launched',
  'campaign.unsubscribed',
  // ── Notifications ───────────────────────────────────────────────────────
  // A human override of the platform's at-most-once send guarantee — exactly
  // the kind of deliberate operator action a clinic should be able to review.
  'notification.retry_override',
  // ── Recurring billing (S5) ──────────────────────────────────────────────
  'subscription.renewal_attempted',
  'subscription.renewal_declined',
  'subscription.renewal_settled',
  // ── Data egress ─────────────────────────────────────────────────────────
  'report.exported',
  'invoice.document_downloaded',
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
