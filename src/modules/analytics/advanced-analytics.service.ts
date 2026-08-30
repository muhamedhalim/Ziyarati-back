import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppError, ErrorCode } from '../../common/errors';
import { PERMISSION } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import {
  MAX_ADVANCED_ANALYTICS_RANGE_DAYS,
  dayRangeUtc,
  enumerateDays,
  inclusiveDayCount,
  priorPeriod,
  round2,
  type ReportDate,
} from './analytics.constants';
import { QueryAdvancedAnalyticsDto } from './dto/query-advanced-analytics.dto';
import { QueryAdvancedAnalyticsPageDto } from './dto/query-advanced-analytics-page.dto';

/** `{ range, scope, currency, generatedAt }` — carried on EVERY F11 payload (FR-A015/FR-A021). */
export interface AdvancedAnalyticsEnvelope {
  range: { from: string; to: string };
  scope: { branchId: string | 'ALL' };
  currency: string;
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
    @InjectRepository(BranchUser)
    private readonly branchUsers: Repository<BranchUser>,
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
  ) {}

  // ─────────────────────────── Shared plumbing ───────────────────────────── //

  private validateRange(dto: QueryAdvancedAnalyticsDto): {
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

    const ownRows = await this.branchUsers.find({
      where: { tenant: { id: tenantId }, user: { id: user.id } },
      relations: { branch: true },
    });
    // Deterministic (id-ordered) — a branch-restricted caller with several
    // assigned branches and no explicit `branchId` must always default to
    // the SAME branch, never an order that varies per request.
    const ownBranchIds = ownRows.map((r) => r.branch.id).sort();

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

  private async getCurrency(tenantId: string): Promise<string> {
    const settings = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    return settings?.currency ?? 'USD';
  }

  private envelope(
    from: ReportDate,
    to: ReportDate,
    branchId: string | undefined,
    currency: string,
  ): AdvancedAnalyticsEnvelope {
    return {
      range: { from, to },
      scope: { branchId: branchId ?? 'ALL' },
      currency,
      generatedAt: new Date().toISOString(),
    };
  }

  private instants(
    from: ReportDate,
    to: ReportDate,
  ): { start: Date; end: Date } {
    return { start: dayRangeUtc(from).start, end: dayRangeUtc(to).end };
  }

  // ─────────────────────────────── Trends ────────────────────────────────── //

  /** FR-A004 — `GET /analytics/trends/appointments`. */
  async appointmentsTrend(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);
    const [currency, { start, end }] = [
      await this.getCurrency(tenantId),
      this.instants(from, to),
    ];
    const rows = await this.aggregation.appointmentsTrend(
      tenantId,
      scope.branchId,
      start,
      end,
    );
    const envelope = this.envelope(from, to, scope.branchId, currency);

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
  }

  /** FR-A003 — `GET /analytics/trends/revenue`. */
  async revenueTrend(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);
    const currency = await this.getCurrency(tenantId);
    const { start, end } = this.instants(from, to);

    const [rows, other] = await Promise.all([
      this.aggregation.revenueTrend(
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
    ]);
    const envelope = this.envelope(from, to, scope.branchId, currency);

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
            excludedOtherCurrency: { count: other.count, amount: other.amount },
          }
        : {}),
    };
  }

  // ──────────────────────────────── Rates ────────────────────────────────── //

  /** FR-A005/FR-A006 — `GET /analytics/rates`. */
  async rates(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);
    const currency = await this.getCurrency(tenantId);
    const { start, end } = this.instants(from, to);
    const raw = await this.aggregation.computeRates(
      tenantId,
      scope.branchId,
      start,
      end,
    );
    const envelope = this.envelope(from, to, scope.branchId, currency);

    if (raw.total === 0) {
      return { ...envelope, empty: true };
    }

    return {
      ...envelope,
      empty: false,
      cancellationRate: round2(raw.cancelled / raw.total),
      cancellationByPatient: raw.cancelledByPatient,
      cancellationByClinic: raw.cancelledByClinic,
      noShowRate: round2(raw.no_show / raw.total),
      completionRate: round2(raw.completed / raw.total),
    };
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
    const currency = await this.getCurrency(tenantId);
    const { priorFrom, priorTo } = priorPeriod(from, to);
    const { start: chosenStart, end: chosenEnd } = this.instants(from, to);
    const { start: priorStart, end: priorEnd } = this.instants(
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
    const envelope = this.envelope(from, to, scope.branchId, currency);

    if (raw.priorPeriodPatients === 0) {
      return { ...envelope, empty: true };
    }

    return {
      ...envelope,
      empty: false,
      retainedPatients: raw.retainedPatients,
      priorPeriodPatients: raw.priorPeriodPatients,
      retentionRate: round2(raw.retainedPatients / raw.priorPeriodPatients),
      repeatDistribution: raw.repeatDistribution,
    };
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
    const currency = await this.getCurrency(tenantId);
    const { start, end } = this.instants(from, to);
    const rows = await this.aggregation.servicePerformance(
      tenantId,
      scope.branchId,
      start,
      end,
    );
    const envelope = this.envelope(from, to, scope.branchId, currency);

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
    const rows = await this.aggregation.computeStaffPerformance(tenantId, {
      branchId: scope.branchId,
      from,
      to,
    });
    const envelope = this.envelope(from, to, scope.branchId, currency);

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
          ? round2(r.no_show_appointments / r.total_appointments)
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
    const currency = await this.getCurrency(tenantId);
    const { start, end } = this.instants(from, to);
    const branchIds = scope.branchId ? [scope.branchId] : undefined;
    const rows = await this.aggregation.branchPerformance(
      tenantId,
      branchIds,
      start,
      end,
    );
    const envelope = this.envelope(from, to, scope.branchId, currency);

    const anyActivity = rows.some((r) => r.appointments > 0 || r.revenue > 0);
    if (rows.length === 0 || !anyActivity) {
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

  /** FR-A012 — `GET /analytics/performance/channels`. */
  async performanceChannels(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryAdvancedAnalyticsPageDto,
  ) {
    const { from, to } = this.validateRange(dto);
    const scope = await this.resolveScope(tenantId, user, dto.branchId);
    const currency = await this.getCurrency(tenantId);
    const { start, end } = this.instants(from, to);
    const rows = await this.aggregation.channelPerformance(
      tenantId,
      scope.branchId,
      start,
      end,
    );
    const envelope = this.envelope(from, to, scope.branchId, currency);

    const totalAppointments = rows.reduce((s, r) => s + r.appointments, 0);
    if (totalAppointments === 0) {
      return {
        ...envelope,
        empty: true,
        data: [],
        total: 0,
        page: dto.page,
        limit: dto.limit,
      };
    }

    const data = rows.map((r) => ({
      source: r.source,
      appointments: r.appointments,
      completionRate:
        r.appointments > 0 ? round2(r.completed / r.appointments) : null,
      revenue: r.revenue,
    }));
    const offset = (dto.page - 1) * dto.limit;
    return {
      ...envelope,
      empty: false,
      data: data.slice(offset, offset + dto.limit),
      total: data.length,
      page: dto.page,
      limit: dto.limit,
    };
  }
}
