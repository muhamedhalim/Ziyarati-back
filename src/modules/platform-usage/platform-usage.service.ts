import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { escapeSpreadsheetCell } from '../../common/import/spreadsheet-escape';
import { UsageService } from '../subscription-billing/usage.service';
import { SubscriptionService } from '../subscription-billing/subscription.service';
import { AccessControlService } from '../subscription-billing/access-control.service';
import {
  currentPeriodMonth,
  RESOURCE_LIMIT_MAP,
  type ResourceMetric,
  type UnifiedUsageLine,
} from '../subscription-billing/usage-metric';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { QueueService } from '../../queue/queue.service';

import { QueryTenantUsageDto } from './dto/query-tenant-usage.dto';
import { QueryTimelineDto } from './dto/query-timeline.dto';
import {
  PLAN_LIMIT_COLUMN,
  USAGE_METRICS,
  USAGE_METRIC_ORDER,
  type UsageMetricDef,
} from './usage-metrics.registry';
import {
  OVERAGE_PRICING,
  computeForecast,
  daysElapsedInMonth,
  type OveragePricingStrategy,
  type OverageProjection,
  type UsageForecast,
} from './usage-forecast';
import {
  buildUsageAlert,
  usageStatus,
  type UsageAlert,
  type UsageLine,
  type UsageStatus,
} from './usage-status';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Time-series + breakdown bundle for a metric drill-down (PART 6/7). */
export interface UsageCharts {
  hourly?: { label: string; value: number }[];
  daily?: { label: string; value: number }[];
  weekly?: { label: string; value: number }[];
  monthly?: { label: string; value: number }[];
  breakdown?: { label: string; value: number }[];
}

/** One metric line as rendered on the tenant detail grid (PART 3/5). */
export interface MetricCell {
  key: string;
  label: string;
  kind: UsageMetricDef['kind'];
  unit: UsageMetricDef['unit'];
  used: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  exceeded: boolean;
  unlimited: boolean;
  /** Enforced AND exceeded — new writes of this resource are rejected. */
  blocked: boolean;
  status: UsageStatus;
  drilldown: boolean;
  /** Linear exhaustion forecast from historical daily growth (PART 1). */
  forecast: UsageForecast;
  /** Projected overage cost via the pluggable pricing strategy (PART 4). */
  overage: OverageProjection;
}

export interface TenantUsageRow {
  tenantId: string;
  tenantName: string;
  slug: string;
  planId: string | null;
  planName: string | null;
  subscriptionStatus: string | null; // raw enum
  effectiveStatus: string; // incl. EXPIRED / NONE
  isTrial: boolean;
  isUsable: boolean;
  enforced: boolean; // usage limits enforced right now
  currentPeriod: string;
  periodStart: string | null;
  renewalDate: string | null;
  lastActivity: string | null;
  utilizationPercent: number; // overview: max quota utilisation
  overLimit: boolean;
}

/**
 * Super-admin Platform Usage aggregator.
 *
 * The Subscription Module remains the SINGLE SOURCE OF TRUTH:
 *   • Per-metric quota numbers (Used/Limit/Remaining/%/Exceeded) always come from
 *     `UsageService.getBreakdown()` — never recomputed here.
 *   • Subscription state / trial / usability come from `SubscriptionService`.
 *   • Whether limits are enforced comes from `AccessControlService.isEnforced()`.
 *
 * This service adds ONLY the cross-tenant, super-admin lens the clinic-scoped
 * services don't provide: a batched overview list, platform totals, activity
 * counts for metrics with no plan limit, and drill-down time-series. All reads
 * are batched to avoid N+1 (one grouped query per aggregate, per page).
 */
@Injectable()
export class PlatformUsageService {

  constructor(
    private readonly dataSource: DataSource,
    private readonly usage: UsageService,
    private readonly subscriptions: SubscriptionService,
    private readonly access: AccessControlService,
    private readonly queues: QueueService,
    @Inject(OVERAGE_PRICING)
    private readonly pricing: OveragePricingStrategy,
  ) {}

  // ───────────────────────────── Tenant list ──────────────────────────────

  /** Paginated / filtered / sorted tenant usage overview (PART 1/2). */
  async listTenants(q: QueryTenantUsageDto): Promise<{
    data: TenantUsageRow[];
    total: number;
    page: number;
    limit: number;
    periodMonth: string;
  }> {
    const period = q.periodMonth ?? currentPeriodMonth();
    const { whereSql, params } = this.buildListFilters(q, period);
    const cte = this.baseCte(period);

    const orderCol = this.sortColumn(q.sortBy);
    const dir = q.sortDir === 'ASC' ? 'ASC' : 'DESC';

    const totalRows = await this.dataSource.query(
      `${cte} SELECT COUNT(*)::int AS cnt FROM base ${whereSql}`,
      params,
    );
    const total = n(totalRows[0]?.cnt);

    const offset = (q.page - 1) * q.limit;
    const rows = await this.dataSource.query(
      `${cte}
       SELECT * FROM base ${whereSql}
       ORDER BY ${orderCol} ${dir} NULLS LAST, name ASC
       LIMIT ${q.limit} OFFSET ${offset}`,
      params,
    );

    const tenantIds = rows.map((r: Record<string, unknown>) => r.id as string);
    const lastActivity = await this.lastActivityMap(tenantIds);

    // Enforcement is per-tenant (global billing mode + per-tenant overrides).
    // Computed only for the page (≤ limit) to avoid a platform-wide N+1.
    const enforcement = await Promise.all(
      tenantIds.map((id) => this.access.isEnforced(id).catch(() => true)),
    );

    const data: TenantUsageRow[] = rows.map((r: Record<string, unknown>, i: number) =>
      this.mapListRow(r, period, lastActivity.get(r.id as string) ?? null, enforcement[i]),
    );

    return { data, total, page: q.page, limit: q.limit, periodMonth: period };
  }

