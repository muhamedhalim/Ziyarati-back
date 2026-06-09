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
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
} as const;

export type WhatsappDeliveryStatus =
  (typeof WHATSAPP_DELIVERY_STATUS)[keyof typeof WHATSAPP_DELIVERY_STATUS];

/** Channel marker written to `notification_logs.channel` for WhatsApp sends. */
export const WHATSAPP_CHANNEL = 'WHATSAPP';

/** Recipient-type markers used on `notification_logs.recipient_type`. */
export const WHATSAPP_RECIPIENT_TYPE = {
  CONTACT: 'WHATSAPP_CONTACT',
  CUSTOMER: 'CUSTOMER',
  RAW: 'WA_ID',
} as const;
