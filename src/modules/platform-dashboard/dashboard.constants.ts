import { SubscriptionStatus, TenantApprovalStatus } from '../../entities/enums';

/**
 * Platform Control Center — shared vocabulary.
 *
 * This file is the ONLY place the dashboard defines its own terms. Everything
 * else (money, quotas, health, tickets) is delegated to the service that already
 * owns it; see `platform-dashboard.service.ts`.
 */

// ────────────────────────── Reporting timezone ──────────────────────────── //

/**
 * The dashboard reports in UTC, always.
 *
 * `src/config/typeorm.config.ts` sets no `timezone`, so a bare
 * `date_trunc('day', now())` in SQL follows whatever the Postgres SERVER is
 * configured to — implicit, environment-dependent, and already the cause of one
 * live inconsistency: `MarketplaceFinanceService.kpis()` computes "today" that
 * way while its own `metricDrilldown()` computes the same boundary with
 * `Date.UTC(...)`, so a card and its drill-down can disagree.
 *
 * Dashboard SQL therefore contains NO `now()`-derived boundary. Every window is
 * computed here, in JS, in UTC, and passed as a bound parameter. `tenants
 * .default_timezone` is a per-clinic OPERATIONAL setting and is deliberately not
 * consulted — one platform-wide reporting clock is the whole point.
 */
export const DASHBOARD_TIMEZONE = 'UTC' as const;

// ─────────────────────────── Subscription state ─────────────────────────── //

/**
 * The dashboard's canonical subscription state, mirroring
 * `SubscriptionService.getEffectiveStatus()` — the only definition the runtime
 * actually enforces (`isUsable`, `assertBillableActionAllowed`) and the only one
 * that models the grace window.
 *
 * This matters because three DIFFERENT definitions already ship:
 *   • `MarketplaceFinanceService.kpis()` counts `status='ACTIVE' AND ends_at >
 *     now()` — silently excluding every TRIAL.
 *   • `PlatformUsageService.baseCte()` maps ACTIVE/TRIAL past `ends_at` to the
 *     string `'EXPIRED'`, which is not a member of `SubscriptionStatus` at all.
 *   • `SubscriptionService.getEffectiveStatus()` maps the same case to
 *     `PAST_DUE`, then to `GRACE_EXPIRED` once the grace window elapses.
 *
 * `activeSubscriptions` on the finance page and `totalActiveTenants` on the
 * usage page consequently disagree today. The dashboard picks the canonical one
 * and says so in the UI; the other endpoints are public contracts and are left
 * exactly as they are.
 *
 * `NONE` is the dashboard's own addition: a tenant with no non-deleted
 * subscription row is a real, actionable state that the enum cannot express.
 */
export const DASHBOARD_SUBSCRIPTION_STATE = {
  ACTIVE: SubscriptionStatus.ACTIVE,
  TRIAL: SubscriptionStatus.TRIAL,
  PAST_DUE: SubscriptionStatus.PAST_DUE,
  GRACE_EXPIRED: SubscriptionStatus.GRACE_EXPIRED,
  CANCELLED: SubscriptionStatus.CANCELLED,
  SUSPENDED: SubscriptionStatus.SUSPENDED,
  PENDING_PAYMENT: SubscriptionStatus.PENDING_PAYMENT,
  /** No non-deleted `subscriptions` row for this tenant. */
  NONE: 'NONE',
} as const;

export type DashboardSubscriptionState =
  (typeof DASHBOARD_SUBSCRIPTION_STATE)[keyof typeof DASHBOARD_SUBSCRIPTION_STATE];

export const DASHBOARD_SUBSCRIPTION_STATES: DashboardSubscriptionState[] =
  Object.values(DASHBOARD_SUBSCRIPTION_STATE);

/**
 * SQL that reproduces `SubscriptionService.getEffectiveStatus()` exactly.
 *
 * Written once, here, so there is a single expression to keep in step with the
 * TypeScript method — `platform-dashboard.service.spec.ts` asserts the two agree
 * over a table of cases, including both grace boundaries.
 *
 * @param sub    alias of the latest-subscription row (nullable — LEFT JOIN)
 * @param grace  bound-parameter placeholder holding `SUBSCRIPTION_GRACE_DAYS`
 */
