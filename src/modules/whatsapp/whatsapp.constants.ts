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

/**
 * Meta template categories. Meta rejects anything outside this set, and the
 * category also decides pricing and the review bar, so it is validated rather
 * than accepted as free text (the column stays varchar for forward
 * compatibility if Meta adds one).
 */
export const WHATSAPP_TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type WhatsappTemplateCategory = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number];

/** Component types Meta accepts on a template. Media headers are not implemented. */
export const WHATSAPP_TEMPLATE_COMPONENT_TYPES = ['HEADER', 'BODY', 'FOOTER', 'BUTTONS'] as const;
export type WhatsappTemplateComponentType =
  (typeof WHATSAPP_TEMPLATE_COMPONENT_TYPES)[number];

/** Button types Meta accepts on a BUTTONS component. */
export const WHATSAPP_TEMPLATE_BUTTON_TYPES = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] as const;
export type WhatsappTemplateButtonType = (typeof WHATSAPP_TEMPLATE_BUTTON_TYPES)[number];

/**
 * Meta template name rule: lower-case letters, digits and underscores only.
 * Enforced here because Meta's rejection for a bad name is opaque, and the user
 * is still looking at the form when we can say so plainly.
 */
export const WHATSAPP_TEMPLATE_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * Meta language code shape: `en`, `ar`, `en_US`, `pt_BR`, `zh_CN`.
 *
 * A FORMAT check, not a whitelist of Meta's ~80 codes: the list changes without
 * notice, and rejecting a code Meta actually supports would be a worse failure
 * than letting Meta reject an invalid one with its own message. Whatever is
 * stored here is what `MetaWhatsappProvider.send` later puts in
 * `template.language.code`, so create and send always agree.
 */
export const WHATSAPP_TEMPLATE_LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** Channel marker written to `notification_logs.channel` for WhatsApp sends. */
export const WHATSAPP_CHANNEL = 'WHATSAPP';

/** Recipient-type markers used on `notification_logs.recipient_type`. */
export const WHATSAPP_RECIPIENT_TYPE = {
  CONTACT: 'WHATSAPP_CONTACT',
  CUSTOMER: 'CUSTOMER',
  RAW: 'WA_ID',
} as const;
