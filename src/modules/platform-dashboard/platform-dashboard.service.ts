import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { TenantApprovalStatus } from '../../entities/enums';
import {
  CLINIC_REVENUE_PURPOSES,
  round2,
} from '../payments/payments.constants';
import { QueueService } from '../../queue/queue.service';
import { MonitoringService } from '../platform-monitoring/monitoring.service';
import { SupportTicketService } from '../support-tickets/support-ticket.service';
import {
  DASHBOARD_SUBSCRIPTION_STATE,
  DASHBOARD_SUBSCRIPTION_STATES,
  DASHBOARD_TIMEZONE,
  EXPIRING_SOON_DAYS,
  LATEST_SUBSCRIPTION_LATERAL,
  OPEN_UPGRADE_STATUSES,
  SNAPSHOT_LIST_LIMIT,
  effectiveStatusSql,
  type DashboardSubscriptionState,
} from './dashboard.constants';
import {
  BUCKET_FORMAT,
  compare,
  resolveRange,
  startOfUtcDay,
  type Comparison,
  type ResolvedRange,
} from './dashboard-range';
import type { QueryDashboardRangeDto } from './dto/query-dashboard-range.dto';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const iso = (v: unknown): string | null =>
  v ? new Date(v as string).toISOString() : null;

const DAY_MS = 86_400_000;

// ────────────────────────────── Response types ──────────────────────────── //

export interface TenantStateCounts {
  total: number;
  approved: number;
  pendingVerification: number;
  pendingApproval: number;
  suspended: number;
  rejected: number;
  active: number;
}

export type SubscriptionStateCounts = Record<DashboardSubscriptionState, number>;

export interface PlanMixRow {
  planId: string | null;
  planName: string | null;
  count: number;
  /** Contracted monthly value for this plan's active subscriptions. Advisory. */
  monthlyValue: number;
}

export interface UpcomingRenewal {
  tenantId: string;
  tenantName: string;
  planName: string | null;
  endsAt: string | null;
  autoRenew: boolean;
  state: string;
}

/** A clinic surfaced with the evidence that put it there — never a score. */
export interface TenantHealthRow {
  tenantId: string;
  tenantName: string;
  reasons: string[];
  lastActivityAt: string | null;
  subscriptionState: string;
}

export interface DashboardSnapshot {
  tenants: TenantStateCounts;
  subscriptions: {
    counts: SubscriptionStateCounts;
    expiringSoon: { withinDays: number; active: number; trial: number };
    byPlan: PlanMixRow[];
    upcomingRenewals: UpcomingRenewal[];
  };
  advisoryMrr: { amount: number; currency: null; note: string };
  tenantHealth: TenantHealthRow[];
  health: {
    database: string;
    redis: string;
    workers: string;
    workerHeartbeatAgeSeconds: number | null;
    queueBacklog: number;
    failedJobs: number;
    webhookFailures: number;
  } | null;
  actionCounts: {
    pendingApprovals: number;
    pendingVerificationDocs: number;
    urgentTickets: number;
    openTickets: number;
    upgradeRequests: number;
  };
  degradedSources: string[];
  timezone: typeof DASHBOARD_TIMEZONE;
  collectedAt: string;
}

export interface TrendPoint {
  bucket: string;
  value: number;
  secondary?: number;
}

export interface DashboardSummary {
  range: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    bucket: string;
    timezone: string;
  };
  currencies: string[];
  metrics: Record<string, Comparison>;
  series: { tenantGrowth: TrendPoint[]; revenue: TrendPoint[] };
  collectedAt: string;
}

export interface ActivityItem {
  type: 'tenant_approval' | 'platform_admin';
  action: string;
  at: string;
  actor: { displayName: string | null };
  target: { type: string; id: string | null; label: string | null };
}

/**
 * Platform Control Center aggregator (super-admin).
 *
 * Read-only, cross-tenant, and deliberately THIN: money comes from the payments
 * ledger the way `MarketplaceFinanceService` reads it, infrastructure health
 * from `MonitoringService`, ticket counts from `SupportTicketService`, quota
 * alerts from `PlatformUsageService`. This service owns only what none of those
 * can express — platform-wide lifecycle counts and growth — plus the
 * composition that lets the landing page load in four requests.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. **No unbounded scan.** Every predicate lands on an index from
 *     `1730040000000-PlatformDashboardIndexes`, and every list is `LIMIT`ed.
 *  2. **No time boundary in SQL.** Windows are computed in JS as UTC and bound
 *     as parameters (see `DASHBOARD_TIMEZONE`).
 *  3. **No money arithmetic outside SQL.** Sums happen in Postgres over
 *     `numeric` and are rounded once, here, with the shared `round2`.
 */
