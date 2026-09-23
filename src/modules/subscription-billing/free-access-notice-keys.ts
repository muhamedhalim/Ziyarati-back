/**
 * Every idempotency / dedupe key the free-access notice pipeline uses, in one
 * place, so the READ side (`FreeAccessOverrideService.getSummary`/
 * `listOverview`, which looks up delivery status) and the WRITE side
 * (`FreeAccessNoticeService`, which actually queues/sends) can never drift
 * apart on the exact string format. See the implementation plan §9/§14
 * ("Free-Access Lifecycle, Notices & Admin Visibility") for the full design.
 *
 * All "expiry" keys use whole EPOCH SECONDS of `ends_at`, never an ISO
 * string: epoch seconds round-trip identically whether computed in Postgres
 * (`EXTRACT(EPOCH FROM ends_at)`) or in Node (`date.getTime() / 1000`), while
 * an ISO string built from a JS `Date` (millisecond precision) can silently
 * disagree with one built in SQL from a `timestamptz` (microsecond
 * precision) if the stored instant ever carries sub-millisecond precision.
 */

/** BullMQ/outbox dedupe key for the one-time "free access started" job. */
export function freeAccessStartOutboxKey(overrideId: string): string {
  return `fa-start-${overrideId}`;
}

/**
 * BullMQ/outbox dedupe key for an expiry-warning job. Distinct per
 * `ends_at` value, so extending the override (a new `ends_at`) naturally
 * gets its own key instead of colliding with an already-delivered one.
 */
export function freeAccessExpiryOutboxKey(
  overrideId: string,
  endsAt: Date,
): string {
  return `fa-expiry-${overrideId}-${epochSeconds(endsAt)}`;
}

/** `in_app_notifications.dedupe_key` for the start notice (per recipient). */
export function freeAccessStartNotificationDedupe(overrideId: string): string {
  return `fa:start:${overrideId}`;
}

/** `in_app_notifications.dedupe_key` for an expiry warning (per recipient). */
export function freeAccessExpiryNotificationDedupe(
  overrideId: string,
  endsAt: Date,
): string {
  return `fa:expiry:${overrideId}:${epochSeconds(endsAt)}`;
}

/** `email_logs.idempotency_key` for the start notice. One email, ever. */
export function freeAccessStartEmailKey(overrideId: string): string {
  return `free-access:${overrideId}:started`;
}

/** `email_logs.idempotency_key` for an expiry warning. */
export function freeAccessExpiryEmailKey(
  overrideId: string,
  endsAt: Date,
): string {
  return `free-access:${overrideId}:expiring:${epochSeconds(endsAt)}`;
}

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
