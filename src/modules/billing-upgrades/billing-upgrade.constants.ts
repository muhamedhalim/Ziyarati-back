import { USAGE_METRIC, UsageMetric } from '../subscription-billing/usage-metric';

/**
 * Billing Upgrade Requests — constants.
 *
 * `type`/`status` are `character varying` + a TS string-literal union (not a
 * Postgres enum), matching the Workflow/SupportTicket-era convention so
 * migrations stay additive (see support-tickets.constants.ts precedent).
 *
 * Scope note: `usage_limit` requests are restricted to the four METERED
 * `UsageMetric` keys (AI_TOKENS / WHATSAPP_MESSAGES / APPOINTMENTS /
 * CAMPAIGNS) — exactly the metrics `UsageService.getUsage()` exposes without
 * extra per-resource repositories, and exactly what `/app/billing`'s
 * UsageMeters card already displays as "current usage and limit". Count-based
 * resource caps (branches, users, customers, …) are NOT requestable through
 * this flow yet; extending it later means adding the same live-count wiring
 * `UsageService.assertCountWithinLimit` callers already do — no change to the
 * request/quote/payment workflow itself.
 */
export const BILLING_UPGRADE_TYPE = {
  FEATURE: 'feature',
  USAGE_LIMIT: 'usage_limit',
} as const;
export type BillingUpgradeType =
  (typeof BILLING_UPGRADE_TYPE)[keyof typeof BILLING_UPGRADE_TYPE];

export const BILLING_UPGRADE_USAGE_METRICS: readonly UsageMetric[] =
  Object.values(USAGE_METRIC);

/** UsageMetric -> the corresponding key on UsageService.getBreakdown()'s `metrics` object. */
export const USAGE_METRIC_BREAKDOWN_KEY: Record<
  UsageMetric,
  'aiTokens' | 'whatsappMessages' | 'appointments' | 'campaigns'
> = {
  [USAGE_METRIC.AI_TOKENS]: 'aiTokens',
  [USAGE_METRIC.WHATSAPP_MESSAGES]: 'whatsappMessages',
  [USAGE_METRIC.APPOINTMENTS]: 'appointments',
  [USAGE_METRIC.CAMPAIGNS]: 'campaigns',
};

export const BILLING_UPGRADE_STATUS = {
  PENDING_REVIEW: 'pending_review',
  AWAITING_OWNER_APPROVAL: 'awaiting_owner_approval',
  PAYMENT_PROCESSING: 'payment_processing',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PAYMENT_FAILED: 'payment_failed',
} as const;
export type BillingUpgradeStatus =
  (typeof BILLING_UPGRADE_STATUS)[keyof typeof BILLING_UPGRADE_STATUS];

/**
 * Statuses that count as "already in flight" for the duplicate-active-request
 * guard (partial unique index + service-level check). `payment_failed` is
 * included — the owner retries the SAME request rather than opening a new
 * one while a failed attempt still holds an unexpired quote.
 */
export const ACTIVE_BILLING_UPGRADE_STATUSES: readonly BillingUpgradeStatus[] = [
  BILLING_UPGRADE_STATUS.PENDING_REVIEW,
  BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL,
  BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
  BILLING_UPGRADE_STATUS.PAYMENT_FAILED,
];

/** Statuses from which no further transition is possible. */
export const TERMINAL_BILLING_UPGRADE_STATUSES: readonly BillingUpgradeStatus[] = [
  BILLING_UPGRADE_STATUS.COMPLETED,
  BILLING_UPGRADE_STATUS.REJECTED,
  BILLING_UPGRADE_STATUS.CANCELLED,
  BILLING_UPGRADE_STATUS.EXPIRED,
];

/** Statuses from which the owner may still cancel the request themselves. */
export const OWNER_CANCELLABLE_STATUSES: readonly BillingUpgradeStatus[] = [
  BILLING_UPGRADE_STATUS.PENDING_REVIEW,
  BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL,
  BILLING_UPGRADE_STATUS.PAYMENT_FAILED,
];

/** Statuses the super admin may (re-)quote from. */
export const QUOTABLE_BILLING_UPGRADE_STATUSES: readonly BillingUpgradeStatus[] = [
  BILLING_UPGRADE_STATUS.PENDING_REVIEW,
  BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL,
  BILLING_UPGRADE_STATUS.PAYMENT_FAILED,
  BILLING_UPGRADE_STATUS.EXPIRED,
];

/** Statuses the super admin may reject from. */
export const REJECTABLE_BILLING_UPGRADE_STATUSES: readonly BillingUpgradeStatus[] = [
  BILLING_UPGRADE_STATUS.PENDING_REVIEW,
  BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL,
  BILLING_UPGRADE_STATUS.PAYMENT_FAILED,
];

export const BILLING_UPGRADE_BILLING_PERIOD = {
  ONE_TIME: 'one_time',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
} as const;
export type BillingUpgradeBillingPeriod =
  (typeof BILLING_UPGRADE_BILLING_PERIOD)[keyof typeof BILLING_UPGRADE_BILLING_PERIOD];

/** One table serves status history, quote snapshots, and admin notes (`type` discriminates) — mirrors SupportTicketEvent. */
export const BILLING_UPGRADE_EVENT_TYPE = {
  STATUS_CHANGED: 'STATUS_CHANGED',
  QUOTED: 'QUOTED',
  NOTE_ADDED: 'NOTE_ADDED',
  AI_ESTIMATE_GENERATED: 'AI_ESTIMATE_GENERATED',
} as const;
export type BillingUpgradeEventType =
  (typeof BILLING_UPGRADE_EVENT_TYPE)[keyof typeof BILLING_UPGRADE_EVENT_TYPE];

/** Columns the platform list may be ordered/filtered by. */
export const BILLING_UPGRADE_SORTABLE_FIELDS = [
  'created_at',
  'updated_at',
  'status',
  'type',
] as const;
export type BillingUpgradeSortField =
  (typeof BILLING_UPGRADE_SORTABLE_FIELDS)[number];