@Injectable()
export class PlatformDashboardService {
  private readonly logger = new Logger(PlatformDashboardService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly monitoring: MonitoringService,
    private readonly tickets: SupportTicketService,
    private readonly queues: QueueService,
  ) {}

  private graceDays(): number {
    return this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
  }

  /**
   * The ONE cached payload on this page.
   *
   * Caching is not the default here — bounding and indexing came first. This
   * single entry is cached because it is point-in-time (so a bounded lag is
   * harmless), identical for every super-admin (so the key needs no user or
   * tenant component), and the most aggregate-heavy of the four endpoints.
   *
   * `/alerts` is deliberately NOT cached: it is what an operator watches during
   * an incident, and a cached "all clear" is worse than a slow one. `/summary`
   * is parameterised by range, so its hit rate would not justify the staleness.
   */
  private static readonly SNAPSHOT_CACHE_KEY = 'platform:dashboard:snapshot:v1';
  private static readonly SNAPSHOT_CACHE_TTL_SEC = 60;

  // ─────────────────────────────── Snapshot ─────────────────────────────── //

  /**
   * Point-in-time platform state. Takes NO range — see `QueryDashboardRangeDto`.
   *
   * Every source is settled independently: infrastructure health depends on
   * Redis, and a Redis outage must degrade one strip, not blank the operator's
   * landing page at exactly the moment they need it.
   */
  async snapshot(options?: { bypassCache?: boolean }): Promise<DashboardSnapshot> {
    if (!options?.bypassCache) {
      const cached = await this.readSnapshotCache();
      if (cached) return cached;
    }
    const fresh = await this.computeSnapshot();
    await this.writeSnapshotCache(fresh);
    return fresh;
  }

  /**
   * A cache miss, a malformed entry and a Redis outage are all treated
   * identically: compute fresh. There is deliberately no branch that returns
   * stale-or-nothing — an unreachable cache must never be able to blank the
   * operator's landing page.
   */
  private async readSnapshotCache(): Promise<DashboardSnapshot | null> {
    try {
      const raw = await this.queues.kvGet(PlatformDashboardService.SNAPSHOT_CACHE_KEY);
      return raw ? (JSON.parse(raw) as DashboardSnapshot) : null;
    } catch {
      return null;
    }
  }

  private async writeSnapshotCache(value: DashboardSnapshot): Promise<void> {
    // A degraded snapshot is not worth serving for a minute — recompute next
    // time rather than pinning a partial answer.
    if (value.degradedSources.length > 0) return;
    try {
      await this.queues.kvSet(
        PlatformDashboardService.SNAPSHOT_CACHE_KEY,
        JSON.stringify(value),
        PlatformDashboardService.SNAPSHOT_CACHE_TTL_SEC,
      );
    } catch {
      /* Cache write failures are never fatal — the caller already has its data. */
    }
  }

  private async computeSnapshot(): Promise<DashboardSnapshot> {
    const now = new Date();
    const grace = this.graceDays();
    const webhookSince = new Date(now.getTime() - DAY_MS);

    const [
      tenants,
      subscriptionCounts,
      expiringSoon,
      byPlan,
      upcomingRenewals,
      tenantHealth,
      health,
      actionCounts,
    ] = await Promise.allSettled([
      this.tenantStateCounts(grace),
      this.subscriptionStateCounts(grace),
      this.expiringSoon(grace),
      this.planMix(grace),
      this.upcomingRenewals(grace),
      this.tenantHealth(grace),
      this.monitoring.healthSnapshot(webhookSince),
      this.actionCounts(),
    ]);

    const degradedSources: string[] = [];
    const take = <T>(
      r: PromiseSettledResult<T>,
      source: string,
      fallback: T,
    ): T => {
      if (r.status === 'fulfilled') return r.value;
      this.logger.warn(
        `Dashboard snapshot source "${source}" failed: ${(r.reason as Error)?.message}`,
      );
      degradedSources.push(source);
      return fallback;
    };

    const plans = take(byPlan, 'plans', [] as PlanMixRow[]);

    return {
      tenants: take(tenants, 'tenants', this.emptyTenantCounts()),
      subscriptions: {
        counts: take(subscriptionCounts, 'subscriptions', this.emptySubscriptionCounts()),
        expiringSoon: take(expiringSoon, 'expiringSoon', {
          withinDays: EXPIRING_SOON_DAYS,
          active: 0,
          trial: 0,
        }),
        byPlan: plans,
        upcomingRenewals: take(upcomingRenewals, 'renewals', [] as UpcomingRenewal[]),
      },
      // Summed from the same plan rows the mix reports, so the headline and the
      // breakdown can never disagree.
      advisoryMrr: {
        amount: round2(plans.reduce((s, p) => s + p.monthlyValue, 0)),
        // Deliberately null: `subscription_plans` has NO currency column, so
        // there is no honest symbol to attach. See the `note`.
        currency: null,
        note: 'contracted-plan-value',
      },
      tenantHealth: take(tenantHealth, 'tenantHealth', [] as TenantHealthRow[]),
      health: take(health, 'health', null),
      actionCounts: take(actionCounts, 'actionCounts', {
        pendingApprovals: 0,
        pendingVerificationDocs: 0,
        urgentTickets: 0,
        openTickets: 0,
        upgradeRequests: 0,
      }),
      degradedSources,
      timezone: DASHBOARD_TIMEZONE,
      collectedAt: now.toISOString(),
    };
  }