export function effectiveStatusSql(sub: string, grace: string): string {
  return `
    CASE
      WHEN ${sub}.id IS NULL THEN '${DASHBOARD_SUBSCRIPTION_STATE.NONE}'
      WHEN ${sub}.status IN ('${SubscriptionStatus.CANCELLED}','${SubscriptionStatus.SUSPENDED}','${SubscriptionStatus.GRACE_EXPIRED}','${SubscriptionStatus.PENDING_PAYMENT}')
        THEN ${sub}.status::text
      WHEN ${sub}.status = '${SubscriptionStatus.PAST_DUE}'
           AND ${sub}.grace_started_at IS NOT NULL
           AND ${sub}.grace_started_at + (${grace} * interval '1 day') < now()
        THEN '${SubscriptionStatus.GRACE_EXPIRED}'
      WHEN ${sub}.status = '${SubscriptionStatus.PAST_DUE}'
        THEN '${SubscriptionStatus.PAST_DUE}'
      WHEN ${sub}.ends_at < now()
        THEN '${SubscriptionStatus.PAST_DUE}'
      ELSE ${sub}.status::text
    END`;
}

/**
 * Latest subscription per tenant. Same `LEFT JOIN LATERAL … ORDER BY created_at
 * DESC LIMIT 1` shape `PlatformUsageService.baseCte()` uses — a tenant can hold
 * several rows over its lifetime and only the newest describes it now.
 */
export const LATEST_SUBSCRIPTION_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT s.id, s.status, s.starts_at, s.ends_at, s.auto_renew,
           s."planId", s.grace_started_at
      FROM subscriptions s
     WHERE s."tenantId" = t.id AND s.deleted_at IS NULL
     ORDER BY s.created_at DESC
     LIMIT 1
  ) sub ON true`;

// ───────────────────────────── Tenant lifecycle ─────────────────────────── //

/**
 * Tenant approval states, kept SEPARATE on purpose.
 *
 * The page this replaces merged `PENDING_VERIFICATION` with `PENDING_APPROVAL`
 * into one "Pending" counter, and `SUSPENDED` with `REJECTED` into one
 * "Suspended / Rejected" counter. Those are four different situations needing
 * four different actions — a clinic that has not uploaded documents is not a
 * clinic waiting on a human decision, and an operator suspension is not a
 * rejected application.
 */
export const TENANT_STATES = Object.values(TenantApprovalStatus);

// ──────────────────────────── Metric direction ──────────────────────────── //

/**
 * Whether an increase is good or bad. Comparison colouring reads this instead of
 * inferring from the sign — more failed payments is not a win.
 */
export type MetricDirection = 'higher-is-better' | 'lower-is-better';

export const METRIC_DIRECTION: Record<string, MetricDirection> = {
  newTenants: 'higher-is-better',
  platformRevenue: 'higher-is-better',
  grossVolume: 'higher-is-better',
  payingTenants: 'higher-is-better',
  failedPayments: 'lower-is-better',
  refunds: 'lower-is-better',
};

/**
 * The four comparison outcomes. `NEW` and `NONE` exist so a zero denominator is
 * never rendered as `+100%` or `+∞%`, and so "no previous data" is visibly
 * different from "no change".
 */
export const COMPARISON_STATE = {
  /** previous > 0 — a real percentage is meaningful. */
  CHANGED: 'changed',
  /** previous = 0, current > 0 — show a "New" badge, never a percentage. */
  NEW: 'new',
  /** previous = 0, current = 0 — nothing happened either window. */
  NONE: 'none',
  /** The comparison window predates the first record — not comparable. */
  NO_BASELINE: 'no-baseline',
} as const;

export type ComparisonState =
  (typeof COMPARISON_STATE)[keyof typeof COMPARISON_STATE];

// ───────────────────────────── Range bounding ───────────────────────────── //

/** Longest custom range accepted, in days. Bounds aggregation cost. */
export const MAX_RANGE_DAYS = 366;

/** Default range when the caller supplies none. */
export const DEFAULT_RANGE_DAYS = 30;

/** Hard cap on trend-series points, so a 366-day range never returns 366 buckets. */
export const MAX_SERIES_POINTS = 120;

// ──────────────────────────── Attention windows ─────────────────────────── //

/** A subscription or trial inside this window counts as "expiring soon". */
export const EXPIRING_SOON_DAYS = 7;

/** An integration token inside this window counts as "expiring soon". */
export const TOKEN_EXPIRING_SOON_DAYS = 14;

/** Rows returned by each bounded list on the snapshot. */
export const SNAPSHOT_LIST_LIMIT = 10;

/**
 * Upgrade-request states that still need a platform decision.
 *
 * Listed positively rather than as a NOT-IN of the terminal states: a new status
 * added to `BILLING_UPGRADE_STATUS` later would silently join a NOT-IN filter
 * and inflate the operator's queue, whereas an allow-list simply ignores it
 * until someone decides it belongs. Values mirror
 * `billing-upgrades/billing-upgrades.constants.ts` (lowercase, `varchar`).
 */
export const OPEN_UPGRADE_STATUSES = [
  'pending_review',
  'awaiting_owner_approval',
  'payment_processing',
  'payment_failed',
] as const;
