import { CampaignStatus, RecipientStatus } from '../../entities/enums';

/**
 * Campaign lifecycle state-machine.
 *
 * The finalized `CampaignStatus` enum is DRAFT | SCHEDULED | RUNNING | PAUSED |
 * COMPLETED | CANCELLED. There is intentionally NO `FAILED` or `ARCHIVED` value,
 * so (honoring "use existing fields only"):
 *  - campaign-level "failed" is not persisted (delivery failures live on
 *    recipients via RecipientStatus.FAILED);
 *  - "archive" is modelled with the existing `deleted_at` column (soft-hide),
 *    while "delete" is a hard delete.
 */
export const CAMPAIGN_STATUS_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  [CampaignStatus.DRAFT]: [
    CampaignStatus.SCHEDULED,
    CampaignStatus.RUNNING,
    CampaignStatus.CANCELLED,
  ],
  [CampaignStatus.SCHEDULED]: [
    CampaignStatus.RUNNING,
    CampaignStatus.PAUSED,
    CampaignStatus.CANCELLED,
  ],
  [CampaignStatus.RUNNING]: [
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
  ],
  [CampaignStatus.PAUSED]: [
    CampaignStatus.RUNNING,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
  ],
  [CampaignStatus.COMPLETED]: [],
  [CampaignStatus.CANCELLED]: [],
};

/** Statuses a campaign can be edited/configured in (recipients, fields). */
export const EDITABLE_STATUSES: CampaignStatus[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.SCHEDULED,
  CampaignStatus.PAUSED,
];

/** Terminal statuses (only archiving remains). */
export const TERMINAL_CAMPAIGN_STATUSES: CampaignStatus[] = [
  CampaignStatus.COMPLETED,
  CampaignStatus.CANCELLED,
];

/** Recipient statuses considered a successful delivery for rate maths. */
export const DELIVERED_RECIPIENT_STATUSES: RecipientStatus[] = [
  RecipientStatus.DELIVERED,
  RecipientStatus.READ,
];

/** Recipient statuses considered "processed" (left the queue) for completion. */
export const PROCESSED_RECIPIENT_STATUSES: RecipientStatus[] = [
  RecipientStatus.SENT,
  RecipientStatus.DELIVERED,
  RecipientStatus.READ,
  RecipientStatus.FAILED,
  RecipientStatus.SKIPPED,
];

/**
 * Logical delivery channels a campaign can target. The Campaign entity carries
 * a WhatsApp template, so WHATSAPP is the default; the abstraction is kept open
 * so SMS/Email/Push/In-App providers can be added without business changes.
 */
export const CAMPAIGN_CHANNEL = {
  WHATSAPP: 'WHATSAPP',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  PUSH: 'PUSH',
  IN_APP: 'IN_APP',
} as const;

export type CampaignChannel =
  (typeof CAMPAIGN_CHANNEL)[keyof typeof CAMPAIGN_CHANNEL];