  private emptyTenantCounts(): TenantStateCounts {
    return {
      total: 0,
      approved: 0,
      pendingVerification: 0,
      pendingApproval: 0,
      suspended: 0,
      rejected: 0,
      active: 0,
    };
  }

  private emptySubscriptionCounts(): SubscriptionStateCounts {
    return Object.fromEntries(
      DASHBOARD_SUBSCRIPTION_STATES.map((s) => [s, 0]),
    ) as SubscriptionStateCounts;
  }

  // ────────────────────────── Tenant lifecycle ──────────────────────────── //

  /**
   * Exact counts per approval state, from ONE grouped query.
   *
   * This replaces pulling 100 tenant rows and counting them in the browser —
   * not merely inefficient but wrong: `ListTenantsQueryDto` caps `limit` at 100,
   * so past 100 clinics the browser was counting a page and presenting it as a
   * platform total.
   *
   * The four states stay separate. `active` mirrors `ActiveTenantGuard`'s own
   * admission test — `approval_status = APPROVED AND is_active` — plus a usable
   * subscription, so the tile means "clinics that can operate right now" rather
   * than "clinics we once approved". `is_active` is written only by
   * `TenantService.transition()`, in the same transaction as the status, so
   * naming both is a faithful mirror of the guard rather than a redundant belt.
   */
  private async tenantStateCounts(grace: number): Promise<TenantStateCounts> {
    const usable = [
      DASHBOARD_SUBSCRIPTION_STATE.ACTIVE,
      DASHBOARD_SUBSCRIPTION_STATE.TRIAL,
    ]
      .map((s) => `'${s}'`)
      .join(',');

    const [row] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE t.approval_status = '${TenantApprovalStatus.APPROVED}')::int              AS approved,
         COUNT(*) FILTER (WHERE t.approval_status = '${TenantApprovalStatus.PENDING_VERIFICATION}')::int  AS pending_verification,
         COUNT(*) FILTER (WHERE t.approval_status = '${TenantApprovalStatus.PENDING_APPROVAL}')::int      AS pending_approval,
         COUNT(*) FILTER (WHERE t.approval_status = '${TenantApprovalStatus.SUSPENDED}')::int             AS suspended,
         COUNT(*) FILTER (WHERE t.approval_status = '${TenantApprovalStatus.REJECTED}')::int              AS rejected,
         COUNT(*) FILTER (
           WHERE t.approval_status = '${TenantApprovalStatus.APPROVED}'
             AND t.is_active
             AND (${effectiveStatusSql('sub', '$1')}) IN (${usable})
         )::int AS active
       FROM tenants t
       ${LATEST_SUBSCRIPTION_LATERAL}
       WHERE t.deleted_at IS NULL`,
      [grace],
    );

    return {
      total: n(row?.total),
      approved: n(row?.approved),
      pendingVerification: n(row?.pending_verification),
      pendingApproval: n(row?.pending_approval),
      suspended: n(row?.suspended),
      rejected: n(row?.rejected),
      active: n(row?.active),
    };
  }

  // ──────────────────────── Subscription lifecycle ──────────────────────── //

  /**
   * Tenants grouped by canonical effective subscription state.
   *
   * Counted per TENANT (via the latest-subscription lateral), not per
   * subscription row, so a clinic that has renewed four times contributes one.
   * `NONE` covers approved clinics that never picked a plan — invisible in every
   * existing endpoint, and one of the states an operator most needs to see.
   */
  private async subscriptionStateCounts(
    grace: number,
  ): Promise<SubscriptionStateCounts> {
    const rows: { state: string; count: string }[] = await this.dataSource.query(
      `SELECT state, COUNT(*)::int AS count
         FROM (
           SELECT (${effectiveStatusSql('sub', '$1')}) AS state
             FROM tenants t
             ${LATEST_SUBSCRIPTION_LATERAL}
            WHERE t.deleted_at IS NULL
         ) s
        GROUP BY state`,
      [grace],
    );

    // Seed every state at zero so the shape is stable — a dashboard that omits
    // GRACE_EXPIRED when it happens to be empty forces the client to guess
    // whether the number is zero or the field is gone.
    const counts = this.emptySubscriptionCounts();
    for (const r of rows) {
      if (r.state in counts) {
        counts[r.state as DashboardSubscriptionState] = n(r.count);
      } else {
        this.logger.warn(
          `Unmapped subscription state "${r.state}" (${n(r.count)} tenants) — add it to DASHBOARD_SUBSCRIPTION_STATE`,
        );
      }
    }
    return counts;
  }

  /** Usable subscriptions whose `ends_at` falls inside the attention window. */
  private async expiringSoon(grace: number) {
    const [row] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = '${DASHBOARD_SUBSCRIPTION_STATE.ACTIVE}')::int AS active,
         COUNT(*) FILTER (WHERE state = '${DASHBOARD_SUBSCRIPTION_STATE.TRIAL}')::int  AS trial
       FROM (
         SELECT (${effectiveStatusSql('sub', '$1')}) AS state
           FROM tenants t
           ${LATEST_SUBSCRIPTION_LATERAL}
          WHERE t.deleted_at IS NULL
            AND sub.ends_at > $2 AND sub.ends_at <= $3
       ) s`,
      [grace, new Date(), new Date(Date.now() + EXPIRING_SOON_DAYS * DAY_MS)],
    );
    return {
      withinDays: EXPIRING_SOON_DAYS,
      active: n(row?.active),
      trial: n(row?.trial),
    };
  }

  /**
   * Plan distribution over currently-usable subscriptions, with the contracted
   * monthly value per plan.
   *
   * `monthlyValue` normalises YEARLY prices to a month. `CUSTOM` contributes 0
   * on purpose: a custom cycle has no defined period length in
   * `subscription_plans`, so any monthly figure for it would be invented. This
   * matches how `MarketplaceFinanceService` already computes its MRR.
   */
  private async planMix(grace: number): Promise<PlanMixRow[]> {
    const usable = [
      DASHBOARD_SUBSCRIPTION_STATE.ACTIVE,
      DASHBOARD_SUBSCRIPTION_STATE.TRIAL,
    ]
      .map((s) => `'${s}'`)
      .join(',');

    const rows = await this.dataSource.query(
      `SELECT plan_id, plan_name, COUNT(*)::int AS count,
              COALESCE(SUM(monthly_value), 0) AS monthly_value
         FROM (
           SELECT sub."planId" AS plan_id, pl.name AS plan_name,
                  CASE pl.billing_cycle
                    WHEN 'MONTHLY' THEN pl.price
                    WHEN 'YEARLY'  THEN pl.price / 12
                    ELSE 0
                  END AS monthly_value,
                  (${effectiveStatusSql('sub', '$1')}) AS state
             FROM tenants t
             ${LATEST_SUBSCRIPTION_LATERAL}
             LEFT JOIN subscription_plans pl ON pl.id = sub."planId"
            WHERE t.deleted_at IS NULL
         ) s
        WHERE state IN (${usable})
        GROUP BY plan_id, plan_name
        ORDER BY count DESC, plan_name ASC`,
      [grace],
    );

    return rows.map((r: Record<string, unknown>) => ({
      planId: (r.plan_id as string) ?? null,
      planName: (r.plan_name as string) ?? null,
      count: n(r.count),
      monthlyValue: round2(n(r.monthly_value)),
    }));
  }

  /** Next renewals, soonest first. Bounded list — the full view lives on /platform/usage. */
  private async upcomingRenewals(grace: number): Promise<UpcomingRenewal[]> {
    const rows = await this.dataSource.query(
      `SELECT * FROM (
         SELECT t.id AS tenant_id, t.name AS tenant_name, pl.name AS plan_name,
                sub.ends_at, sub.auto_renew,
                (${effectiveStatusSql('sub', '$1')}) AS state
           FROM tenants t
           ${LATEST_SUBSCRIPTION_LATERAL}
           LEFT JOIN subscription_plans pl ON pl.id = sub."planId"
          WHERE t.deleted_at IS NULL AND sub.ends_at IS NOT NULL AND sub.ends_at > $2
       ) s
       WHERE state IN ('${DASHBOARD_SUBSCRIPTION_STATE.ACTIVE}','${DASHBOARD_SUBSCRIPTION_STATE.TRIAL}')
       ORDER BY ends_at ASC
       LIMIT ${SNAPSHOT_LIST_LIMIT}`,
      [grace, new Date()],
    );

    return rows.map((r: Record<string, unknown>) => ({
      tenantId: r.tenant_id as string,
      tenantName: r.tenant_name as string,
      planName: (r.plan_name as string) ?? null,
      endsAt: iso(r.ends_at),
      autoRenew: r.auto_renew === true,
      state: r.state as string,
    }));
  }

  // ───────────────────────────── Tenant health ──────────────────────────── //

  /**
   * Clinics needing attention, each carrying the EVIDENCE that surfaced it.
   *
   * Deliberately not a health score. A composite number would need an agreed
   * formula, per-factor weights, an "insufficient data" state for young tenants,
   * and a visible admission that `api_logs` traffic is a proxy for engagement
   * rather than engagement itself. Without all four it is a figure that looks
   * authoritative and is not, so this returns the reasons and lets the operator
   * judge.
   *
   * Each reason is a stable CODE, translated client-side — the backend composes
   * no prose.
   */
  private async tenantHealth(grace: number): Promise<TenantHealthRow[]> {
    const dormantSince = new Date(Date.now() - 30 * DAY_MS);
    const approvedSince = new Date(Date.now() - 7 * DAY_MS);

    const rows = await this.dataSource.query(
      `WITH base AS (
         SELECT t.id, t.name, t.created_at, t.is_active, t.approval_status,
                (${effectiveStatusSql('sub', '$1')}) AS state,
                (SELECT MAX(a.created_at) FROM api_logs a WHERE a."tenantId" = t.id) AS last_activity,
                EXISTS (
                  SELECT 1 FROM whatsapp_accounts w
                   WHERE w."tenantId" = t.id AND w.deleted_at IS NULL
                     AND w.connection_status IN ('EXPIRED','REVOKED')
                ) AS integration_broken
           FROM tenants t
           ${LATEST_SUBSCRIPTION_LATERAL}
          WHERE t.deleted_at IS NULL
            AND t.approval_status = '${TenantApprovalStatus.APPROVED}'
       )
       SELECT id, name, state, last_activity, integration_broken,
              (NOT is_active) AS never_activated,
              (last_activity IS NULL OR last_activity < $2) AS dormant,
              (created_at < $3) AS settled_in
         FROM base
        WHERE integration_broken
           OR NOT is_active
           OR state = '${DASHBOARD_SUBSCRIPTION_STATE.NONE}'
           OR state = '${DASHBOARD_SUBSCRIPTION_STATE.GRACE_EXPIRED}'
           OR state = '${DASHBOARD_SUBSCRIPTION_STATE.PAST_DUE}'
           OR ((last_activity IS NULL OR last_activity < $2) AND created_at < $3)
        ORDER BY integration_broken DESC, last_activity ASC NULLS FIRST
        LIMIT ${SNAPSHOT_LIST_LIMIT}`,
      [grace, dormantSince, approvedSince],
    );

    return rows.map((r: Record<string, unknown>) => {
      const reasons: string[] = [];
      if (r.integration_broken === true) reasons.push('INTEGRATION_BROKEN');
      if (r.never_activated === true) reasons.push('NOT_ACTIVATED');
      if (r.state === DASHBOARD_SUBSCRIPTION_STATE.NONE) reasons.push('NO_SUBSCRIPTION');
      if (r.state === DASHBOARD_SUBSCRIPTION_STATE.GRACE_EXPIRED) reasons.push('GRACE_EXPIRED');
      if (r.state === DASHBOARD_SUBSCRIPTION_STATE.PAST_DUE) reasons.push('PAST_DUE');
      // Only claim dormancy once a clinic has had a week to start using the
      // product — otherwise every new signup is flagged on day one.
      if (r.dormant === true && r.settled_in === true) reasons.push('DORMANT');
      return {
        tenantId: r.id as string,
        tenantName: r.name as string,
        reasons,
        lastActivityAt: iso(r.last_activity),
        subscriptionState: r.state as string,
      };
    });
  }

  // ──────────────────────────── Action counters ─────────────────────────── //

  /** Badge counts for the quick-action rail. Ticket counts come from their owning service. */
  private async actionCounts() {
    const [counts, ticketKpis] = await Promise.all([
      this.dataSource.query(
        `SELECT
           (SELECT COUNT(*) FROM tenants
             WHERE deleted_at IS NULL AND approval_status = '${TenantApprovalStatus.PENDING_APPROVAL}')::int AS pending_approvals,
           (SELECT COUNT(DISTINCT "tenantId") FROM tenant_verification_documents
             WHERE status = 'PENDING' AND deleted_at IS NULL)::int AS pending_docs,
           (SELECT COUNT(*) FROM billing_upgrade_requests
             WHERE status IN (${OPEN_UPGRADE_STATUSES.map((s) => `'${s}'`).join(',')}))::int AS upgrade_requests`,
      ),
      this.tickets.kpis().catch(() => ({ urgent: 0, open: 0 })),
    ]);
    const row = counts[0] ?? {};
    return {
      pendingApprovals: n(row.pending_approvals),
      pendingVerificationDocs: n(row.pending_docs),
      urgentTickets: n(ticketKpis.urgent),
      openTickets: n(ticketKpis.open),
      upgradeRequests: n(row.upgrade_requests),
    };
  }

  // ─────────────────────────────── Summary ──────────────────────────────── //

  /**
   * Period metrics with a same-length comparison window, plus trend series.
   *
   * Current and previous windows are folded into ONE query per domain via
   * `FILTER`, rather than issuing the same aggregate twice — the comparison
   * costs a predicate, not a round-trip.
   *
   * `platformRevenue` is the marketplace commission (`payments.platform_fee`),
   * which is V1's definition of platform revenue. SaaS subscription invoicing is
   * a separate ledger and is deliberately not mixed in here.
   */
  async summary(q: QueryDashboardRangeDto): Promise<DashboardSummary> {
    const range = resolveRange(q);
    const [tenantRow, paymentRow, refundRow, currencies, baseline, series] =
      await Promise.all([
        this.tenantPeriodMetrics(range),
        this.paymentPeriodMetrics(range),
        this.refundPeriodMetrics(range),
        this.currenciesInRange(range),
        this.earliestRecord(),
        this.trendSeries(range),
      ]);

    // A comparison against a window that predates every record in the system is
    // not "0% change", it is not comparable — and saying so is the honest
    // rendering.
    const hasBaseline = baseline !== null && baseline <= range.previousTo;

    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        previousFrom: range.previousFrom.toISOString(),
        previousTo: range.previousTo.toISOString(),
        bucket: range.bucket,
        timezone: range.timezone,
      },
      currencies,
      metrics: {
        newTenants: compare('newTenants', n(tenantRow.cur), n(tenantRow.prev), hasBaseline),
        platformRevenue: compare(
          'platformRevenue',
          round2(n(paymentRow.rev_cur)),
          round2(n(paymentRow.rev_prev)),
          hasBaseline,
        ),
        grossVolume: compare(
          'grossVolume',
          round2(n(paymentRow.gross_cur)),
          round2(n(paymentRow.gross_prev)),
          hasBaseline,
        ),
        failedPayments: compare(
          'failedPayments',
          n(paymentRow.failed_cur),
          n(paymentRow.failed_prev),
          hasBaseline,
        ),
        payingTenants: compare(
          'payingTenants',
          n(paymentRow.paying_cur),
          n(paymentRow.paying_prev),
          hasBaseline,
        ),
        refunds: compare(
          'refunds',
          round2(n(refundRow.cur)),
          round2(n(refundRow.prev)),
          hasBaseline,
        ),
      },
      series,
      collectedAt: new Date().toISOString(),
    };
  }

  private async tenantPeriodMetrics(r: ResolvedRange) {
    const [row] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS cur,
         COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $4)::int AS prev
       FROM tenants WHERE deleted_at IS NULL`,
      [r.from, r.to, r.previousFrom, r.previousTo],
    );
    return row ?? {};
  }

  /**
   * Revenue, volume, failures and paying clinics in one pass.
   *
   * Revenue and volume key off `paid_at` (when money actually moved); failures
   * key off `created_at` (a failed payment has no `paid_at`). Mixing those would
   * silently drop every failure from the window.
   */
  private async paymentPeriodMetrics(r: ResolvedRange) {
    const [row] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(platform_fee) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= $1 AND paid_at < $2), 0) AS rev_cur,
         COALESCE(SUM(platform_fee) FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= $3 AND paid_at < $4), 0) AS rev_prev,
         COALESCE(SUM(amount)       FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= $1 AND paid_at < $2), 0) AS gross_cur,
         COALESCE(SUM(amount)       FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= $3 AND paid_at < $4), 0) AS gross_prev,
         COUNT(*) FILTER (WHERE status = 'FAILED' AND created_at >= $1 AND created_at < $2)::int AS failed_cur,
         COUNT(*) FILTER (WHERE status = 'FAILED' AND created_at >= $3 AND created_at < $4)::int AS failed_prev,
         COUNT(DISTINCT "tenantId") FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= $1 AND paid_at < $2)::int AS paying_cur,
         COUNT(DISTINCT "tenantId") FILTER (WHERE status IN ('PAID', 'PARTIALLY_REFUNDED') AND paid_at >= $3 AND paid_at < $4)::int AS paying_prev
       FROM payments
      WHERE purpose = ANY($5)`,
      [r.from, r.to, r.previousFrom, r.previousTo, [...CLINIC_REVENUE_PURPOSES]],
    );
    return row ?? {};
  }

  private async refundPeriodMetrics(r: ResolvedRange) {
    const [row] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(rf.amount) FILTER (WHERE rf.created_at >= $1 AND rf.created_at < $2), 0) AS cur,
         COALESCE(SUM(rf.amount) FILTER (WHERE rf.created_at >= $3 AND rf.created_at < $4), 0) AS prev
       FROM refunds rf
       JOIN payments rp ON rp.id = rf."paymentId"
      WHERE rf.status = 'SUCCEEDED' AND rp.purpose = ANY($5)`,
      [r.from, r.to, r.previousFrom, r.previousTo, [...CLINIC_REVENUE_PURPOSES]],
    );
    return row ?? {};
  }

  /**
   * Currencies represented in the window's PAID set.
   *
   * The money figures above SUM without grouping by currency. Reporting the set
   * lets the UI refuse to stamp a single symbol on a mixed total, instead of
   * presenting unlike units added together as though they were comparable.
   */
  private async currenciesInRange(r: ResolvedRange): Promise<string[]> {
    const rows = await this.dataSource.query(
      `SELECT DISTINCT currency FROM payments
        WHERE status = 'PAID' AND purpose = ANY($3) AND currency IS NOT NULL
          AND paid_at >= $1 AND paid_at < $2
        ORDER BY currency`,
      [r.from, r.to, [...CLINIC_REVENUE_PURPOSES]],
    );
    return rows.map((x: { currency: string }) => x.currency);
  }

  /** Oldest tenant registration — the platform's own epoch, for baseline checks. */
  private async earliestRecord(): Promise<Date | null> {
    const [row] = await this.dataSource.query(
      `SELECT MIN(created_at) AS first FROM tenants WHERE deleted_at IS NULL`,
    );
    return row?.first ? new Date(row.first) : null;
  }

  /**
   * Tenant growth and revenue over the window.
   *
   * `generate_series` supplies the buckets so a period with no activity renders
   * as a zero, not a gap — a chart that silently omits empty days misreports the
   * shape of the trend. Bucket count is bounded by `resolveRange`.
   */
  private async trendSeries(r: ResolvedRange) {
    const fmt = BUCKET_FORMAT[r.bucket];
    const step = `1 ${r.bucket}`;

    const [growth, revenue] = await Promise.all([
      this.dataSource.query(
        `WITH buckets AS (
           SELECT generate_series(date_trunc('${r.bucket}', $1::timestamptz),
                                  date_trunc('${r.bucket}', $2::timestamptz),
                                  interval '${step}') AS b
         )
         SELECT to_char(b, '${fmt}') AS bucket,
                COALESCE(COUNT(t.id), 0)::int AS value
           FROM buckets
           LEFT JOIN tenants t
             ON t.deleted_at IS NULL
            AND t.created_at >= b AND t.created_at < b + interval '${step}'
            AND t.created_at >= $1 AND t.created_at < $2
          GROUP BY b ORDER BY b`,
        [r.from, r.to],
      ),
      this.dataSource.query(
        `WITH buckets AS (
           SELECT generate_series(date_trunc('${r.bucket}', $1::timestamptz),
                                  date_trunc('${r.bucket}', $2::timestamptz),
                                  interval '${step}') AS b
         )
         SELECT to_char(b, '${fmt}') AS bucket,
                COALESCE(SUM(p.platform_fee), 0) AS value,
                COALESCE(COUNT(p.id), 0)::int AS secondary
           FROM buckets
           LEFT JOIN payments p
             ON p.status = 'PAID'
            AND p.purpose = ANY($3)
            AND p.paid_at >= b AND p.paid_at < b + interval '${step}'
            AND p.paid_at >= $1 AND p.paid_at < $2
          GROUP BY b ORDER BY b`,
        [r.from, r.to, [...CLINIC_REVENUE_PURPOSES]],
      ),
    ]);

    // Cumulative is derived here rather than with a SQL window function: the
    // running total is over the RETURNED buckets only, which is what the chart
    // draws, and computing it in SQL would invite it to be read as an
    // all-time total it is not.
    let running = 0;
    return {
      tenantGrowth: growth.map((g: Record<string, unknown>) => {
        running += n(g.value);
        return { bucket: g.bucket as string, value: n(g.value), secondary: running };
      }),
      revenue: revenue.map((g: Record<string, unknown>) => ({
        bucket: g.bucket as string,
        value: round2(n(g.value)),
        secondary: n(g.secondary),
      })),
    };
  }

  // ─────────────────────────────── Activity ─────────────────────────────── //

  /**
   * Recent platform activity, from an ALLOWLISTED projection.
   *
   * `audit_logs.old_values` / `new_values` hold plan pricing, system-setting
   * payloads and override reasons; `ip_address` identifies the operator's
   * location. None of it belongs on a landing page, so the SELECT names its
   * columns explicitly and the mapper builds a fixed shape — widening either
   * requires editing both, and `platform-dashboard.activity-projection.spec.ts`
   * fails if the SELECT ever grows.
   *
   * Actors are a display NAME only: no email, no user id.
   */
  async activity(q: QueryDashboardRangeDto, limit = SNAPSHOT_LIST_LIMIT) {
    const range = resolveRange(q);
    const capped = Math.min(Math.max(limit, 1), 50);

    const [approvals, adminActions] = await Promise.all([
      this.dataSource.query(
        `SELECT e.action, e.created_at, t.id AS tenant_id, t.name AS tenant_name,
                u.full_name AS actor_name
           FROM tenant_approval_events e
           JOIN tenants t ON t.id = e."tenantId"
           LEFT JOIN users u ON u.id::text = e.acted_by
          WHERE e.created_at >= $1 AND e.created_at < $2
          ORDER BY e.created_at DESC
          LIMIT ${capped}`,
        [range.from, range.to],
      ),
      this.dataSource.query(
        `SELECT a.action, a.entity_type, a.created_at, u.full_name AS actor_name,
                t.name AS tenant_name
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a."userId"
           LEFT JOIN tenants t ON t.id = a."tenantId"
          WHERE a.created_at >= $1 AND a.created_at < $2
            AND a.action LIKE 'platform_admin.%'
          ORDER BY a.created_at DESC
          LIMIT ${capped}`,
        [range.from, range.to],
      ),
    ]);

    const items: ActivityItem[] = [
      ...approvals.map((r: Record<string, unknown>) => ({
        type: 'tenant_approval' as const,
        action: r.action as string,
        at: new Date(r.created_at as string).toISOString(),
        actor: { displayName: (r.actor_name as string) ?? null },
        target: {
          type: 'tenant',
          id: (r.tenant_id as string) ?? null,
          label: (r.tenant_name as string) ?? null,
        },
      })),
      ...adminActions.map((r: Record<string, unknown>) => ({
        type: 'platform_admin' as const,
        action: r.action as string,
        at: new Date(r.created_at as string).toISOString(),
        actor: { displayName: (r.actor_name as string) ?? null },
        target: {
          type: (r.entity_type as string) ?? 'platform',
          // No entity id: an audit row's target can be a plan, a setting or a
          // gateway, and none of those has a page to deep-link to from here.
          id: null,
          label: (r.tenant_name as string) ?? null,
        },
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, capped);

    return {
      items,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      collectedAt: new Date().toISOString(),
    };
  }

  /** Exposed for the alert service, which shares the grace-window source. */
  get graceWindowDays(): number {
    return this.graceDays();
  }

  /** Exposed for tests and the alert service — start of the current UTC day. */
  static startOfUtcDay = startOfUtcDay;
}
