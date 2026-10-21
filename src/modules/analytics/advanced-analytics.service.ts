import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppError, ErrorCode } from '../../common/errors';
import { PERMISSION } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsCacheService, CACHE_NS } from './analytics-cache.service';
import {
  DEFAULT_REPORTING_TIMEZONE,
  MAX_ADVANCED_ANALYTICS_RANGE_DAYS,
  dayRangeInZone,
  enumerateDays,
  inclusiveDayCount,
  priorPeriod,
  roundRatio,
  type ReportDate,
} from './analytics.constants';
import { QueryAdvancedAnalyticsDto } from './dto/query-advanced-analytics.dto';
import { QueryAdvancedAnalyticsPageDto } from './dto/query-advanced-analytics-page.dto';

/** `{ range, scope, currency, timezone, generatedAt }` — carried on EVERY F11 payload (FR-A015/FR-A021). */
export interface AdvancedAnalyticsEnvelope {
  range: { from: string; to: string };
  scope: { branchId: string | 'ALL' };
  currency: string;
  /** IANA zone whose calendar days `range.from`/`range.to` and every bucket are in. */
  timezone: string;
  generatedAt: string;
}

export interface ResolvedScope {
  /** `undefined` only for a tenant-wide caller who requested no branch filter. */
  branchId?: string;
}

/**
 * Spec 014 (Clinic Platform Completion) — T145 (US11, F11). Orchestrates the
 * 9 advanced-analytics routes on top of {@link AnalyticsAggregationService}
 * (the ONLY place the actual aggregation SQL lives — nothing here duplicates
 * a count/sum AnalyticsAggregationService already knows how to do). This
 * service owns three things the aggregation engine does not:
 *
 *  1. Branch-scope RESOLUTION (FR-A016) — a caller holding only
 *     `analytics.reports.read` (not the tenant-wide `analytics.dashboard.read`)
 *     is forced onto their own branch via `branch_users` membership, mirroring
 *     the FND-017 ABAC discipline `BranchService` already uses for
 *     `branches.update_own` — a branch id is NEVER trusted from the request
 *     for such a caller.
 *  2. The response ENVELOPE (`range`/`scope`/`currency`/`generatedAt`,
 *     FR-A015/FR-A021) and the EMPTY-vs-zero distinction (FR-A020).
 *  3. Deriving prior-period bounds for retention (FR-A007) and turning raw
 *     counts into rates/percentages.
 */
@Injectable()
export class AdvancedAnalyticsService {
  constructor(
    private readonly aggregation: AnalyticsAggregationService,
    private readonly branchScope: BranchScopeService,
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    private readonly cache: AnalyticsCacheService,
  ) {}

  // ─────────────────────────── Shared plumbing ───────────────────────────── //

