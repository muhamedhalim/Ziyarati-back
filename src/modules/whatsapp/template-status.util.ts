import { WHATSAPP_TEMPLATE_STATUS, WhatsappTemplateStatus } from './whatsapp.constants';

/**
 * Meta's template review statuses → our local vocabulary.
 *
 * Extracted from `WhatsappTemplateSyncService.mapStatus` so the two paths that
 * learn a status FROM META — the pull sync and the create-on-Meta response —
 * cannot drift apart. Both are Meta reporting its own verdict; a second copy of
 * this switch would eventually disagree with the first, and the failure mode is
 * silent (a template treated as sendable that Meta will reject).
 *
 * Deliberately a pure function, not a service method: it has no dependencies,
 * which is what lets both callers use it without either one importing the
 * other.
 *
 * Anything unrecognised maps to PENDING_REVIEW rather than APPROVED — Meta adds
 * statuses over time (PAUSED, LIMIT_EXCEEDED, …) and defaulting an unknown one
 * to approved would push messages Meta refuses to deliver.
 */
export function mapMetaTemplateStatus(
  metaStatus: string | undefined,
  onUnknown?: (status: string | undefined) => void,
): WhatsappTemplateStatus {
  switch (metaStatus?.toUpperCase()) {
    case 'APPROVED':
      return WHATSAPP_TEMPLATE_STATUS.APPROVED;
    case 'REJECTED':
      return WHATSAPP_TEMPLATE_STATUS.REJECTED;
    case 'PAUSED':
    case 'DISABLED':
      return WHATSAPP_TEMPLATE_STATUS.DISABLED;
    case 'PENDING':
    case 'IN_APPEAL':
    case 'PENDING_DELETION':
      return WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW;
    default:
      onUnknown?.(metaStatus);
      return WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW;
  }
}
