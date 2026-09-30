import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { ROLE } from '../../rbac/rbac.constants';
import { BillingModeService } from '../subscription-billing/billing-mode.service';
import { PlatformStaffService } from '../platform-staff/platform-staff.service';
import type { PlatformStaffSummary } from '../platform-staff/platform-staff.service';

import { QuerySalesEmployeesDto } from './dto/query-sales-employees.dto';
import type { SalesEmployeeSort } from './platform-sales.constants';
import { computeMetricProgress } from '../tenant/tenant-target-progress.util';
import { computeBonus } from './sales-bonus.util';
import { currentSalesPeriod, parseSalesPeriod } from './sales-period.util';
import { salesPhaseOf } from './sales-progress.util';
import { SalesProgressService } from './sales-progress.service';
import type {
  Paged,
  SalesEmployeeDetail,
  SalesEmployeeListItem,
  SalesEmployeeRef,
  SalesBonusAmount,
  SalesMetricRow,
  SalesOverview,
  SalesOverviewMetric,
  SalesTargetBrief,
} from './sales.types';

/** `u` is `users`; true when it holds the global `platform_sales` role. */
const HAS_SALES_ROLE = `EXISTS (
  SELECT 1 FROM user_roles ur
  INNER JOIN roles r ON r.id = ur."roleId"
  WHERE ur."userId" = u.id AND r.slug = '${ROLE.PLATFORM_SALES}' AND r."tenantId" IS NULL
)`;

/** `SELECT` fragment for the sort key; only keys from the DTO allow-list reach it. */
const EMPLOYEE_SORT_SQL: Record<SalesEmployeeSort, string> = {
  name: 'LOWER(COALESCE(u.full_name, u.email))',
  assigned: 'COALESCE(ac.c, 0)',
  lastActivity: 'la.last_activity_at',
  createdAt: 'u.created_at',
};