  /**
   * Common CTE: tenant ⨝ latest subscription ⨝ plan ⨝ period usage + derived cols.
   *
   * NOTE on `su.subscription_id::text = <sub>.id::text` (here and in the three
   * other raw-SQL joins in this file): the cast is on BOTH sides deliberately,
   * because `subscription_usage.subscription_id` does not have the same type in
   * every environment. The baseline migration created it as `character varying`,
   * while the entity declares `@Column({ type: 'uuid' })` — so a migration-built
   * database (staging/production, where `TYPEORM_SYNCHRONIZE` is refused) has
   * `varchar` and a `synchronize` dev box has `uuid`. Casting one side only
   * works in exactly one of those and raises `operator does not exist: uuid =
   * text` in the other. Casting both is the only form that holds everywhere.
   * Do not "simplify" this to a bare `=`.
   */
  private baseCte(period: string): string {
    // Utilisation reads the SAME subscription_usage rows getBreakdown reads and
    // applies the SAME ratio; it is an OVERVIEW/sort key only. Authoritative
    // per-metric numbers are always served from getBreakdown (detail/drilldown).
    const ratio = (used: string, limit: string) =>
      `CASE WHEN pl.${limit} IS NULL OR pl.${limit} = 0 THEN 0 ELSE (${used})::numeric / pl.${limit} END`;
    const util = `GREATEST(
      ${ratio('su.ai_tokens_used', 'max_ai_tokens')},
      ${ratio('su.whatsapp_messages_used', 'max_whatsapp_messages')},
      ${ratio('su.appointments_used', 'max_appointments')},
      ${ratio('su.campaigns_used', 'max_campaigns')}
    )`;
    const overLimit = `(
      (pl.max_ai_tokens IS NOT NULL AND COALESCE(su.ai_tokens_used,0)::numeric > pl.max_ai_tokens) OR
      (pl.max_whatsapp_messages IS NOT NULL AND COALESCE(su.whatsapp_messages_used,0) > pl.max_whatsapp_messages) OR
      (pl.max_appointments IS NOT NULL AND COALESCE(su.appointments_used,0) > pl.max_appointments) OR
      (pl.max_campaigns IS NOT NULL AND COALESCE(su.campaigns_used,0) > pl.max_campaigns)
    )`;
    return `
      WITH base AS (
        SELECT
          t.id, t.name, t.slug, t.created_at,
          sub.id AS sub_id, sub.status AS sub_status, sub.starts_at, sub.ends_at,
          sub.auto_renew, sub."planId" AS plan_id,
          pl.name AS plan_name,
          CASE
            WHEN sub.id IS NULL THEN 'NONE'
            WHEN sub.status IN ('ACTIVE','TRIAL') AND sub.ends_at < now() THEN 'EXPIRED'
            ELSE sub.status::text
          END AS effective_status,
          COALESCE(ROUND(${util} * 100, 1), 0) AS utilization,
          COALESCE(${overLimit}, false) AS over_limit
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT s.id, s.status, s.starts_at, s.ends_at, s.auto_renew, s."planId"
          FROM subscriptions s
          WHERE s."tenantId" = t.id AND s.deleted_at IS NULL
          ORDER BY s.created_at DESC LIMIT 1
        ) sub ON true
        LEFT JOIN subscription_plans pl ON pl.id = sub."planId"
        LEFT JOIN subscription_usage su ON su.subscription_id::text = sub.id::text AND su.period_month = '${period}'
        WHERE t.deleted_at IS NULL
      )`;
  }

