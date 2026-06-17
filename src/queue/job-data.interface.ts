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

// ── Notifications ──────────────────────────────────────────────────────────
export interface NotificationDispatchJob extends BaseJobData {
  tenantId: string;
  notificationId: string;
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
}
export interface CampaignProcessRecipientJob extends BaseJobData {
  tenantId: string;
  recipientId: string;
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