interface StatsRow {
  id: string;
  assigned_count: number;
  ended_count: number;
  last_activity_at: Date | string | null;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/**
 * Sales employees = platform users (`tenantId IS NULL`) holding the global
 * `platform_sales` role. No table of their own: creation, profile, status and
 * invitations stay in `PlatformStaffService`; this service is the read side and
 * the ONE place that decides whether an id may receive clinics.
 */
@Injectable()
export class SalesEmployeeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly staff: PlatformStaffService,
    private readonly billingMode: BillingModeService,
    private readonly progress: SalesProgressService,
  ) {}

  /**
   * Resolves an id to a live sales employee or throws a 404 that is identical
   * for every non-match — a tenant user, a super admin, a platform-support
   * user, a soft-deleted user and a random uuid are indistinguishable, so this
   * can never be used to probe which ids exist.
   *
   * Pass `manager` when called inside a transaction so the check reads through
   * the same connection.
   */
  async requireEmployee(
    id: string,
    opts: { manager?: EntityManager; requireActive?: boolean } = {},
  ): Promise<SalesEmployeeRef> {
    const runner = opts.manager ?? this.dataSource;
    const rows = (await runner.query(
      `SELECT u.id, u.email, u.full_name, u.phone, u.is_active
         FROM users u
        WHERE u.id = $1 AND u."tenantId" IS NULL AND u.deleted_at IS NULL
          AND ${HAS_SALES_ROLE}`,
      [id],
    )) as Array<{
      id: string;
      email: string | null;
      full_name: string | null;
      phone: string | null;
      is_active: boolean;
    }>;
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.SALES_EMPLOYEE_NOT_FOUND);
    if (opts.requireActive && !row.is_active) {
      throw new AppError(ErrorCode.SALES_EMPLOYEE_INACTIVE);
    }
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phone: row.phone,
      isActive: row.is_active,
    };
  }

  async list(
    query: QuerySalesEmployeesDto,
  ): Promise<Paged<SalesEmployeeListItem>> {
    const params: unknown[] = [];
    const filters = [
      'u."tenantId" IS NULL',
      'u.deleted_at IS NULL',
      HAS_SALES_ROLE,
    ];
    if (query.isActive !== undefined) {
      params.push(query.isActive);
      filters.push(`u.is_active = $${params.length}`);
    }
    const search = query.search?.trim();
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      filters.push(
        `(u.email ILIKE ${p} OR u.full_name ILIKE ${p} OR u.phone ILIKE ${p})`,
      );
    }
    const where = filters.join(' AND ');

    // Aggregates are joined ONLY when they are the sort key — otherwise the
    // page is chosen from `users` alone and the stats are fetched afterwards
    // for exactly the page's ids.
    const joins: string[] = [];
    if (query.sortBy === 'assigned') {
      joins.push(`LEFT JOIN (
        SELECT sales_user_id, COUNT(*)::int AS c
          FROM sales_clinic_assignments WHERE ended_at IS NULL
         GROUP BY sales_user_id) ac ON ac.sales_user_id = u.id`);
    }
    if (query.sortBy === 'lastActivity') {
      joins.push(`LEFT JOIN (
        SELECT sales_user_id, MAX(occurred_at) AS last_activity_at
          FROM sales_activities WHERE deleted_at IS NULL
         GROUP BY sales_user_id) la ON la.sales_user_id = u.id`);
    }
    const dir = query.sortDir === 'ASC' ? 'ASC' : 'DESC';
    const orderBy = `${EMPLOYEE_SORT_SQL[query.sortBy]} ${dir} NULLS LAST, u.id ${dir}`;

    const [countRows, idRows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM users u WHERE ${where}`,
        params,
      ) as Promise<Array<{ total: number }>>,
      this.dataSource.query(
        `SELECT u.id FROM users u ${joins.join(' ')}
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.limit, query.offset()],
      ) as Promise<Array<{ id: string }>>,
    ]);

    const ids = idRows.map((r) => r.id);
    const period = query.period
      ? parseSalesPeriod(query.period)
      : currentSalesPeriod();
    const [summaries, stats, targetRows] = await Promise.all([
      this.staff.summarize(ids),
      this.statsFor(ids),
      this.progress.rows({
        employeeIds: ids,
        from: period,
        to: period,
        includeUntargeted: false,
      }),
    ]);
    const statsById = new Map(stats.map((s) => [s.id, s]));
    const briefs = this.briefsByEmployee(targetRows);
    const bonuses = this.bonusPreviewByEmployee(targetRows);

    return {
      data: summaries.map((s) =>
        this.withStats(s, statsById.get(s.id), briefs.get(s.id), bonuses.get(s.id)),
      ),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async detail(id: string, period?: string): Promise<SalesEmployeeDetail> {
    await this.requireEmployee(id);
    const p = period ? parseSalesPeriod(period) : currentSalesPeriod();
    const [[summary], [stats], targetRows] = await Promise.all([
      this.staff.summarize([id]),
      this.statsFor([id]),
      this.progress.rows({
        employeeIds: [id],
        from: p,
        to: p,
        includeUntargeted: false,
      }),
    ]);
    if (!summary) throw new AppError(ErrorCode.SALES_EMPLOYEE_NOT_FOUND);
    return {
      ...this.withStats(
        summary,
        stats,
        this.briefsByEmployee(targetRows).get(id),
        this.bonusPreviewByEmployee(targetRows).get(id),
      ),
      endedCount: stats?.ended_count ?? 0,
    };
  }

  async overview(period?: string): Promise<SalesOverview> {
    const p = period ? parseSalesPeriod(period) : currentSalesPeriod();

    const [[row], mode] = await Promise.all([
      this.dataSource.query(
        `SELECT
           (SELECT COUNT(*)::int FROM users u
             WHERE u."tenantId" IS NULL AND u.deleted_at IS NULL AND ${HAS_SALES_ROLE}) AS employees,
           (SELECT COUNT(*)::int FROM users u
             WHERE u."tenantId" IS NULL AND u.deleted_at IS NULL AND u.is_active
               AND ${HAS_SALES_ROLE}) AS active_employees,
           (SELECT COUNT(*)::int FROM sales_clinic_assignments a
             INNER JOIN tenants t ON t.id = a.tenant_id AND t.deleted_at IS NULL
             WHERE a.ended_at IS NULL) AS assigned_clinics,
           (SELECT COUNT(*)::int FROM tenants t
             WHERE t.deleted_at IS NULL AND t.approval_status <> 'REJECTED'
               AND NOT EXISTS (
                 SELECT 1 FROM sales_clinic_assignments a
                  WHERE a.tenant_id = t.id AND a.ended_at IS NULL)) AS unassigned_clinics`,
      ) as Promise<
        Array<{
          employees: number;
          active_employees: number;
          assigned_clinics: number;
          unassigned_clinics: number;
        }>
      >,
      this.billingMode.get(),
    ]);

    // A month that is still open counts only ACTIVE employees' targets, so a
    // rep who has left does not inflate the team's target; a closed month is
    // history and counts everyone who had one.
    const teamTargets = await this.progress.loadTeamTargets(
      p,
      salesPhaseOf(p) !== 'past',
    );
    const targetRows = await this.progress.rows({
      employeeIds: [],
      from: p,
      to: p,
      includeUntargeted: false,
      targets: teamTargets,
    });

    return {
      period: p.period,
      periodMonth: p.periodMonth,
      employees: row?.employees ?? 0,
      activeEmployees: row?.active_employees ?? 0,
      assignedClinics: row?.assigned_clinics ?? 0,
      unassignedClinics: row?.unassigned_clinics ?? 0,
      billingMode: String(mode),
      targetsSet: targetRows.length,
      onTrack: targetRows.filter((r) => r.onTrack).length,
      byMetric: this.aggregateByMetric(targetRows),
      billingLive: String(mode).toUpperCase() === 'PAID',
    };
  }

  // ─────────────────────────────── internals ─────────────────────────────── //

  /** Per-employee portfolio stats for exactly these ids — one query. */
  private async statsFor(ids: readonly string[]): Promise<StatsRow[]> {
    if (ids.length === 0) return [];
    return (await this.dataSource.query(
      `SELECT x.id,
              (SELECT COUNT(*)::int FROM sales_clinic_assignments a
                WHERE a.sales_user_id = x.id AND a.ended_at IS NULL) AS assigned_count,
              (SELECT COUNT(*)::int FROM sales_clinic_assignments a
                WHERE a.sales_user_id = x.id AND a.ended_at IS NOT NULL) AS ended_count,
              (SELECT MAX(s.occurred_at) FROM sales_activities s
                WHERE s.sales_user_id = x.id AND s.deleted_at IS NULL) AS last_activity_at
         FROM unnest($1::uuid[]) AS x(id)`,
      [[...ids]],
    )) as StatsRow[];
  }

  private withStats(
    summary: PlatformStaffSummary,
    stats: StatsRow | undefined,
    targets: SalesTargetBrief[] = [],
    bonusPreview: SalesBonusAmount[] = [],
  ): SalesEmployeeListItem {
    return {
      ...summary,
      assignedCount: stats?.assigned_count ?? 0,
      lastActivityAt: iso(stats?.last_activity_at),
      targets,
      bonusPreview,
    };
  }

  /** The slim per-metric progress the team table shows, grouped by employee. */
  private briefsByEmployee(
    rows: SalesMetricRow[],
  ): Map<string, SalesTargetBrief[]> {
    const out = new Map<string, SalesTargetBrief[]>();
    for (const r of rows) {
      if (r.target === null) continue;
      const uid = r.employeeId;
      const list = out.get(uid) ?? [];
      list.push({
        metric: r.metric,
        target: r.target,
        currency: r.currency,
        achieved: r.achieved,
        percentage: r.percentage,
        isCompleted: r.isCompleted,
        expectedPercentage: r.expectedPercentage,
        onTrack: r.onTrack,
      });
      out.set(uid, list);
    }
    return out;
  }

  /**
   * What each employee's bonus rules would pay for the progress so far, summed per
   * currency (there is no FX). Computed from rows the list already loaded — no query.
   */
  private bonusPreviewByEmployee(
    rows: SalesMetricRow[],
  ): Map<string, SalesBonusAmount[]> {
    const sums = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (r.target === null || !r.bonusRule) continue;
      const b = computeBonus(r.bonusRule, r.target, r.achieved);
      if (!b.currency || b.amount <= 0) continue;
      const byCurrency = sums.get(r.employeeId) ?? new Map<string, number>();
      byCurrency.set(b.currency, (byCurrency.get(b.currency) ?? 0) + b.amount);
      sums.set(r.employeeId, byCurrency);
    }
    const out = new Map<string, SalesBonusAmount[]>();
    for (const [uid, byCurrency] of sums) {
      out.set(
        uid,
        [...byCurrency.entries()]
          .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      );
    }
    return out;
  }

  /** Team totals per metric (revenue per currency — there is no FX). */
  private aggregateByMetric(rows: SalesMetricRow[]): SalesOverviewMetric[] {
    const groups = new Map<string, SalesOverviewMetric>();
    for (const r of rows) {
      if (r.target === null) continue;
      const key = `${r.metric}|${r.currency ?? ''}`;
      const g = groups.get(key) ?? {
        metric: r.metric,
        currency: r.currency,
        targets: 0,
        target: 0,
        achieved: 0,
        percentage: null,
        onTrack: 0,
      };
      g.targets += 1;
      g.target += r.target;
      g.achieved += r.achieved;
      if (r.onTrack) g.onTrack += 1;
      groups.set(key, g);
    }
    const order = ['new_clinics', 'subscription_revenue', 'paid_conversions'];
    return [...groups.values()]
      .map((g) => ({
        ...g,
        target: Math.round(g.target * 100) / 100,
        achieved: Math.round(g.achieved * 100) / 100,
        percentage: computeMetricProgress(g.target, g.achieved).percentage,
      }))
      .sort(
        (a, b) =>
          order.indexOf(a.metric) - order.indexOf(b.metric) ||
          (a.currency ?? '').localeCompare(b.currency ?? ''),
      );
  }
}