  /**
   * Made non-private for the Patient Journey plan (approved 2026-09-16), the
   * same way T181 widened {@link resolveScope} — `PatientJourneyService`
   * reuses this EXACT range validation (the `from`/`to` ordering check and
   * the {@link MAX_ADVANCED_ANALYTICS_RANGE_DAYS} bound) rather than a
   * second implementation.
   */
  validateRange(dto: QueryAdvancedAnalyticsDto): {
    from: ReportDate;
    to: ReportDate;
  } {
    const { from, to } = dto;
    if (from > to) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: '`from` must not be after `to`',
      });
    }
    const days = inclusiveDayCount(from, to);
    if (days > MAX_ADVANCED_ANALYTICS_RANGE_DAYS) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Range too wide: ${days} days (max ${MAX_ADVANCED_ANALYTICS_RANGE_DAYS})`,
      });
    }
    return { from, to };
  }

  /**
   * FR-A016 — a caller with the tenant-wide `analytics.dashboard.read`
   * permission may view any branch (or all of them); anyone else is forced
   * onto their OWN branch membership (`branch_users`), never a request-
   * supplied branch id. A branch-restricted caller with more than one
   * assigned branch and no explicit `branchId` defaults to the first
   * (deterministic, id-ordered) one rather than silently mixing branches —
   * the exact defect this phase exists to remove from the trend endpoints.
   */
  /**
   * Made non-private by T181 (spec 014, US13) so `ReportExportService` can
   * reuse the SAME branch-scope resolution when capturing an export
   * request's `branch_scope` at request time — no second implementation of
   * "which branch(es) can this caller see" exists anywhere else.
   */
  async resolveScope(
    tenantId: string,
    user: AuthenticatedUser,
    requestedBranchId?: string,
  ): Promise<ResolvedScope> {
    const isTenantWide = user.permissions.includes(
      PERMISSION.ANALYTICS_DASHBOARD_READ,
    );

    if (isTenantWide) {
      if (requestedBranchId) {
        await this.aggregation.assertBranch(tenantId, requestedBranchId);
        return { branchId: requestedBranchId };
      }
      return {};
    }

    // Membership comes from the shared `BranchScopeService` — the one
    // `branch_users` lookup in the codebase — rather than a repository query
    // owned here. Its result is already deterministic (id-ordered), which is
    // what lets a branch-restricted caller with several assigned branches and
    // no explicit `branchId` always default to the SAME branch, and it is
    // Redis-cached, which this call site previously was not.
    //
    // Deliberately still keyed on `analytics.dashboard.read` above rather
    // than `BranchScopeService.resolve`'s RBAC predicate: FR-A016 defines
    // tenant-wide analytics by THAT slug, and switching rules here would
    // change who sees clinic-wide figures.
    const ownBranchIds = await this.branchScope.getMembershipBranchIds(
      tenantId,
      user.id,
    );

    if (ownBranchIds.length === 0) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, {
        message: 'No branch is assigned to this account',
      });
    }
    if (requestedBranchId) {
      if (!ownBranchIds.includes(requestedBranchId)) {
        throw new AppError(ErrorCode.PERMISSION_DENIED, {
          message: 'You can only view analytics for your own branch',
        });
      }
      return { branchId: requestedBranchId };
    }
    return { branchId: ownBranchIds[0] };
  }

  /**
   * FR-A016 for single-record reads (`GET /analytics/reports/{daily,monthly}/:id`):
   * a branch-restricted caller may only open a report of a branch they belong
   * to. Anything else is NOT_FOUND, so the response never confirms that
   * another branch's report exists.
   */
  async assertBranchVisible(
    tenantId: string,
    user: AuthenticatedUser,
    branchId: string | undefined,
  ): Promise<void> {
    if (user.permissions.includes(PERMISSION.ANALYTICS_DASHBOARD_READ)) return;
    const ownBranchIds = await this.branchScope.getMembershipBranchIds(
      tenantId,
      user.id,
    );
    if (!branchId || !ownBranchIds.includes(branchId)) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Report not found' });
    }
  }

  /** The analytics reporting currency — see `AnalyticsAggregationService.resolveReportingCurrency`. */
  private async getCurrency(tenantId: string): Promise<string> {
    return (await this.aggregation.resolveReportingCurrency(tenantId)).currency;
  }

  /**
   * `GET /analytics/currency` — which currency the page's money is in (and
   * why), plus the timezone whose calendar days its dates are.
   */
  async reportingCurrency(tenantId: string) {
    const [currency, timezone] = await Promise.all([
      this.cache.wrap(tenantId, CACHE_NS.DASHBOARD, 'reporting-currency', () =>
        this.aggregation.resolveReportingCurrency(tenantId),
      ),
      this.reportingTimezone(tenantId),
    ]);
    return { ...currency, timezone };
  }

  /**
   * The clinic's reporting timezone — whose calendar days every range and
   * bucket on the page are — see `AnalyticsAggregationService.resolveReportingTimezone`.
   */
  reportingTimezone(tenantId: string): Promise<string> {
    return this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      'reporting-timezone',
      () => this.aggregation.resolveReportingTimezone(tenantId),
    );
  }

  /**
   * Made non-private for the Patient Journey plan (approved 2026-09-16) —
   * `PatientJourneyService` builds the SAME `{range, scope, currency,
   * generatedAt}` envelope shape (FR-A015/FR-A021) rather than a second one.
   */
  envelope(
    from: ReportDate,
    to: ReportDate,
    branchId: string | undefined,
    currency: string,
    timezone: string = DEFAULT_REPORTING_TIMEZONE,
  ): AdvancedAnalyticsEnvelope {
    return {
      range: { from, to },
      scope: { branchId: branchId ?? 'ALL' },
      currency,
      timezone,
      generatedAt: new Date().toISOString(),
    };
  }

  /** `[from 00:00, to 23:59:59.999]` in the clinic's reporting timezone. */
  private async instants(
    tenantId: string,
    from: ReportDate,
    to: ReportDate,
  ): Promise<{ start: Date; end: Date; tz: string }> {
    const tz = await this.reportingTimezone(tenantId);
    return {
      start: dayRangeInZone(from, tz).start,
      end: dayRangeInZone(to, tz).end,
      tz,
    };
  }

  /**
   * Cache suffix for a trend payload.
   *
   * Keyed on the RESOLVED branch scope, not the requested one: two callers who
   * asked for different things but were authorized down to the same branch
   * share an entry, and a branch-restricted caller can never read the
   * tenant-wide (`ALL`) entry. Tenant isolation is handled one level up — the
   * tenant id is baked into every key by `AnalyticsCacheService` itself.
   *
   * Namespace is `dashboard`, the same one the KPI snapshot and target
   * progress already use, so the existing `POST /analytics/dashboard/refresh`
   * invalidation clears these too rather than leaving a second, separately
   * stale surface behind.
   *
   * NOTE ON `generatedAt`: the whole payload is cached, envelope included, so
   * a cache hit reports when the aggregation actually ran rather than when the
   * request arrived. That is the honest value — a client displaying it is
   * being told the age of the numbers it is looking at.
   */
  private trendKey(
    kind: 'appointments' | 'revenue',
    from: ReportDate,
    to: ReportDate,
    branchId: string | undefined,
  ): string {
    return `trend:${kind}:${from}:${to}:${branchId ?? 'ALL'}`;
  }

  /**
   * Same shape as {@link trendKey} for the five non-trend aggregates
   * (CACHE-002). Deliberately excludes `page`/`limit`: every paginated
   * method here slices an already-fetched, unpaginated row set in memory
   * (see `AnalyticsAggregationService.servicePerformance` etc. — no `LIMIT`/
   * `OFFSET` in the SQL), so the expensive part — the aggregation query
   * itself — is identical across pages of the same (kind, range, branch) and
   * a page-2 request reuses page-1's cache entry instead of re-querying.
   */
  private aggregateKey(
    kind:
      | 'rates'
      | 'retention'
      | 'perf-services'
      | 'perf-branches'
      | 'perf-channels',
    from: ReportDate,
    to: ReportDate,
    branchId: string | undefined,
  ): string {
    return `${kind}:${from}:${to}:${branchId ?? 'ALL'}`;
  }

  // ─────────────────────────────── Trends ────────────────────────────────── //

  /** FR-A004 — `GET /analytics/trends/appointments`. */
  async appointmentsTrend(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsDto,
  ) {
    const { from, to } = this.validateRange(dto);
    // Resolved BEFORE the cache is consulted: the branch a caller may see is
    // an authorization decision and must never be read from a cached payload.
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    return this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      this.trendKey('appointments', from, to, scope.branchId),
      async () => {
        const currency = await this.getCurrency(tenantId);
        const { start, end, tz } = await this.instants(tenantId, from, to);
        const rows = await this.aggregation.appointmentsTrend(
          tenantId,
          scope.branchId,
          start,
          end,
          tz,
        );
        const envelope = this.envelope(from, to, scope.branchId, currency, tz);

        const totalAcrossRange = rows.reduce((s, r) => s + r.total, 0);
        if (totalAcrossRange === 0) {
          return { ...envelope, empty: true, data: [] };
        }

        const byDate = new Map(rows.map((r) => [r.date, r]));
        const data = enumerateDays(from, to).map((date) => {
          const r = byDate.get(date);
          return {
            date,
            total: r?.total ?? 0,
            completed: r?.completed ?? 0,
            cancelled: r?.cancelled ?? 0,
            noShow: r?.no_show ?? 0,
          };
        });
        return { ...envelope, empty: false, data };
      },
    );
  }

  /** FR-A003 — `GET /analytics/trends/revenue`. */
  async revenueTrend(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    return this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      this.trendKey('revenue', from, to, scope.branchId),
      async () => {
        const currency = await this.getCurrency(tenantId);
        const { start, end, tz } = await this.instants(tenantId, from, to);

        const [rows, other] = await Promise.all([
          this.aggregation.revenueTrend(
            tenantId,
            scope.branchId,
            currency,
            start,
            end,
            tz,
          ),
          this.aggregation.countOtherCurrencyRevenue(
            tenantId,
            scope.branchId,
            currency,
            start,
            end,
          ),
        ]);
        const envelope = this.envelope(from, to, scope.branchId, currency, tz);

        const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
        if (totalRevenue === 0 && other.count === 0) {
          return { ...envelope, empty: true, data: [] };
        }

        const byDate = new Map(rows.map((r) => [r.date, r]));
        const data = enumerateDays(from, to).map((date) => ({
          date,
          revenue: byDate.get(date)?.revenue ?? 0,
        }));

        return {
          ...envelope,
          empty: false,
          data,
          // FR-A021 — never silently summed away; surfaced only when non-zero.
          ...(other.count > 0
            ? {
                excludedOtherCurrency: {
                  count: other.count,
                  amount: other.amount,
                },
              }
            : {}),
        };
      },
    );
  }

  // ──────────────────────────────── Rates ────────────────────────────────── //

  /** FR-A005/FR-A006 — `GET /analytics/rates`. */
  async rates(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsDto,
  ) {
    const { from, to } = this.validateRange(dto);
    // Resolved BEFORE the cache is consulted — same authorization discipline
    // as the trend methods above (an authorization decision must never be
    // cached).
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    return this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      this.aggregateKey('rates', from, to, scope.branchId),
      async () => {
        const currency = await this.getCurrency(tenantId);
        const { start, end, tz } = await this.instants(tenantId, from, to);
        const raw = await this.aggregation.computeRates(
          tenantId,
          scope.branchId,
          start,
          end,
        );
        const envelope = this.envelope(from, to, scope.branchId, currency, tz);

        if (raw.total === 0) {
          return { ...envelope, empty: true };
        }

        return {
          ...envelope,
          empty: false,
          cancellationRate: roundRatio(raw.cancelled / raw.total),
          cancellationByPatient: raw.cancelledByPatient,
          cancellationByClinic: raw.cancelledByClinic,
          // Cancelled bookings with no AppointmentCancellation row (who
          // cancelled is unknown) — reported so the split visibly adds up.
          cancellationUnattributed: Math.max(
            raw.cancelled - raw.cancelledByPatient - raw.cancelledByClinic,
            0,
          ),
          noShowRate: roundRatio(raw.no_show / raw.total),
          completionRate: roundRatio(raw.completed / raw.total),
          // The denominator, and how much of it has no outcome yet (upcoming,
          // pending payment, confirmed, in progress, rescheduled) — the rates
          // plus `openAppointments / totalAppointments` sum to 100%.
          totalAppointments: raw.total,
          openAppointments:
            raw.total - raw.completed - raw.cancelled - raw.no_show,
        };
      },
    );
  }

  // ─────────────────────────────── Retention ─────────────────────────────── //

  /** FR-A007/FR-A008 — `GET /analytics/retention`. */
  async retention(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    return this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      this.aggregateKey('retention', from, to, scope.branchId),
      async () => {
        const currency = await this.getCurrency(tenantId);
        const { priorFrom, priorTo } = priorPeriod(from, to);
        const {
          start: chosenStart,
          end: chosenEnd,
          tz,
        } = await this.instants(tenantId, from, to);
        const { start: priorStart, end: priorEnd } = await this.instants(
          tenantId,
          priorFrom,
          priorTo,
        );

        const raw = await this.aggregation.computeRetention(
          tenantId,
          scope.branchId,
          priorStart,
          priorEnd,
          chosenStart,
          chosenEnd,
        );
        const envelope = this.envelope(from, to, scope.branchId, currency, tz);

        if (raw.priorPeriodPatients === 0) {
          return { ...envelope, empty: true };
        }

        return {
          ...envelope,
          empty: false,
          retainedPatients: raw.retainedPatients,
          priorPeriodPatients: raw.priorPeriodPatients,
          retentionRate: roundRatio(
            raw.retainedPatients / raw.priorPeriodPatients,
          ),
          repeatDistribution: raw.repeatDistribution,
        };
      },
    );
  }

  // ────────────────────────────── Performance ─────────────────────────────── //

  /** FR-A009 — `GET /analytics/performance/services`. */
  async performanceServices(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsPageDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    // Only the aggregation is cached — `page`/`limit` are applied AFTER, on
    // the full (already-fetched) row set, so every page of the same range/
    // branch shares one cache entry instead of the query running per page.
    const { envelope, rows } = await this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      this.aggregateKey('perf-services', from, to, scope.branchId),
      async () => {
        const currency = await this.getCurrency(tenantId);
        const { start, end, tz } = await this.instants(tenantId, from, to);
        const rows = await this.aggregation.servicePerformance(
          tenantId,
          scope.branchId,
          start,
          end,
        );
        return {
          envelope: this.envelope(from, to, scope.branchId, currency, tz),
          rows,
        };
      },
    );

    if (rows.length === 0) {
      return {
        ...envelope,
        empty: true,
        data: [],
        total: 0,
        page: dto.page,
        limit: dto.limit,
      };
    }

    const offset = (dto.page - 1) * dto.limit;
    return {
      ...envelope,
      empty: false,
      data: rows.slice(offset, offset + dto.limit),
      total: rows.length,
      page: dto.page,
      limit: dto.limit,
    };
  }

  /** FR-A010 — `GET /analytics/performance/staff`. */
  async performanceStaff(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsPageDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);
    const currency = await this.getCurrency(tenantId);
    const tz = await this.reportingTimezone(tenantId);
    const rows = await this.aggregation.computeStaffPerformance(tenantId, {
      branchId: scope.branchId,
      from,
      to,
    });
    const envelope = this.envelope(from, to, scope.branchId, currency, tz);

    if (rows.length === 0) {
      return {
        ...envelope,
        empty: true,
        data: [],
        total: 0,
        page: dto.page,
        limit: dto.limit,
      };
    }

    const offset = (dto.page - 1) * dto.limit;
    const data = rows.slice(offset, offset + dto.limit).map((r) => ({
      staffId: r.staffId,
      name: r.name,
      appointments: r.total_appointments,
      completedAppointments: r.completed_appointments,
      revenue: r.revenue,
      avgRating: r.avg_rating,
      noShowRate:
        r.total_appointments > 0
          ? roundRatio(r.no_show_appointments / r.total_appointments)
          : null,
    }));

    return {
      ...envelope,
      empty: false,
      data,
      total: rows.length,
      page: dto.page,
      limit: dto.limit,
    };
  }

  /** FR-A011 — `GET /analytics/performance/branches`. */
  async performanceBranches(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsPageDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    const { envelope, excluded, rows, anyActivity } = await this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      this.aggregateKey('perf-branches', from, to, scope.branchId),
      async () => {
        const currency = await this.getCurrency(tenantId);
        const { start, end, tz } = await this.instants(tenantId, from, to);
        const branchIds = scope.branchId ? [scope.branchId] : undefined;
        const [rows, other, unattributedRevenue] = await Promise.all([
          this.aggregation.branchPerformance(
            tenantId,
            branchIds,
            currency,
            start,
            end,
          ),
          this.aggregation.countOtherCurrencyRevenue(
            tenantId,
            scope.branchId,
            currency,
            start,
            end,
          ),
          // Only meaningful clinic-wide: a branch-pinned view never owns
          // revenue that belongs to no branch.
          scope.branchId
            ? Promise.resolve(0)
            : this.aggregation.unattributedRevenue(
                tenantId,
                'branch',
                undefined,
                currency,
                start,
                end,
              ),
        ]);
        const envelope = {
          ...this.envelope(from, to, scope.branchId, currency, tz),
          unattributedRevenue,
        };
        // FR-A021 — never silently summed away; surfaced only when non-zero.
        const excluded =
          other.count > 0
            ? {
                excludedOtherCurrency: {
                  count: other.count,
                  amount: other.amount,
                },
              }
            : {};
        const anyActivity =
          unattributedRevenue > 0 ||
          rows.some((r) => r.appointments > 0 || r.revenue > 0);
        return { envelope, excluded, rows, anyActivity };
      },
    );

    if (rows.length === 0 || !anyActivity) {
      return {
        ...envelope,
        ...excluded,
        empty: true,
        data: [],
        total: 0,
        page: dto.page,
        limit: dto.limit,
      };
    }

    const offset = (dto.page - 1) * dto.limit;
    return {
      ...envelope,
      ...excluded,
      empty: false,
      data: rows.slice(offset, offset + dto.limit),
      total: rows.length,
      page: dto.page,
      limit: dto.limit,
    };
  }

  /** FR-A012 — `GET /analytics/performance/channels`. */
  async performanceChannels(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsPageDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    const { envelope, excluded, data, anyActivity } = await this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      this.aggregateKey('perf-channels', from, to, scope.branchId),
      async () => {
        const currency = await this.getCurrency(tenantId);
        const { start, end, tz } = await this.instants(tenantId, from, to);
        const [rows, other, unattributedRevenue] = await Promise.all([
          this.aggregation.channelPerformance(
            tenantId,
            scope.branchId,
            currency,
            start,
            end,
          ),
          this.aggregation.countOtherCurrencyRevenue(
            tenantId,
            scope.branchId,
            currency,
            start,
            end,
          ),
          this.aggregation.unattributedRevenue(
            tenantId,
            'channel',
            scope.branchId,
            currency,
            start,
            end,
          ),
        ]);
        const envelope = {
          ...this.envelope(from, to, scope.branchId, currency, tz),
          unattributedRevenue,
        };
        // FR-A021 — never silently summed away; surfaced only when non-zero.
        const excluded =
          other.count > 0
            ? {
                excludedOtherCurrency: {
                  count: other.count,
                  amount: other.amount,
                },
              }
            : {};
        const totalAppointments = rows.reduce((s, r) => s + r.appointments, 0);
        const data = rows.map((r) => ({
          source: r.source,
          appointments: r.appointments,
          completionRate:
            r.appointments > 0
              ? roundRatio(r.completed / r.appointments)
              : null,
          revenue: r.revenue,
        }));
        // Revenue is bucketed by `paid_at`, appointments by `start_at`: a
        // range can hold payments for bookings that start elsewhere, so a
        // zero appointment count alone must not hide that revenue.
        const anyActivity =
          totalAppointments > 0 ||
          unattributedRevenue > 0 ||
          data.some((r) => r.revenue > 0);
        return { envelope, excluded, data, anyActivity };
      },
    );

    if (!anyActivity) {
      return {
        ...envelope,
        ...excluded,
        empty: true,
        data: [],
        total: 0,
        page: dto.page,
        limit: dto.limit,
      };
    }

    const offset = (dto.page - 1) * dto.limit;
    return {
      ...envelope,
      ...excluded,
      empty: false,
      data: data.slice(offset, offset + dto.limit),
      total: data.length,
      page: dto.page,
      limit: dto.limit,
    };
  }
}
