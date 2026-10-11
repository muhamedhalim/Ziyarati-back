import { WHATSAPP_TEMPLATE_STATUS, WhatsappTemplateStatus } from './whatsapp.constants';

/**
 * Meta's template review statuses → our local vocabulary.
 *
 * Extracted from `WhatsappTemplateSyncService.mapStatus` so the paths that learn
 * a status FROM META — the pull sync, the create-on-Meta response, the
 * single-template refresh and the `message_template_status_update` webhook —
 * cannot drift apart. All are Meta reporting its own verdict; a second copy of
 * this switch would eventually disagree with the first, and the failure mode is
 * silent (a template treated as sendable that Meta will reject).
 *
 * Deliberately a pure function, not a service method: it has no dependencies,
 * which is what lets every caller use it without importing each other.
 *
 * Anything unrecognised maps to PENDING_REVIEW rather than APPROVED — Meta adds
 * statuses over time and defaulting an unknown one to approved would push
 * messages Meta refuses to deliver.
 *
 * Both vocabularies are covered: the REST `status` field (APPROVED, PENDING,
 * REJECTED, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION, DELETED,
 * LIMIT_EXCEEDED) and the webhook `event` field, which adds REINSTATED, FLAGGED,
 * LOCKED, ARCHIVED and UNARCHIVED.
 */
export function mapMetaTemplateStatus(
  metaStatus: string | undefined,
  onUnknown?: (status: string | undefined) => void,
): WhatsappTemplateStatus {
  switch (metaStatus?.toUpperCase()) {
    case 'APPROVED':
    case 'REINSTATED':
      return WHATSAPP_TEMPLATE_STATUS.APPROVED;
    case 'REJECTED':
      return WHATSAPP_TEMPLATE_STATUS.REJECTED;
    case 'PAUSED':
    case 'LOCKED':
    case 'LIMIT_EXCEEDED':
      return WHATSAPP_TEMPLATE_STATUS.PAUSED;
    case 'DISABLED':
    case 'ARCHIVED':
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

/**
 * Webhook events that describe something OTHER than a review verdict and so
 * must NOT move the stored status: FLAGGED is a quality warning on a template
 * that is still APPROVED; UNARCHIVED/DELETED are handled by the caller.
 */
export const TEMPLATE_EVENTS_WITHOUT_STATUS_CHANGE = new Set(['FLAGGED', 'UNARCHIVED']);

/**
 * Meta's `rejected_reason` / webhook `reason` carries the literal string `NONE`
 * when there is no reason (and `null` for a deletion). Storing that would show
 * a rejection reason of "NONE" on an approved template.
 */
export function normalizeRejectionReason(
  reason: string | null | undefined,
): string | undefined {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmed || trimmed.toUpperCase() === 'NONE') return undefined;
  return trimmed;
}
