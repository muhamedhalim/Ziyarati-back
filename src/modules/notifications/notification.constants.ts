/**
 * Scheduled-notification lifecycle states. `ScheduledNotification.status` is a
 * free `varchar(20)` in the finalized schema, so these are app-defined (no DB
 * enum to change). Centralized here so the scheduler, dispatcher and DTOs agree.
 */
/**
 * PROCESSING/send lifecycle — owned by the WORKER. ("Did we hand it to the
 * provider?") Delivery feedback from the carrier lives on the separate
 * {@link DELIVERY_STATUS} axis so a webhook can't clobber the send state.
 */
export const NOTIFICATION_STATUS = {
  PENDING: 'PENDING',
  SCHEDULED: 'SCHEDULED',
  PROCESSING: 'PROCESSING',
  SENT: 'SENT', // provider accepted the message (has provider_ref)
  DELIVERED: 'DELIVERED', // legacy; delivery now tracked on DELIVERY_STATUS
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type NotificationStatus =
  (typeof NOTIFICATION_STATUS)[keyof typeof NOTIFICATION_STATUS];

export const NOTIFICATION_STATUSES: NotificationStatus[] =
  Object.values(NOTIFICATION_STATUS);

/** States a worker may CLAIM for dispatch (atomic PROCESSING transition). */
export const CLAIMABLE_STATUSES: NotificationStatus[] = [
  NOTIFICATION_STATUS.PENDING,
  NOTIFICATION_STATUS.SCHEDULED,
];

/**
 * DELIVERY feedback — owned by provider WEBHOOKS. Forward-only:
 * NONE < ACCEPTED < DELIVERED < READ. FAILED is a hard carrier failure.
 */
export const DELIVERY_STATUS = {
  NONE: 'NONE',
  ACCEPTED: 'ACCEPTED',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
} as const;

export type DeliveryStatus =
  (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

/** A PROCESSING row older than this (no terminal transition) is considered
 *  stuck (crashed worker) and is reclaimed by the maintenance sweep. */
export const PROCESSING_STALE_MS = 5 * 60_000;

/** States from which a notification can still be cancelled. */
export const CANCELLABLE_STATUSES: NotificationStatus[] = [
  NOTIFICATION_STATUS.PENDING,
  NOTIFICATION_STATUS.SCHEDULED,
  NOTIFICATION_STATUS.FAILED,
];

/** States from which a notification can be (re)scheduled. */
export const RESCHEDULABLE_STATUSES: NotificationStatus[] = [
  NOTIFICATION_STATUS.PENDING,
  NOTIFICATION_STATUS.SCHEDULED,
  NOTIFICATION_STATUS.FAILED,
];

/** Terminal states (no further automated processing). */
export const TERMINAL_STATUSES: NotificationStatus[] = [
  NOTIFICATION_STATUS.SENT,
  NOTIFICATION_STATUS.DELIVERED,
  NOTIFICATION_STATUS.CANCELLED,
];

/**
 * Delivery channels. Abstraction only — concrete providers (WhatsApp/SMS/Email/
 * Push/In-App) are bound later via the NOTIFICATION_CHANNELS token without
 * touching business logic.
 */
export const NOTIFICATION_CHANNEL = {
  WHATSAPP: 'WHATSAPP',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  PUSH: 'PUSH',
  IN_APP: 'IN_APP',
} as const;

export type NotificationChannelKey =
  (typeof NOTIFICATION_CHANNEL)[keyof typeof NOTIFICATION_CHANNEL];

export const NOTIFICATION_CHANNELS_LIST: NotificationChannelKey[] =
  Object.values(NOTIFICATION_CHANNEL);

/** Recipient kinds stored in `recipient_type`. */
export const RECIPIENT_TYPE = {
  CUSTOMER: 'CUSTOMER',
  STAFF: 'STAFF',
  USER: 'USER',
  TENANT: 'TENANT',
} as const;

export type RecipientType =
  (typeof RECIPIENT_TYPE)[keyof typeof RECIPIENT_TYPE];

export const RECIPIENT_TYPES: RecipientType[] = Object.values(RECIPIENT_TYPE);
