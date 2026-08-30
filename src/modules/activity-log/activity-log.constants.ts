/**
 * Spec 014 (Clinic Platform Completion) — T191 (US14, F14). Pagination
 * defaults/ceilings for the clinic-facing Activity UI. Mirrors
 * `platform-support.constants.ts`'s reasoning: an unbounded scan of
 * `audit_logs` for a clinic with years of history is both a performance
 * hazard (FR-U012) and more than an interactive screen needs.
 */
export const ACTIVITY_LOG_PAGE_SIZE = 20;

/** Hard ceiling on the requested page size. */
export const ACTIVITY_LOG_MAX_PAGE_SIZE = 100;