  private buildListFilters(q: QueryTenantUsageDto, _period: string) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.search?.trim()) {
      params.push(`%${q.search.trim()}%`);
      clauses.push(`(name ILIKE $${params.length} OR slug ILIKE $${params.length})`);
    }
    if (q.status) {
      params.push(q.status);
      clauses.push(`effective_status = $${params.length}`);
    }
    if (q.planId) {
      params.push(q.planId);
      clauses.push(`plan_id = $${params.length}`);
    }
    if (q.overLimit === 'true') clauses.push(`over_limit = true`);
    return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private sortColumn(sortBy: string): string {
    switch (sortBy) {
      case 'created_at':
        return 'created_at';
      case 'status':
        return 'effective_status';
      case 'utilization':
        return 'utilization';
      case 'lastActivity':
        return 'created_at'; // last-activity not in CTE; falls back to signup order
      case 'name':
      default:
        return 'name';
    }
  }

  private async lastActivityMap(tenantIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (tenantIds.length === 0) return map;
    const rows = await this.dataSource.query(
      `SELECT "tenantId" AS tid, MAX(created_at) AS last
         FROM api_logs WHERE "tenantId" = ANY($1) GROUP BY "tenantId"`,
      [tenantIds],
    );
    for (const r of rows) if (r.last) map.set(r.tid, new Date(r.last).toISOString());
    return map;
  }

  private mapListRow(
    r: Record<string, unknown>,
    period: string,
    lastActivity: string | null,
    enforced: boolean,
  ): TenantUsageRow {
    const effective = r.effective_status as string;
    return {
      tenantId: r.id as string,
      tenantName: r.name as string,
      slug: r.slug as string,
      planId: (r.plan_id as string) ?? null,
      planName: (r.plan_name as string) ?? null,
      subscriptionStatus: (r.sub_status as string) ?? null,
      effectiveStatus: effective,
      isTrial: effective === 'TRIAL',
      isUsable: effective === 'ACTIVE' || effective === 'TRIAL',
      enforced,
      currentPeriod: period,
      periodStart: iso(r.starts_at),
      renewalDate: iso(r.ends_at),
      lastActivity,
      utilizationPercent: n(r.utilization),
      overLimit: r.over_limit === true,
    };
  }

  // ───────────────────────────── Platform totals ──────────────────────────

  /** Platform-wide totals + headline alerts (PART 9). */
  async summary(periodMonth?: string) {
    const period = periodMonth ?? currentPeriodMonth();

    const [metered] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(ai_tokens_used),0)::bigint AS ai_tokens,
         COALESCE(SUM(whatsapp_messages_used),0)::bigint AS messages,
         COALESCE(SUM(appointments_used),0)::bigint AS bookings
       FROM subscription_usage WHERE period_month = $1`,
      [period],
    );
    const [counts] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM api_logs WHERE created_at >= date_trunc('month', now())) AS api_calls,
         (SELECT COALESCE(SUM(file_size),0) FROM file_uploads) AS storage_bytes,
         (SELECT COUNT(*) FROM file_uploads) AS uploads,
         (SELECT COUNT(*) FROM customers) AS customers,
         (SELECT COUNT(*) FROM tenants WHERE deleted_at IS NULL) AS tenants`,
    );
    const [subs] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('ACTIVE','TRIAL') AND ends_at > now())::int AS active_tenants
       FROM subscriptions WHERE deleted_at IS NULL`,
    );

    // Over-limit + unlimited-plan tenant counts (single scan, reuses period usage).
    const [flags] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE
           COALESCE(su.ai_tokens_used,0)::numeric > pl.max_ai_tokens OR
           COALESCE(su.whatsapp_messages_used,0) > pl.max_whatsapp_messages OR
           COALESCE(su.appointments_used,0) > pl.max_appointments OR
           COALESCE(su.campaigns_used,0) > pl.max_campaigns
         )::int AS over_limit,
         COUNT(*) FILTER (WHERE
           pl.max_ai_tokens IS NULL AND pl.max_whatsapp_messages IS NULL AND
           pl.max_appointments IS NULL AND pl.max_campaigns IS NULL
         )::int AS unlimited
       FROM subscriptions s
       JOIN subscription_plans pl ON pl.id = s."planId"
       LEFT JOIN subscription_usage su ON su.subscription_id::text = s.id::text AND su.period_month = $1
       WHERE s.deleted_at IS NULL AND s.status IN ('ACTIVE','TRIAL')`,
      [period],
    );

    const queueCounts = await this.queues.queueCounts().catch(() => ({}));
    let queueDepth = 0;
    for (const c of Object.values(queueCounts)) {
      queueDepth += n(c.waiting) + n(c.active) + n(c.delayed);
    }

    const [alerts, insights] = await Promise.all([this.alerts(period), this.platformInsights(period)]);

    return {
      periodMonth: period,
      totals: {
        totalAiTokens: n(metered?.ai_tokens),
        totalMessages: n(metered?.messages),
        totalBookings: n(metered?.bookings),
        totalApiCalls: n(counts?.api_calls),
        totalStorageBytes: n(counts?.storage_bytes),
        totalUploads: n(counts?.uploads),
        totalCustomers: n(counts?.customers),
        totalQueueJobs: queueDepth,
        totalActiveTenants: n(subs?.active_tenants),
        totalOverLimit: n(flags?.over_limit),
        totalUnlimitedPlans: n(flags?.unlimited),
      },
      insights,
      alertsCount: alerts.length,
      alerts: alerts.slice(0, 25),
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Extra platform KPIs (PART 4): metered quota rollup, most-consumed /
   * most-exceeded resource, top-10 tenants by utilisation + near-limit, recently
   * exceeded, and recent plan changes. All derived from the SAME
   * subscription_usage vs plan data the quotas use (reuses `baseCte`) — no new
   * calculations. Metered metrics only (they have comparable utilisation and no
   * per-tenant scan is needed); count-metric utilisation is per-tenant in detail.
   */
  private async platformInsights(period: string) {
    const cte = this.baseCte(period);

    // Top-10 by utilisation, near-limit, and recently-exceeded (reuse the CTE).
    const [topByUsage, nearLimit, recentlyExceeded] = await Promise.all([
      this.dataSource.query(
        `${cte} SELECT id, name, plan_name, utilization, over_limit FROM base
           WHERE plan_id IS NOT NULL ORDER BY utilization DESC NULLS LAST LIMIT 10`,
      ),
      this.dataSource.query(
        `${cte} SELECT id, name, plan_name, utilization FROM base
           WHERE plan_id IS NOT NULL AND over_limit = false AND utilization >= 80
           ORDER BY utilization DESC LIMIT 10`,
      ),
      this.dataSource.query(
        `${cte} SELECT id, name, plan_name, utilization FROM base
           WHERE over_limit = true ORDER BY utilization DESC LIMIT 10`,
      ),
    ]);

    // Per-metered-metric rollup: total used, total finite quota, exceed count, avg util.
    const [roll] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(su.ai_tokens_used),0) AS ai_used,
         COALESCE(SUM(pl.max_ai_tokens),0) AS ai_quota,
         COUNT(*) FILTER (WHERE pl.max_ai_tokens IS NOT NULL AND su.ai_tokens_used::numeric > pl.max_ai_tokens)::int AS ai_over,
         AVG(CASE WHEN pl.max_ai_tokens > 0 THEN su.ai_tokens_used::numeric / pl.max_ai_tokens END) AS ai_util,
         COALESCE(SUM(su.whatsapp_messages_used),0) AS wa_used,
         COALESCE(SUM(pl.max_whatsapp_messages),0) AS wa_quota,
         COUNT(*) FILTER (WHERE pl.max_whatsapp_messages IS NOT NULL AND su.whatsapp_messages_used > pl.max_whatsapp_messages)::int AS wa_over,
         AVG(CASE WHEN pl.max_whatsapp_messages > 0 THEN su.whatsapp_messages_used::numeric / pl.max_whatsapp_messages END) AS wa_util,
         COALESCE(SUM(su.appointments_used),0) AS ap_used,
         COALESCE(SUM(pl.max_appointments),0) AS ap_quota,
         COUNT(*) FILTER (WHERE pl.max_appointments IS NOT NULL AND su.appointments_used > pl.max_appointments)::int AS ap_over,
         AVG(CASE WHEN pl.max_appointments > 0 THEN su.appointments_used::numeric / pl.max_appointments END) AS ap_util,
         COALESCE(SUM(su.campaigns_used),0) AS ca_used,
         COALESCE(SUM(pl.max_campaigns),0) AS ca_quota,
         COUNT(*) FILTER (WHERE pl.max_campaigns IS NOT NULL AND su.campaigns_used > pl.max_campaigns)::int AS ca_over,
         AVG(CASE WHEN pl.max_campaigns > 0 THEN su.campaigns_used::numeric / pl.max_campaigns END) AS ca_util
       FROM subscriptions s
       JOIN subscription_plans pl ON pl.id = s."planId"
       LEFT JOIN subscription_usage su ON su.subscription_id::text = s.id::text AND su.period_month = $1
       WHERE s.deleted_at IS NULL AND s.status IN ('ACTIVE','TRIAL')`,
      [period],
    );

    const metered = [
      { key: 'aiTokens', label: 'AI Tokens', used: n(roll?.ai_used), quota: n(roll?.ai_quota), over: n(roll?.ai_over), util: n(roll?.ai_util) },
      { key: 'whatsappMessages', label: 'WhatsApp Messages', used: n(roll?.wa_used), quota: n(roll?.wa_quota), over: n(roll?.wa_over), util: n(roll?.wa_util) },
      { key: 'appointments', label: 'Appointments', used: n(roll?.ap_used), quota: n(roll?.ap_quota), over: n(roll?.ap_over), util: n(roll?.ap_util) },
      { key: 'campaigns', label: 'Campaigns', used: n(roll?.ca_used), quota: n(roll?.ca_quota), over: n(roll?.ca_over), util: n(roll?.ca_util) },
    ];
    const mostConsumed = [...metered].sort((a, b) => b.util - a.util)[0];
    const mostExceeded = [...metered].sort((a, b) => b.over - a.over)[0];

    // Recent plan changes (updated after creation). Direction (up/down) is not
    // tracked without a plan-change history table, so it is reported as "changed".
    const recentPlanChanges = await this.dataSource.query(
      `SELECT t.name AS tenant_name, pl.name AS plan_name, pl.price, s.status, s.updated_at
         FROM subscriptions s
         JOIN tenants t ON t.id = s."tenantId" AND t.deleted_at IS NULL
         JOIN subscription_plans pl ON pl.id = s."planId"
        WHERE s.deleted_at IS NULL AND s.updated_at > s.created_at
        ORDER BY s.updated_at DESC LIMIT 10`,
    );

    const mapTenant = (r: Record<string, unknown>) => ({
      tenantId: r.id as string,
      tenantName: r.name as string,
      planName: (r.plan_name as string) ?? null,
      utilizationPercent: n(r.utilization),
      overLimit: r.over_limit === true,
    });

    return {
      meteredRollup: metered.map((m) => ({
        ...m,
        remaining: m.quota ? Math.max(m.quota - m.used, 0) : 0,
        percentUsed: m.quota ? +((m.used / m.quota) * 100).toFixed(1) : null,
      })),
      mostConsumedResource: mostConsumed ? { key: mostConsumed.key, label: mostConsumed.label, avgUtilization: +(mostConsumed.util * 100).toFixed(1) } : null,
      mostExceededResource: mostExceeded ? { key: mostExceeded.key, label: mostExceeded.label, tenantsExceeded: mostExceeded.over } : null,
      topTenantsByUsage: topByUsage.map(mapTenant),
      topTenantsNearLimit: nearLimit.map(mapTenant),
      recentlyExceeded: recentlyExceeded.map(mapTenant),
      recentPlanChanges: recentPlanChanges.map((r: Record<string, unknown>) => ({
        tenantName: r.tenant_name as string,
        planName: r.plan_name as string,
        price: n(r.price),
        status: r.status as string,
        changedAt: new Date(r.updated_at as string).toISOString(),
      })),
    };
  }

  // ───────────────────────────── Alerts (PART 8) ──────────────────────────

  /**
   * Threshold + lifecycle alerts across all enforced tenants. Built from the
   * SAME subscription_usage vs plan data the quota system uses, via the shared
   * `buildUsageAlert` helper so the notification system can reuse the exact
   * classification. Only ENFORCED plans (with limits) can raise quota alerts.
   *
   * @param opts.actionableOnly pushes a PRE-FILTER into SQL so only rows that
   * could possibly raise an alert are materialised: a subscription in a
   * lifecycle state worth reporting, or a metric already at ≥80% of a finite
   * limit (the lowest threshold `buildUsageAlert` acts on). The classification
   * itself is untouched — the same helper runs over a smaller row set, so the
   * result is a subset of the unfiltered call, never a different answer.
   *
   * Added for the Platform Control Center, whose alert feed must stay bounded:
   * the unfiltered form loads EVERY subscription ⨝ plan ⨝ usage row into Node
   * and classifies in a JS loop, which is fine for a dedicated usage page and
   * far too much for a landing page. Default arguments preserve the original
   * behaviour exactly for every existing caller.
   */
  async alerts(
    periodMonth?: string,
    opts?: { actionableOnly?: boolean },
  ): Promise<UsageAlert[]> {
    const period = periodMonth ?? currentPeriodMonth();

    // 80% is `buildUsageAlert`'s lowest acting threshold. Anything below it can
    // never produce an alert, so excluding it in SQL cannot change the output.
    const atRisk = (used: string, limit: string) =>
      `(pl.${limit} IS NOT NULL AND pl.${limit} > 0 AND COALESCE(su.${used},0)::numeric >= pl.${limit} * 0.8)`;
    const prefilter = opts?.actionableOnly
      ? `AND (
           s.status IN ('PAST_DUE','SUSPENDED','CANCELLED','GRACE_EXPIRED')
           OR (s.status IN ('ACTIVE','TRIAL') AND s.ends_at < now())
           OR ${atRisk('ai_tokens_used', 'max_ai_tokens')}
           OR ${atRisk('whatsapp_messages_used', 'max_whatsapp_messages')}
           OR ${atRisk('appointments_used', 'max_appointments')}
           OR ${atRisk('campaigns_used', 'max_campaigns')}
         )`
      : '';

    const rows = await this.dataSource.query(
      `SELECT t.id AS tenant_id, t.name AS tenant_name,
              s.status AS sub_status, s.ends_at,
              pl.max_ai_tokens, pl.max_whatsapp_messages, pl.max_appointments, pl.max_campaigns,
              COALESCE(su.ai_tokens_used,0) AS ai_tokens_used,
              COALESCE(su.whatsapp_messages_used,0) AS whatsapp_messages_used,
              COALESCE(su.appointments_used,0) AS appointments_used,
              COALESCE(su.campaigns_used,0) AS campaigns_used
         FROM subscriptions s
         JOIN tenants t ON t.id = s."tenantId" AND t.deleted_at IS NULL
         JOIN subscription_plans pl ON pl.id = s."planId"
         LEFT JOIN subscription_usage su ON su.subscription_id::text = s.id::text AND su.period_month = $1
        WHERE s.deleted_at IS NULL ${prefilter}`,
      [period],
    );

    const out: UsageAlert[] = [];
    const quotaDefs: { metric: string; used: string; limit: string }[] = [
      { metric: 'aiTokens', used: 'ai_tokens_used', limit: 'max_ai_tokens' },
      { metric: 'whatsappMessages', used: 'whatsapp_messages_used', limit: 'max_whatsapp_messages' },
      { metric: 'appointments', used: 'appointments_used', limit: 'max_appointments' },
      { metric: 'campaigns', used: 'campaigns_used', limit: 'max_campaigns' },
    ];

    for (const r of rows) {
      const ctxBase = { tenantId: r.tenant_id as string, tenantName: r.tenant_name as string };

      // Lifecycle alerts (expired / suspended / past due).
      const effective =
        (r.sub_status === 'ACTIVE' || r.sub_status === 'TRIAL') && new Date(r.ends_at) < new Date()
          ? 'EXPIRED'
          : (r.sub_status as string);
      if (effective === 'EXPIRED' || effective === 'SUSPENDED' || effective === 'PAST_DUE') {
        out.push({
          ...ctxBase,
          metric: 'subscription',
          metricLabel: 'Subscription',
          threshold: 0,
          percentUsed: null,
          used: 0,
          limit: null,
          severity: effective === 'SUSPENDED' ? 'critical' : 'warning',
          message: `Subscription ${effective.toLowerCase().replace('_', ' ')}`,
        });
      }

      // Quota threshold alerts.
      for (const def of quotaDefs) {
        const limitRaw = r[def.limit];
        if (limitRaw === null || limitRaw === undefined) continue;
        const limit = Number(limitRaw);
        const used = Number(r[def.used]);
        const line: UsageLine = {
          used,
          limit,
          remaining: Math.max(limit - used, 0),
          percentUsed: limit === 0 ? null : +((used / limit) * 100).toFixed(1),
          exceeded: used > limit,
        };
        const alert = buildUsageAlert(
          { ...ctxBase, metric: def.metric, metricLabel: USAGE_METRICS[def.metric].label },
          line,
        );
        if (alert) out.push(alert);
      }
    }

    // Most severe first, then highest utilisation.
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.percentUsed ?? 0) - (a.percentUsed ?? 0));
    return out;
  }

  // ───────────────────────────── Tenant detail ────────────────────────────

  /** Full per-metric usage grid for one tenant (PART 3). */
  async tenantDetail(tenantId: string, periodMonth?: string) {
    const period = periodMonth ?? currentPeriodMonth();

    const tenant = await this.dataSource.query(
      `SELECT id, name, slug, is_active, approval_status, created_at
         FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!tenant[0]) throw new AppError(ErrorCode.TENANT_NOT_FOUND);

    // Subscription view + access — reused from the Subscription Module.
    let subscription: {
      status: string;
      effectiveStatus: string;
      isUsable: boolean;
      planId: string;
      planName: string;
      startsAt: string;
      endsAt: string;
      autoRenew: boolean;
      isTrial: boolean;
    } | null = null;
    try {
      const view = await this.subscriptions.getCurrent(tenantId);
      subscription = {
        status: view.subscription.status,
        effectiveStatus: view.effectiveStatus,
        isUsable: view.isUsable,
        planId: view.subscription.plan.id,
        planName: view.subscription.plan.name,
        startsAt: view.subscription.starts_at.toISOString(),
        endsAt: view.subscription.ends_at.toISOString(),
        autoRenew: view.subscription.auto_renew,
        isTrial: view.effectiveStatus === 'TRIAL',
      };
    } catch {
      subscription = null;
    }
    const accessDecision = await this.access.resolveAccess(tenantId).catch(() => null);
    const enforced = await this.access.isEnforced(tenantId).catch(() => true);

    // Live counts + 30-day growth — two batched round-trips (no N+1).
    const [live, growth30] = await Promise.all([
      this.liveCounts(tenantId, period),
      this.recentGrowthCounts(tenantId),
    ]);
    // SINGLE SOURCE: UsageService resolves EVERY metric's limit + line (metered
    // from subscription_usage, count-based from the plan + these live counts).
    // The platform service never reads a plan limit column directly.
    const unified = await this.usage.getUnifiedBreakdown(
      tenantId,
      live as Partial<Record<ResourceMetric, number>>,
      period,
    );

    const metrics: MetricCell[] = USAGE_METRIC_ORDER.map((key) => {
      const def = USAGE_METRICS[key];
      const line = unified[key];
      return this.buildMetricCell(def, line, this.avgDailyGrowth(def, line, growth30));
    });

    // Upgrade recommendation reuses the SAME unified breakdown + the plan catalogue.
    const recommendation = this.buildRecommendation(subscription, metrics);

    return {
      tenant: {
        id: tenant[0].id,
        name: tenant[0].name,
        slug: tenant[0].slug,
        isActive: tenant[0].is_active,
        approvalStatus: tenant[0].approval_status,
        createdAt: new Date(tenant[0].created_at).toISOString(),
      },
      subscription,
      access: accessDecision
        ? { allowed: accessDecision.allowed, source: accessDecision.source, enforced }
        : { allowed: false, source: 'NONE', enforced },
      periodMonth: period,
      metrics,
      recommendation: await recommendation,
      costProjection: this.costProjection(metrics),
      alerts: this.metricsToAlerts(tenant[0].id, tenant[0].name, metrics),
    };
  }

  /**
   * Smart upgrade recommendation (PART 2). Reuses the plan catalogue
   * (`SubscriptionService`) + the already-resolved metric cells — it NEVER reads
   * a limit any way other than through the plan columns. Picks the cheapest
   * higher plan whose limits clear every pressured resource.
   */
  private async buildRecommendation(
    subscription: { planId: string } | null,
    metrics: MetricCell[],
  ) {
    if (!subscription) {
      return { needed: false, reason: 'No active subscription', currentPlan: null, recommendedPlan: null, blockedResources: [], expectedBenefits: [], estimatedMonthlyIncrease: 0 };
    }
    const currentPlan = await this.subscriptions.getPlan(subscription.planId).catch(() => null);
    if (!currentPlan) {
      return { needed: false, reason: 'Current plan unavailable', currentPlan: null, recommendedPlan: null, blockedResources: [], expectedBenefits: [], estimatedMonthlyIncrease: 0 };
    }
    const currentPrice = Number(currentPlan.price);
    const cur = { id: currentPlan.id, name: currentPlan.name, price: currentPrice };

    const pressured = metrics.filter(
      (m) => m.limit !== null && (m.exceeded || m.blocked || (m.percentUsed ?? 0) >= 80),
    );
    if (pressured.length === 0) {
      return { needed: false, reason: 'Usage is healthy — no upgrade needed', currentPlan: cur, recommendedPlan: null, blockedResources: [], expectedBenefits: [], estimatedMonthlyIncrease: 0 };
    }

    const blockedResources = pressured.filter((m) => m.blocked).map((m) => m.label);
    const plans = await this.subscriptions.listPlans();
    const planLimit = (plan: SubscriptionPlan, metric: string): number | null => {
      const col = PLAN_LIMIT_COLUMN[metric];
      if (!col) return null;
      const raw = (plan as unknown as Record<string, unknown>)[col];
      return raw === null || raw === undefined ? null : Number(raw);
    };
    const higher = plans
      .filter((p) => Number(p.price) > currentPrice)
      .sort((a, b) => Number(a.price) - Number(b.price));
    const resolves = (plan: SubscriptionPlan) =>
      pressured.every((m) => {
        const lim = planLimit(plan, m.key);
        return lim === null || lim > m.used; // unlimited or comfortably above current usage
      });
    const recommended = higher.find(resolves) ?? higher[higher.length - 1] ?? null;

    if (!recommended) {
      return { needed: true, reason: 'Already on the highest plan — consider a custom plan', currentPlan: cur, recommendedPlan: null, blockedResources, expectedBenefits: [], estimatedMonthlyIncrease: 0 };
    }

    const expectedBenefits = pressured.map((m) => ({
      metric: m.key,
      label: m.label,
      currentLimit: m.limit,
      newLimit: planLimit(recommended, m.key),
    }));
    const names = pressured.map((m) => m.label);
    const reason = `${names.slice(0, 3).join(', ')} ${names.length > 1 ? 'are' : 'is'} near or over the plan limit`;

    return {
      needed: true,
      reason,
      currentPlan: cur,
      recommendedPlan: { id: recommended.id, name: recommended.name, price: Number(recommended.price) },
      blockedResources,
      expectedBenefits,
      estimatedMonthlyIncrease: +(Number(recommended.price) - currentPrice).toFixed(2),
    };
  }

  /** Standalone upgrade recommendation endpoint — reuses tenantDetail (no dup). */
  async recommendUpgrade(tenantId: string, periodMonth?: string) {
    const detail = await this.tenantDetail(tenantId, periodMonth);
    return {
      tenant: detail.tenant,
      subscription: detail.subscription,
      periodMonth: detail.periodMonth,
      recommendation: detail.recommendation,
    };
  }

  /** Aggregate projected overage cost across metrics (PART 4). */
  private costProjection(metrics: MetricCell[]) {
    const items = metrics
      .filter((m) => m.overage.overageUnits > 0)
      .map((m) => ({
        metric: m.key,
        label: m.label,
        unit: m.unit,
        overageUnits: m.overage.overageUnits,
        projectedCost: m.overage.projectedCost,
      }));
    const active = this.pricing.active;
    const total = active ? items.reduce((s, i) => s + (i.projectedCost ?? 0), 0) : null;
    return { active, currency: this.pricing.currency, total, items };
  }

  // ───────────────────────────── Timeline (PART 3) ────────────────────────

  /**
   * Per-tenant usage history timeline. `current` is the live quota snapshot
   * (exceeded/blocked/near/forecast + subscription state); `history` is paginated
   * from the shared `audit_logs` store (reused — no parallel event log). Filtered +
   * searchable. The view itself is audited by the controller.
   */
  async tenantTimeline(tenantId: string, q: QueryTimelineDto) {
    const detail = await this.tenantDetail(tenantId, q.periodMonth);
    const nowIso = new Date().toISOString();

    const current: { at: string; type: string; metric?: string; title: string; detail: string | null }[] = [];
    for (const m of detail.metrics) {
      if (m.unlimited) continue;
      if (m.blocked) current.push({ at: nowIso, type: 'blocked', metric: m.key, title: `${m.label} quota blocked`, detail: `${m.used}/${m.limit}` });
      else if (m.exceeded) current.push({ at: nowIso, type: 'exceeded', metric: m.key, title: `${m.label} limit exceeded`, detail: `${m.used}/${m.limit}` });
      else if ((m.percentUsed ?? 0) >= 90) current.push({ at: nowIso, type: 'warning', metric: m.key, title: `${m.label} at ${m.percentUsed}%`, detail: `${m.used}/${m.limit}` });
      if (m.forecast.willExhaust && (m.forecast.estimatedDaysToFull ?? Infinity) <= 30) {
        current.push({ at: nowIso, type: 'forecast', metric: m.key, title: `${m.label} projected full in ${m.forecast.estimatedDaysToFull}d`, detail: m.forecast.estimatedFullDate });
      }
    }
    if (detail.subscription) {
      current.push({ at: detail.subscription.startsAt, type: 'subscription', title: `Subscription ${detail.subscription.effectiveStatus} · ${detail.subscription.planName}`, detail: `renews ${detail.subscription.endsAt.slice(0, 10)}` });
    }

    // Historical events from the shared audit store.
    const where = [`(a."tenantId" = $1 OR a.entity_id = $1)`];
    const params: unknown[] = [tenantId];
    if (q.type) { params.push(q.type); where.push(`a.entity_type = $${params.length}`); }
    if (q.search?.trim()) { params.push(`%${q.search.trim()}%`); where.push(`(a.action ILIKE $${params.length} OR a.entity_type ILIKE $${params.length})`); }
    const whereSql = where.join(' AND ');

    const [cnt] = await this.dataSource.query(`SELECT COUNT(*)::int AS c FROM audit_logs a WHERE ${whereSql}`, params);
    const total = n(cnt?.c);
    const dir = q.sortDir === 'ASC' ? 'ASC' : 'DESC';
    const offset = (q.page - 1) * q.limit;
    const rows = await this.dataSource.query(
      `SELECT a.action, a.entity_type, a.entity_id, a.created_at,
              COALESCE(u.full_name, u.email) AS actor
         FROM audit_logs a LEFT JOIN users u ON u.id = a."userId"
        WHERE ${whereSql} ORDER BY a.created_at ${dir} LIMIT ${q.limit} OFFSET ${offset}`,
      params,
    );

    return {
      tenant: detail.tenant,
      current,
      history: {
        data: rows.map((r: Record<string, unknown>) => ({
          at: new Date(r.created_at as string).toISOString(),
          type: r.entity_type as string,
          title: r.action as string,
          actor: (r.username as string) ?? null,
          entityId: (r.entity_id as string) ?? null,
        })),
        total,
        page: q.page,
        limit: q.limit,
      },
    };
  }

  // ─────────────────────────── Executive insights (PART 7) ─────────────────

  /**
   * Super-admin executive insights: top consumers, near-limit / exceeded,
   * inactive / dormant tenants, highest-cost, and largest 30-day increases. Each
   * is a single grouped query (no per-tenant N+1); over-limit / near-limit reuse
   * the same quota data the dashboard uses.
   */
  async executiveInsights(periodMonth?: string) {
    const period = periodMonth ?? currentPeriodMonth();

    const topConsumers = (table: string, measure: string, extraJoin = '', where = '') =>
      this.dataSource.query(
        `SELECT t.id, t.name, ${measure} AS value
           FROM ${table} x JOIN tenants t ON t.id = x."tenantId" AND t.deleted_at IS NULL ${extraJoin}
          ${where} GROUP BY t.id, t.name ORDER BY value DESC LIMIT 10`,
      );

    // 30-day vs prior-30-day increase for a time-stamped table.
    const recentExpr = (m: string) => `COALESCE(${m} FILTER (WHERE x.created_at >= now() - interval '30 days'),0)`;
    const priorExpr = (m: string) => `COALESCE(${m} FILTER (WHERE x.created_at >= now() - interval '60 days' AND x.created_at < now() - interval '30 days'),0)`;
    const largestIncrease = (table: string, measure: string) =>
      this.dataSource.query(
        `SELECT t.id, t.name,
                ${recentExpr(measure)} AS recent,
                ${priorExpr(measure)} AS prior
           FROM ${table} x JOIN tenants t ON t.id = x."tenantId" AND t.deleted_at IS NULL
          GROUP BY t.id, t.name
          ORDER BY (${recentExpr(measure)} - ${priorExpr(measure)}) DESC
          LIMIT 10`,
      );

    const [
      topStorage,
      topApi,
      topAi,
      inactive,
      dormant,
      highestCost,
      apiIncrease,
      storageIncrease,
    ] = await Promise.all([
      topConsumers('file_uploads', 'COALESCE(SUM(x.file_size),0)'),
      topConsumers('api_logs', 'COUNT(*)', '', `WHERE x.created_at >= now() - interval '30 days'`),
      topConsumers('ai_usage_logs', 'COALESCE(SUM(x.total_tokens),0)'),
      this.dataSource.query(
        `SELECT t.id, t.name, MAX(a.created_at) AS last_activity
           FROM tenants t LEFT JOIN api_logs a ON a."tenantId" = t.id
          WHERE t.deleted_at IS NULL
          GROUP BY t.id, t.name
          HAVING MAX(a.created_at) IS NULL OR MAX(a.created_at) < now() - interval '30 days'
          ORDER BY last_activity ASC NULLS FIRST LIMIT 10`,
      ),
      this.dataSource.query(
        `SELECT t.name AS tenant_name, s.status, s.ends_at, pl.name AS plan_name
           FROM subscriptions s JOIN tenants t ON t.id = s."tenantId" AND t.deleted_at IS NULL
           JOIN subscription_plans pl ON pl.id = s."planId"
          WHERE s.deleted_at IS NULL
            AND (s.status IN ('CANCELLED','SUSPENDED') OR (s.status IN ('ACTIVE','TRIAL') AND s.ends_at < now()))
          ORDER BY s.ends_at DESC LIMIT 10`,
      ),
      this.dataSource.query(
        `SELECT t.name AS tenant_name, pl.name AS plan_name, pl.price
           FROM subscriptions s JOIN tenants t ON t.id = s."tenantId" AND t.deleted_at IS NULL
           JOIN subscription_plans pl ON pl.id = s."planId"
          WHERE s.deleted_at IS NULL AND s.status IN ('ACTIVE','TRIAL')
          ORDER BY pl.price DESC LIMIT 10`,
      ),
      largestIncrease('api_logs', 'COUNT(*)'),
      largestIncrease('file_uploads', 'SUM(x.file_size)'),
    ]);

    const mapC = (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({ tenantId: r.id as string, tenantName: r.name as string, value: n(r.value) }));
    const mapInc = (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({ tenantId: r.id as string, tenantName: r.name as string, recent: n(r.recent), prior: n(r.prior), increase: n(r.recent) - n(r.prior) }));

    return {
      periodMonth: period,
      topStorageConsumers: mapC(topStorage),
      topApiConsumers: mapC(topApi),
      topAiConsumers: mapC(topAi),
      inactiveClinics: inactive.map((r: Record<string, unknown>) => ({
        tenantId: r.id as string,
        tenantName: r.name as string,
        lastActivity: r.last_activity ? new Date(r.last_activity as string).toISOString() : null,
      })),
      dormantSubscriptions: dormant.map((r: Record<string, unknown>) => ({
        tenantName: r.tenant_name as string,
        status: r.status as string,
        planName: r.plan_name as string,
        endsAt: new Date(r.ends_at as string).toISOString(),
      })),
      highestCostTenants: highestCost.map((r: Record<string, unknown>) => ({
        tenantName: r.tenant_name as string,
        planName: r.plan_name as string,
        price: n(r.price),
      })),
      largestApiIncrease: mapInc(apiIncrease),
      largestStorageIncrease: mapInc(storageIncrease),
    };
  }

  /**
   * Maps a metric's authoritative line (from `UsageService.getUnifiedBreakdown`)
   * onto a presentation cell. No limit/usage math happens here — it is all
   * resolved by the Subscription Module. A metric with no line renders as unlimited/0.
   */
  private buildMetricCell(
    def: UsageMetricDef,
    line?: UnifiedUsageLine,
    avgDailyGrowth: number | null = null,
  ): MetricCell {
    const used = line?.used ?? 0;
    const limit = line?.limit ?? null;
    const remaining = line?.remaining ?? null;
    const percentUsed = line?.percentUsed ?? null;
    const exceeded = line?.exceeded ?? false;
    const blocked = line?.blocked ?? false;
    const status = usageStatus({ limit, percentUsed, exceeded });

    // Forecast (PART 1) + overage cost (PART 4) — pure helper + pluggable pricing.
    const forecast = computeForecast({ used, limit, remaining, unlimited: limit === null, avgDailyGrowth });
    const overage = this.pricing.project(def.key, exceeded && limit !== null ? Math.max(used - limit, 0) : 0);

    return {
      key: def.key,
      label: def.label,
      kind: def.kind,
      unit: def.unit,
      used,
      limit,
      remaining,
      percentUsed,
      exceeded,
      unlimited: limit === null,
      blocked,
      status,
      drilldown: def.drilldown,
      forecast,
      overage,
    };
  }

  /** Average daily growth for a metric from HISTORY (never guessed). */
  private avgDailyGrowth(
    def: UsageMetricDef,
    line: UnifiedUsageLine | undefined,
    growth30: Record<string, number>,
  ): number | null {
    const s = def.source;
    if (!s) return null; // no source
    if (s.periodColumn) {
      // Only monthly granularity available → period-rate (used so far / days elapsed).
      const used = line?.used ?? 0;
      return used > 0 ? used / daysElapsedInMonth() : null;
    }
    if (s.timeColumn) {
      const g = growth30[def.key];
      return g != null && g > 0 ? g / 30 : null;
    }
    return null;
  }

  /** Batched last-30-day growth per time-stamped metric (one round-trip, no N+1). */
  private async recentGrowthCounts(tenantId: string): Promise<Record<string, number>> {
    const selects: string[] = [];
    const keys: string[] = [];
    for (const key of USAGE_METRIC_ORDER) {
      const s = USAGE_METRICS[key].source;
      if (!s || !s.timeColumn) continue;
      keys.push(key);
      const where = [
        `${s.tenantColumn} = $1${s.tenantIsText ? '::text' : ''}`,
        `${s.timeColumn} >= now() - interval '30 days'`,
      ];
      if (s.where) where.push(s.where);
      selects.push(`(SELECT ${s.measure} FROM ${s.table} WHERE ${where.join(' AND ')}) AS "${key}"`);
    }
    if (selects.length === 0) return {};
    const [row] = await this.dataSource.query(`SELECT ${selects.join(', ')}`, [tenantId]);
    const out: Record<string, number> = {};
    for (const key of keys) out[key] = n(row?.[key]);
    return out;
  }

  private metricsToAlerts(tenantId: string, tenantName: string, metrics: MetricCell[]): UsageAlert[] {
    const out: UsageAlert[] = [];
    for (const m of metrics) {
      if (m.limit === null) continue;
      const alert = buildUsageAlert(
        { tenantId, tenantName, metric: m.key, metricLabel: m.label },
        {
          used: m.used,
          limit: m.limit,
          remaining: m.remaining,
          percentUsed: m.percentUsed,
          exceeded: m.exceeded,
          unlimited: m.unlimited,
          blocked: m.blocked,
        },
      );
      if (alert) out.push(alert);
    }
    return out;
  }

  /**
   * One batched round-trip returning every count/activity metric for a tenant.
   * Each metric is a correlated scalar subquery — a single statement, no N+1.
   */
  private async liveCounts(tenantId: string, period: string): Promise<Record<string, number>> {
    const selects: string[] = [];
    const keys: string[] = [];
    for (const key of USAGE_METRIC_ORDER) {
      const def = USAGE_METRICS[key];
      if (def.kind === 'quota' || !def.source) continue;
      keys.push(key);
      selects.push(`(${this.scalarAggregate(def, '$1', '$2')}) AS "${key}"`);
    }
    if (selects.length === 0) return {};
    const [row] = await this.dataSource.query(`SELECT ${selects.join(', ')}`, [tenantId, period]);
    const out: Record<string, number> = {};
    for (const key of keys) out[key] = n(row?.[key]);
    return out;
  }

  /** Scalar aggregate subquery for a metric's headline number. */
  private scalarAggregate(def: UsageMetricDef, tenantParam: string, periodParam: string): string {
    const s = def.source!;
    const tenantEq = `${s.tenantColumn} = ${tenantParam}${s.tenantIsText ? '::text' : ''}`;
    const where: string[] = [tenantEq];
    if (s.where) where.push(s.where);
    if (s.periodColumn) where.push(`${s.periodColumn} = ${periodParam}`);
    // Activity counts of high-volume, time-stamped tables are scoped to the
    // current billing month so the headline reflects the period (matching quotas).
    else if (s.timeColumn && this.isPeriodScoped(def.key)) {
      where.push(`${s.timeColumn} >= date_trunc('month', now())`);
    }
    return `SELECT ${s.measure} FROM ${s.table} WHERE ${where.join(' AND ')}`;
  }

  /** High-volume activity metrics shown per-period (not lifetime totals). */
  private isPeriodScoped(key: string): boolean {
    return key === 'apiCalls' || key === 'whatsappMessages' || key === 'emails';
  }

  // ───────────────────────────── Drill-down ───────────────────────────────

  /** Per-metric, per-tenant drill-down: authoritative headline + charts (PART 2/6/7). */
  async metricDrilldown(tenantId: string, metric: string, periodMonth?: string) {
    const def = USAGE_METRICS[metric];
    if (!def) throw new AppError(ErrorCode.BAD_REQUEST, { message: `Unknown metric "${metric}"` });
    const period = periodMonth ?? currentPeriodMonth();

    const tenant = await this.dataSource.query(
      `SELECT id, name FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!tenant[0]) throw new AppError(ErrorCode.TENANT_NOT_FOUND);

    // Headline cell reuses the same authoritative path (getUnifiedBreakdown).
    const detail = await this.tenantDetail(tenantId, period);
    const cell = detail.metrics.find((m) => m.key === metric)!;
    const { charts, note } = await this.buildCharts(def, tenantId);

    return {
      scope: 'tenant' as const,
      tenantId,
      tenantName: tenant[0].name,
      metric,
      label: def.label,
      kind: def.kind,
      unit: def.unit,
      periodMonth: period,
      summary: {
        used: cell.used,
        limit: cell.limit,
        remaining: cell.remaining,
        percentUsed: cell.percentUsed,
        exceeded: cell.exceeded,
        unlimited: cell.unlimited,
        blocked: cell.blocked,
        status: cell.status,
      },
      forecast: cell.forecast,
      overage: cell.overage,
      charts,
      note,
    };
  }

  /** Platform-wide (all-tenant) drill-down for a totals card (PART 2/4). */
  async platformMetricDrilldown(metric: string, periodMonth?: string) {
    const def = USAGE_METRICS[metric];
    if (!def) throw new AppError(ErrorCode.BAD_REQUEST, { message: `Unknown metric "${metric}"` });
    const period = periodMonth ?? currentPeriodMonth();

    const summary = await this.platformMetricSummary(def, period);
    const { charts, note } = await this.buildCharts(def, null);

    return {
      scope: 'platform' as const,
      metric,
      label: def.label,
      kind: def.kind,
      unit: def.unit,
      periodMonth: period,
      summary,
      charts,
      note,
    };
  }

  /** Builds the chart bundle for a metric, tenant-scoped (id) or platform-wide (null). */
  private async buildCharts(
    def: UsageMetricDef,
    tenantId: string | null,
  ): Promise<{ charts: UsageCharts; note?: string }> {
    const charts: UsageCharts = {};
    const s = def.source;
    if (!def.drilldown || !s) {
      return { charts, note: 'No time-series data is available for this metric.' };
    }
    if (s.periodColumn) {
      // period_month granularity (e.g. ai_usage_logs) → monthly series only.
      charts.monthly = await this.periodSeries(s, tenantId);
      return { charts };
    }
    if (s.timeColumn) {
      if (def.key === 'apiCalls') charts.hourly = await this.timeSeries(s, tenantId, 'hour', 24);
      charts.daily = await this.timeSeries(s, tenantId, 'day', 30);
      charts.weekly = await this.timeSeries(s, tenantId, 'week', 12);
      charts.monthly = await this.timeSeries(s, tenantId, 'month', 12);
      charts.breakdown = await this.metricBreakdown(def.key, s, tenantId);
    }
    return { charts };
  }

  /** Platform total for a metric: used across all tenants + total finite quota. */
  private async platformMetricSummary(def: UsageMetricDef, period: string) {
    const meteredCol: Record<string, string> = {
      aiTokens: 'ai_tokens_used',
      whatsappMessages: 'whatsapp_messages_used',
      appointments: 'appointments_used',
      campaigns: 'campaigns_used',
    };
    const limitCol = this.planLimitColumnFor(def.key);

    let used = 0;
    if (def.kind === 'quota' && meteredCol[def.key]) {
      const [r] = await this.dataSource.query(
        `SELECT COALESCE(SUM(${meteredCol[def.key]}),0) AS v FROM subscription_usage WHERE period_month = $1`,
        [period],
      );
      used = n(r?.v);
    } else if (def.source) {
      const s = def.source;
      const where: string[] = [];
      if (s.where) where.push(s.where);
      if (this.isPeriodScoped(def.key) && s.timeColumn) where.push(`${s.timeColumn} >= date_trunc('month', now())`);
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [r] = await this.dataSource.query(`SELECT ${s.measure} AS v FROM ${s.table} ${whereSql}`);
      used = n(r?.v);
    }

    let limit: number | null = null;
    if (limitCol) {
      const [r] = await this.dataSource.query(
        `SELECT COALESCE(SUM(pl.${limitCol}),0) AS total, COUNT(*) FILTER (WHERE pl.${limitCol} IS NULL)::int AS unlimited_plans
           FROM subscriptions s JOIN subscription_plans pl ON pl.id = s."planId"
          WHERE s.deleted_at IS NULL AND s.status IN ('ACTIVE','TRIAL')`,
      );
      limit = n(r?.total);
    }
    return {
      used,
      limit,
      remaining: limit === null ? null : Math.max(limit - used, 0),
      percentUsed: limit === null || limit === 0 ? null : +((used / limit) * 100).toFixed(1),
      unlimited: limit === null,
    };
  }

  /** Metric → its `subscription_plans` limit column (metered or count-based). */
  private planLimitColumnFor(metric: string): string | null {
    const metered: Record<string, string> = {
      aiTokens: 'max_ai_tokens',
      whatsappMessages: 'max_whatsapp_messages',
      appointments: 'max_appointments',
      campaigns: 'max_campaigns',
    };
    return metered[metric] ?? (RESOURCE_LIMIT_MAP as Record<string, string>)[metric] ?? null;
  }

  private async timeSeries(
    s: NonNullable<UsageMetricDef['source']>,
    tenantId: string | null,
    unit: 'hour' | 'day' | 'week' | 'month',
    lookback: number,
  ): Promise<{ label: string; value: number }[]> {
    const fmt: Record<typeof unit, string> = {
      hour: 'YYYY-MM-DD HH24:00',
      day: 'YYYY-MM-DD',
      week: 'IYYY-"W"IW',
      month: 'YYYY-MM',
    };
    const unitPlural: Record<typeof unit, string> = { hour: 'hours', day: 'days', week: 'weeks', month: 'months' };
    const where = [`${s.timeColumn} >= now() - interval '${lookback} ${unitPlural[unit]}'`];
    const params: unknown[] = [];
    if (tenantId) {
      params.push(tenantId);
      where.unshift(`${s.tenantColumn} = $1${s.tenantIsText ? '::text' : ''}`);
    }
    if (s.where) where.push(s.where);
    const rows = await this.dataSource.query(
      `SELECT to_char(date_trunc('${unit}', ${s.timeColumn}), '${fmt[unit]}') AS label, ${s.measure} AS value
         FROM ${s.table} WHERE ${where.join(' AND ')}
         GROUP BY 1 ORDER BY 1`,
      params,
    );
    return rows.map((r: Record<string, unknown>) => ({ label: r.label as string, value: n(r.value) }));
  }

  private async periodSeries(
    s: NonNullable<UsageMetricDef['source']>,
    tenantId: string | null,
  ): Promise<{ label: string; value: number }[]> {
    const params: unknown[] = [];
    let whereSql = '';
    if (tenantId) {
      params.push(tenantId);
      whereSql = `WHERE ${s.tenantColumn} = $1${s.tenantIsText ? '::text' : ''}`;
    }
    const rows = await this.dataSource.query(
      `SELECT ${s.periodColumn} AS label, ${s.measure} AS value
         FROM ${s.table} ${whereSql}
         GROUP BY ${s.periodColumn} ORDER BY ${s.periodColumn} DESC LIMIT 12`,
      params,
    );
    return rows.reverse().map((r: Record<string, unknown>) => ({ label: r.label as string, value: n(r.value) }));
  }

  /** Metric-specific top-N breakdown (endpoints / file types / statuses …). */
  private async metricBreakdown(
    metric: string,
    s: NonNullable<UsageMetricDef['source']>,
    tenantId: string | null,
  ): Promise<{ label: string; value: number }[] | undefined> {
    const spec: Record<string, { expr: string; measure?: string }> = {
      apiCalls: { expr: 'status_code' },
      storageBytes: { expr: 'file_type', measure: 'COALESCE(SUM(file_size),0)' },
      uploadedFiles: { expr: 'file_type', measure: 'COALESCE(SUM(file_size),0)' },
      payments: { expr: 'status' },
      appointments: { expr: 'status' },
      emails: { expr: 'status' },
      transactions: { expr: 'status' },
      invoices: { expr: 'status' },
    };
    const b = spec[metric];
    if (!b) return undefined;
    const measure = b.measure ?? 'COUNT(*)';
    const where: string[] = [];
    const params: unknown[] = [];
    if (tenantId) {
      params.push(tenantId);
      where.push(`${s.tenantColumn} = $1${s.tenantIsText ? '::text' : ''}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.dataSource.query(
      `SELECT COALESCE(${b.expr}::text, '—') AS label, ${measure} AS value
         FROM ${s.table} ${whereSql}
         GROUP BY ${b.expr} ORDER BY value DESC LIMIT 10`,
      params,
    );
    return rows.map((r: Record<string, unknown>) => ({ label: r.label as string, value: n(r.value) }));
  }

  // ───────────────────────────── Export ───────────────────────────────────

  /** CSV or SpreadsheetML export of the tenant usage overview (PART 1/13). */
  async export(q: QueryTenantUsageDto): Promise<{ filename: string; content: string; mimeType: string }> {
    const { data } = await this.listTenants({ ...q, page: 1, limit: 5000 });
    const headers = [
      'Clinic', 'Slug', 'Plan', 'Subscription Status', 'Effective Status',
      'Trial', 'Enforced', 'Period', 'Renewal Date', 'Last Activity',
      'Utilization %', 'Over Limit',
    ];
    const rows = data.map((r) => [
      r.tenantName, r.slug, r.planName ?? '', r.subscriptionStatus ?? '', r.effectiveStatus,
      r.isTrial ? 'Yes' : 'No', r.enforced ? 'Yes' : 'No', r.currentPeriod,
      r.renewalDate ?? '', r.lastActivity ?? '', String(r.utilizationPercent), r.overLimit ? 'Yes' : 'No',
    ]);
    const date = new Date().toISOString().slice(0, 10);

    if (q.format === 'excel') {
      return {
        filename: `platform-usage-${date}.xls`,
        content: this.toSpreadsheetMl(headers, rows),
        mimeType: 'application/vnd.ms-excel',
      };
    }
    return {
      filename: `platform-usage-${date}.csv`,
      content: this.toCsv(headers, rows),
      mimeType: 'text/csv;charset=utf-8;',
    };
  }

  private toCsv(headers: string[], rows: string[][]): string {
    // SEC-05: neutralise spreadsheet formulas before CSV quoting.
    const esc = (raw: string): string => {
      const v = escapeSpreadsheetCell(raw);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    return [headers.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  }

  /** Minimal SpreadsheetML 2003 — a genuine .xls Excel opens natively, no dep. */
  private toSpreadsheetMl(headers: string[], rows: string[][]): string {
    const esc = (v: string): string =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cell = (v: string) => `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
    const row = (cells: string[]) => `<Row>${cells.map(cell).join('')}</Row>`;
    return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Platform Usage">
  <Table>
   ${row(headers)}
   ${rows.map(row).join('\n   ')}
  </Table>
 </Worksheet>
</Workbook>`;
  }
}
