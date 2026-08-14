import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { TenantApprovalStatus } from '../../entities/enums';
import {
  DASHBOARD_SUBSCRIPTION_STATE,
  DASHBOARD_SUBSCRIPTION_STATES,
  DASHBOARD_TIMEZONE,
  LATEST_SUBSCRIPTION_LATERAL,
  effectiveStatusSql,
  type DashboardSubscriptionState,
} from './dashboard.constants';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export interface TenantStateCounts {
  total: number;
  approved: number;
  pendingVerification: number;
  pendingApproval: number;
  suspended: number;
  rejected: number;
  /** Approved AND operationally enabled AND holding a usable subscription. */
  active: number;
}

export type SubscriptionStateCounts = Record<DashboardSubscriptionState, number>;

export interface DashboardSnapshot {
  tenants: TenantStateCounts;
  subscriptions: SubscriptionStateCounts;
  timezone: typeof DASHBOARD_TIMEZONE;
  collectedAt: string;
}

/**
 * Platform Control Center aggregator (super-admin).
 *
 * Read-only, cross-tenant, and deliberately THIN: money comes from
 * `MarketplaceFinanceService`, quota/usage state from `PlatformUsageService`,
 * infrastructure from `MonitoringService`, tickets from `SupportTicketService`.
 * This service owns exactly one thing those cannot express — the platform-wide
 * lifecycle counts — plus the composition that lets the landing page load in a
 * handful of requests instead of a dozen.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. **No unbounded scan.** Every predicate lands on an index created by
 *     `17300400000000-PlatformDashboardIndexes`. Nothing here may become the
 *     reason the console's front door is slow.
 *  2. **No time boundary in SQL.** Windows are computed in JS as UTC and bound
 *     as parameters (see `DASHBOARD_TIMEZONE` for why).
 */
@Injectable()
export class PlatformDashboardService {
  private readonly logger = new Logger(PlatformDashboardService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** Grace window, from config — never hardcoded (mirrors `SubscriptionService`). */
  private graceDays(): number {
    return this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
  }

  // ─────────────────────────────── Snapshot ─────────────────────────────── //

  /**
   * Point-in-time platform state. Takes NO range — see `QueryDashboardRangeDto`
   * for why that is a structural guarantee rather than a convention.
   */
  async snapshot(): Promise<DashboardSnapshot> {
    // Two independent aggregates over different tables — neither consumes the
    // other's result, so they run concurrently rather than as two sequential
    // round-trips (the same reasoning `MarketplaceFinanceService.kpis()` and
    // `MonitoringService.overview()` already apply).
    const [tenants, subscriptions] = await Promise.all([
      this.tenantStateCounts(),
      this.subscriptionStateCounts(),
    ]);

    return {
      tenants,
      subscriptions,
      timezone: DASHBOARD_TIMEZONE,
      collectedAt: new Date().toISOString(),
    };
  }

  // ────────────────────────── Tenant lifecycle ──────────────────────────── //

  /**
   * Exact counts per approval state, from ONE grouped query.
   *
   * This replaces the page's previous approach of pulling 100 tenant rows and
   * counting them in the browser — which was not merely inefficient but wrong:
   * `ListTenantsQueryDto` caps `limit` at 100, so past 100 clinics the browser
   * was counting a page and presenting it as a platform total.
   *
   * The four states stay separate (see `TENANT_STATES`). `active` mirrors
   * `ActiveTenantGuard`'s own admission test — `approval_status = APPROVED AND
   * is_active` — plus a usable subscription, so the tile means "clinics that can
   * actually operate right now" rather than "clinics we once approved".
   * `is_active` is written only by `TenantService.transition()`, in the same
   * transaction as the status, so the pair is always coherent; naming both here
   * is a faithful mirror of the guard, not a redundant belt.
   */
  private async tenantStateCounts(): Promise<TenantStateCounts> {
    const grace = '$1';
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
             AND (${effectiveStatusSql('sub', grace)}) IN (${usable})
         )::int AS active
       FROM tenants t
       ${LATEST_SUBSCRIPTION_LATERAL}
       WHERE t.deleted_at IS NULL`,
      [this.graceDays()],
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
  private async subscriptionStateCounts(): Promise<SubscriptionStateCounts> {
    const rows: { state: string; count: string }[] = await this.dataSource.query(
      `SELECT state, COUNT(*)::int AS count
         FROM (
           SELECT (${effectiveStatusSql('sub', '$1')}) AS state
             FROM tenants t
             ${LATEST_SUBSCRIPTION_LATERAL}
            WHERE t.deleted_at IS NULL
         ) s
        GROUP BY state`,
      [this.graceDays()],
    );

    // Seed every state at zero so the response shape is stable — a dashboard
    // that omits "GRACE_EXPIRED" when it happens to be empty forces the client
    // to guess whether the number is zero or the field is gone.
    const counts = Object.fromEntries(
      DASHBOARD_SUBSCRIPTION_STATES.map((s) => [s, 0]),
    ) as SubscriptionStateCounts;

    for (const r of rows) {
      if (r.state in counts) {
        counts[r.state as DashboardSubscriptionState] = n(r.count);
      } else {
        // A status reaching here means the enum grew without this file. Log it
        // rather than silently dropping tenants out of the distribution.
        this.logger.warn(
          `Unmapped subscription state "${r.state}" (${n(r.count)} tenants) — add it to DASHBOARD_SUBSCRIPTION_STATE`,
        );
      }
    }
    return counts;
  }
}
