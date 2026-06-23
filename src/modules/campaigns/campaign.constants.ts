import {
  CampaignLifecycle,
  CampaignExecution,
  RecipientProcessing,
  RecipientDelivery,
} from '../../entities/enums';

/**
 * Two INDEPENDENT state machines.
 *
 *  - Lifecycle = operator intent, validated in the API (CampaignRunService).
 *  - Execution = system state of a run, validated in the worker. Operators never
 *    drive execution directly; the worker transitions it from queue events.
 */
export const LIFECYCLE_TRANSITIONS: Record<CampaignLifecycle, CampaignLifecycle[]> = {
  [CampaignLifecycle.DRAFT]: [
    CampaignLifecycle.SCHEDULED,
    CampaignLifecycle.ACTIVE,
    CampaignLifecycle.ARCHIVED,
  ],
  [CampaignLifecycle.SCHEDULED]: [
    CampaignLifecycle.ACTIVE,
    CampaignLifecycle.PAUSED,
    CampaignLifecycle.ARCHIVED,
  ],
  [CampaignLifecycle.ACTIVE]: [
    CampaignLifecycle.PAUSED,
    CampaignLifecycle.ARCHIVED,
  ],
  [CampaignLifecycle.PAUSED]: [
    CampaignLifecycle.ACTIVE,
    CampaignLifecycle.ARCHIVED,
  ],
  [CampaignLifecycle.ARCHIVED]: [],
};

export const EXECUTION_TRANSITIONS: Record<CampaignExecution, CampaignExecution[]> = {
  [CampaignExecution.IDLE]: [CampaignExecution.ENQUEUEING],
  [CampaignExecution.ENQUEUEING]: [
    CampaignExecution.PROCESSING,
    CampaignExecution.FAILED,
  ],
  [CampaignExecution.PROCESSING]: [
    CampaignExecution.DRAINING,
    CampaignExecution.COMPLETED,
    CampaignExecution.FAILED,
  ],
  [CampaignExecution.DRAINING]: [
    CampaignExecution.IDLE,
    CampaignExecution.COMPLETED,
    CampaignExecution.FAILED,
  ],
  [CampaignExecution.COMPLETED]: [],
  [CampaignExecution.FAILED]: [CampaignExecution.IDLE],
};

/** Lifecycle states in which the campaign config / recipients can be edited. */
export const EDITABLE_LIFECYCLES: CampaignLifecycle[] = [
  CampaignLifecycle.DRAFT,
  CampaignLifecycle.SCHEDULED,
  CampaignLifecycle.PAUSED,
];

/** Terminal lifecycle states. */
export const TERMINAL_LIFECYCLES: CampaignLifecycle[] = [CampaignLifecycle.ARCHIVED];

/** Execution states in which a run is actively producing work. */
export const RUNNING_EXECUTIONS: CampaignExecution[] = [
  CampaignExecution.ENQUEUEING,
  CampaignExecution.PROCESSING,
];

/** Processing states considered terminal (the recipient has left the pipeline). */
export const TERMINAL_PROCESSING: RecipientProcessing[] = [
  RecipientProcessing.DISPATCHED,
  RecipientProcessing.FAILED,
  RecipientProcessing.SKIPPED,
];

/** Delivery states that count as a confirmed delivery for rate maths. */
export const DELIVERED_DELIVERY_STATES: RecipientDelivery[] = [
  RecipientDelivery.DELIVERED,
  RecipientDelivery.READ,
];

/**
 * Logical delivery channels a campaign can target. The Campaign entity carries
 * a WhatsApp template, so WHATSAPP is the default; the abstraction stays open so
 * SMS/Email/Push/In-App providers can be added without business changes.
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

/** Fan-out batch size — keyset page + addBulk chunk. */
export const FANOUT_BATCH_SIZE = 5000;
