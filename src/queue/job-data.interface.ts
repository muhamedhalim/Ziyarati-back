/**
 * Every job carries the multi-tenant context so the worker can restore it before
 * executing domain logic. `tenantId` is null only for platform-level sweeps.
 */
export interface BaseJobData {
  tenantId: string | null;
  /** Correlation id for tracing a logical request across API → queue → worker. */
  correlationId?: string;
  /** The user who triggered the work, when known. */
  actorId?: string;
}

// ── Refunds (R2 reaper sweep — platform-level, tenantId null) ───────────────
export type RefundsReapJob = BaseJobData;

// ── Email (transactional send) ─────────────────────────────────────────────
export interface EmailSendJob extends BaseJobData {
  /** Recipient address(es). */
  to: string | string[];
  /** Template key (see EMAIL_TEMPLATES). */
  template: string;
  /** Template variables (no secrets). */
  variables?: Record<string, unknown>;
  locale?: string;
  /** Idempotency key — dedupes at the queue AND the email-log level. */
  idempotencyKey?: string;
  replyTo?: string;
}

// ── Usage reports (scheduled) ──────────────────────────────────────────────
/** Tick sweep (tenantId null) — evaluates + runs due schedules. */
export type UsageReportTickJob = BaseJobData;
/** Run one schedule now. */
export interface UsageReportRunJob extends BaseJobData {
  scheduleId: string;
}

// ── Notifications ──────────────────────────────────────────────────────────
export interface NotificationDispatchJob extends BaseJobData {
  tenantId: string;
  notificationId: string;
}
/** Maintenance sweep: re-enqueue due-but-unsent + reclaim stale PROCESSING. */
export type NotificationReapJob = BaseJobData;
/** Dead-letter envelope for an exhausted transient dispatch. */
export interface NotificationDlqJob extends BaseJobData {
  notificationId: string;
  sourceQueue: string;
  sourceJobName: string;
  originalJobId?: string;
  failedReason: string;
  attemptsMade: number;
  diedAt: string;
}

// ── WhatsApp ───────────────────────────────────────────────────────────────
export interface WhatsappSendJob extends BaseJobData {
  tenantId: string;
  templateId: string;
  payload: {
    accountId?: string;
    branchId?: string;
    contactId?: string;
    customerId?: string;
    toWaId?: string;
    variables?: Record<string, unknown>;
    scheduledAt?: string;
  };
}

// ── Campaigns ──────────────────────────────────────────────────────────────
export interface CampaignLaunchJob extends BaseJobData {
  tenantId: string;
  campaignId: string;
  runId: string;
  idempotencyKey: string;
}
/** A single keyset window of a run's audience, fanned out independently. */
export interface CampaignFanoutChunkJob extends BaseJobData {
  tenantId: string;
  campaignId: string;
  runId: string;
  /** Exclusive lower bound (recipient id) for keyset pagination; null = start. */
  cursor: string | null;
}
export interface CampaignProcessRecipientJob extends BaseJobData {
  tenantId: string;
  campaignId: string;
  runId: string;
  recipientId: string;
}
/** Dead-letter envelope: the original payload plus failure forensics. */
export interface CampaignDlqJob extends BaseJobData {
  sourceQueue: string;
  sourceJobName: string;
  originalJobId?: string;
  originalData: Record<string, unknown>;
  failedReason: string;
  attemptsMade: number;
  diedAt: string;
}

// ── AI ─────────────────────────────────────────────────────────────────────
export interface AiExecuteJob extends BaseJobData {
  tenantId: string;
  aiConversationId: string;
  content: string;
}

// ── Analytics ──────────────────────────────────────────────────────────────
/** tenantId null = scheduled sweep that fans out per-tenant jobs. */
export interface AnalyticsAggregateJob extends BaseJobData {}
export interface AnalyticsGenerateReportJob extends BaseJobData {
  kind?: 'daily' | 'monthly';
  date?: string; // YYYY-MM-DD (daily)
  month?: string; // YYYY-MM (monthly)
  branchId?: string;
}
/** Platform-level retention sweep (tenantId null) — purges old analytics_events. */
export type AnalyticsCleanupJob = BaseJobData;

// ── Settlements ────────────────────────────────────────────────────────────
export interface SettlementsProcessJob extends BaseJobData {
  periodStart?: string;
  periodEnd?: string;
  branchId?: string;
  feePercent?: number;
  currency?: string;
}

// ── Subscriptions ──────────────────────────────────────────────────────────
export interface SubscriptionsRenewalCheckJob extends BaseJobData {}
