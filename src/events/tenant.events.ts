/**
 * Tenant (clinic) lifecycle domain events.
 *
 * `TenantService` contains zero occurrences of `emit`, `notif` or `email`:
 * approve, reject and suspend write a `TenantApprovalEvent` audit row and
 * nothing else, so a clinic is never told its account was approved, rejected or
 * suspended. Closing that is Phase 2 of the internal-notifications work.
 *
 * This file starts with the ONE tenant notification that already exists, so it
 * can be moved onto the new substrate rather than left behind on the old one:
 *
 * `VERIFICATION_SUBMITTED` was previously written directly into
 * `admin_notifications` by `TenantVerificationService.submitForReview` — the
 * single producer for that entire table. Two problems made leaving it there
 * untenable once the platform shell gained the new bell:
 *
 *   1. `admin_notifications.is_read` is a single GLOBAL boolean, so one admin
 *      reading a notification clears the badge for every other admin.
 *   2. Keeping both systems would have meant two bells in one header, or
 *      super-admins seeing verification submissions but not support tickets.
 *
 * The legacy table, service and routes are left in place and untouched; they
 * simply stop receiving new rows. That keeps this reversible.
 */
export const TENANT_EVENT = {
  VERIFICATION_SUBMITTED: 'tenant.verification.submitted',
} as const;

export type TenantEventName =
  (typeof TENANT_EVENT)[keyof typeof TENANT_EVENT];

/**
 * A clinic has uploaded every required document and is awaiting review.
 *
 * PLATFORM-scoped: the clinic performed this action and needs no notification
 * about it; the platform operators who must now review it do.
 */
export class TenantVerificationSubmittedEvent {
  static readonly eventName = TENANT_EVENT.VERIFICATION_SUBMITTED;
  constructor(
    readonly tenantId: string,
    readonly clinicName: string,
    /** The clinic user who submitted — excluded from recipients. */
    readonly actorUserId: string | null,
  ) {}
}
