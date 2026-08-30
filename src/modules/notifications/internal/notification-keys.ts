/**
 * Vocabulary for the INTERNAL (in-app, staff-facing) notification system.
 *
 * Deliberately separate from `../notification.constants.ts`, which describes
 * the OUTBOUND patient-messaging pipeline (send lifecycle, carrier delivery
 * state, WhatsApp channel, `Customer` recipients). The two systems share a
 * module folder and nothing else; keeping their vocabularies apart is what
 * stops a future change to one silently altering the other.
 */

/**
 * Notification categories. These are the unit a USER mutes — not individual
 * keys, because a per-key preference screen with forty rows is a screen nobody
 * configures.
 *
 * Stored as plain text on both `in_app_notifications.category` and
 * `notification_preferences.category`, so adding a category never needs a
 * migration.
 */
export const NOTIFICATION_CATEGORY = {
  /** Support tickets, in both directions (clinic ⇄ platform). */
  SUPPORT: 'SUPPORT',
  /** Bookings, cancellations, reschedules, assignment. */
  APPOINTMENTS: 'APPOINTMENTS',
  /** Live-agent handover and patient conversations. */
  CONVERSATIONS: 'CONVERSATIONS',
  /** Subscription, payments, plan limits, free access, upgrade requests. */
  BILLING: 'BILLING',
  /** Clinic lifecycle, verification, staff membership. */
  ACCOUNT: 'ACCOUNT',
  /** Password, lockout, session reuse, privilege change. Never mutable. */
  SECURITY: 'SECURITY',
  /** Integrations, background work, and platform-generated operational news. */
  SYSTEM: 'SYSTEM',
} as const;

export type NotificationCategory =
  (typeof NOTIFICATION_CATEGORY)[keyof typeof NOTIFICATION_CATEGORY];

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = Object.values(
  NOTIFICATION_CATEGORY,
);

/**
 * Relative importance. Drives ordering and visual weight in the inbox; it is
 * NOT an authorization or delivery-guarantee signal — `mandatory` on the spec
 * is what decides whether a user may opt out.
 */
export const NOTIFICATION_PRIORITY = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

export type NotificationPriority =
  (typeof NOTIFICATION_PRIORITY)[keyof typeof NOTIFICATION_PRIORITY];

export const NOTIFICATION_PRIORITIES: NotificationPriority[] = Object.values(
  NOTIFICATION_PRIORITY,
);

/** Sort weight for "most important first" ordering. Higher wins. */
export const PRIORITY_RANK: Record<NotificationPriority, number> = {
  [NOTIFICATION_PRIORITY.LOW]: 0,
  [NOTIFICATION_PRIORITY.NORMAL]: 1,
  [NOTIFICATION_PRIORITY.HIGH]: 2,
  [NOTIFICATION_PRIORITY.CRITICAL]: 3,
};

/**
 * Whether a notification belongs to a clinic or to the platform operators.
 *
 * This is the isolation axis the recipient resolver enforces: a `TENANT` event
 * may only ever resolve users whose own `users.tenantId` equals the event's
 * tenant, and a `PLATFORM` event may only ever resolve users with
 * `users.tenantId IS NULL`.
 */
export const NOTIFICATION_SCOPE = {
  TENANT: 'TENANT',
  PLATFORM: 'PLATFORM',
} as const;

export type NotificationScope =
  (typeof NOTIFICATION_SCOPE)[keyof typeof NOTIFICATION_SCOPE];

/** The two locales the catalog renders. Mirrors `User.preferred_locale`. */
export const NOTIFICATION_LOCALES = ['en', 'ar'] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

/** Default when a recipient has no `preferred_locale` (the column is nullable). */
export const DEFAULT_NOTIFICATION_LOCALE: NotificationLocale = 'en';

/**
 * Normalizes a stored locale to one the catalog can render.
 *
 * `User.preferred_locale` is a free `varchar(10)`, so it may hold `ar-SA`,
 * `AR`, `en-GB`, an empty string, or something no renderer exists for. Only
 * the primary subtag is significant, and anything unrecognized falls back to
 * English rather than rendering an empty notification.
 */
export function resolveNotificationLocale(
  preferred?: string | null,
): NotificationLocale {
  const primary = (preferred ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (NOTIFICATION_LOCALES as readonly string[]).includes(primary)
    ? (primary as NotificationLocale)
    : DEFAULT_NOTIFICATION_LOCALE;
}
