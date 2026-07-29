/**
 * WhatsApp template review lifecycle. `WhatsappTemplate.status` is a free
 * `varchar` in the finalized schema, so these are app-defined (no DB enum).
 */
export const WHATSAPP_TEMPLATE_STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DISABLED: 'disabled',
} as const;

export type WhatsappTemplateStatus =
  (typeof WHATSAPP_TEMPLATE_STATUS)[keyof typeof WHATSAPP_TEMPLATE_STATUS];

export const WHATSAPP_TEMPLATE_STATUSES: WhatsappTemplateStatus[] = Object.values(
  WHATSAPP_TEMPLATE_STATUS,
);

/**
 * Message delivery lifecycle. There is no WhatsApp *message* table in the
 * finalized schema, so sends are recorded on `notification_logs`
 * (channel = WHATSAPP) — these strings are written to `notification_logs.status`.
 */
export const WHATSAPP_DELIVERY_STATUS = {
  QUEUED: 'QUEUED',
  /**
   * Claimed by the worker, send in flight (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.11). The atomic QUEUED -> SENDING
   * transition is what makes a redelivered `whatsapp.send` job a safe no-op
   * instead of a duplicate send — this queue has no other idempotency guard.
   */
  SENDING: 'SENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
} as const;

export type WhatsappDeliveryStatus =
  (typeof WHATSAPP_DELIVERY_STATUS)[keyof typeof WHATSAPP_DELIVERY_STATUS];

/**
 * How long a claimed (SENDING) send is honored before it is treated as
 * abandoned and reclaimable (gap-closure pass — see
 * docs/CACHING_QUEUES_AUDIT.md §0.8.5). Must comfortably exceed a real Meta
 * Cloud API call's worst-case latency, so a still-in-flight send is never
 * reclaimed out from under itself — only a claim whose owning worker crashed
 * (or was killed) before ever writing a terminal SENT/FAILED status.
 */
export const WHATSAPP_SENDING_STALE_MS = 5 * 60_000;

/**
 * WhatsApp account mode (hybrid SaaS model). A branch may have BOTH:
 *  - a PLATFORM account (the shared SaaS number), and
 *  - a CUSTOM account (the clinic's own WhatsApp number).
 * Routing prefers CUSTOM and falls back to PLATFORM. Stored on
 * `WhatsappAccount.mode` (app-defined varchar, no DB enum).
 */
export const WHATSAPP_ACCOUNT_MODE = {
  PLATFORM: 'PLATFORM',
  CUSTOM: 'CUSTOM',
} as const;

export type WhatsappAccountMode =
  (typeof WHATSAPP_ACCOUNT_MODE)[keyof typeof WHATSAPP_ACCOUNT_MODE];

export const WHATSAPP_ACCOUNT_MODES: WhatsappAccountMode[] = Object.values(
  WHATSAPP_ACCOUNT_MODE,
);

/**
 * Delivery provider backing a WhatsApp account. Only Meta's Cloud API is
 * implemented; the column exists so a future BSP (Twilio / 360dialog) can be
 * added without another migration, and so the provider strategy has something
 * concrete to switch on.
 */
export const WHATSAPP_PROVIDER = {
  META_CLOUD: 'META_CLOUD',
} as const;

export type WhatsappProvider =
  (typeof WHATSAPP_PROVIDER)[keyof typeof WHATSAPP_PROVIDER];

export const WHATSAPP_PROVIDERS: WhatsappProvider[] = Object.values(WHATSAPP_PROVIDER);

/**
 * Lifecycle of a tenant's connection to Meta. Distinct from `is_active` (the
 * operator's on/off switch): a connection can be CONNECTED but switched off, or
 * left active but become EXPIRED/REVOKED behind our back. Keeping the two apart
 * is what lets the UI say "reconnect" instead of "enable".
 */
export const WHATSAPP_CONNECTION_STATUS = {
  /** Embedded Signup started but never completed. */
  PENDING: 'PENDING',
  /** Token valid, WABA subscribed to the platform webhook — usable. */
  CONNECTED: 'CONNECTED',
  /** Token expired — the clinic must reconnect. */
  EXPIRED: 'EXPIRED',
  /** Token rejected by Meta (revoked/invalidated) — the clinic must reconnect. */
  REVOKED: 'REVOKED',
  /** Explicitly disconnected by the clinic or the platform. */
  DISCONNECTED: 'DISCONNECTED',
} as const;

export type WhatsappConnectionStatus =
  (typeof WHATSAPP_CONNECTION_STATUS)[keyof typeof WHATSAPP_CONNECTION_STATUS];

export const WHATSAPP_CONNECTION_STATUSES: WhatsappConnectionStatus[] = Object.values(
  WHATSAPP_CONNECTION_STATUS,
);

/** Channel marker written to `notification_logs.channel` for WhatsApp sends. */
export const WHATSAPP_CHANNEL = 'WHATSAPP';

/** Recipient-type markers used on `notification_logs.recipient_type`. */
export const WHATSAPP_RECIPIENT_TYPE = {
  CONTACT: 'WHATSAPP_CONTACT',
  CUSTOMER: 'CUSTOMER',
  RAW: 'WA_ID',
} as const;
