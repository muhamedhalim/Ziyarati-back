import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import {
  TenantTarget,
  TenantTargetType,
} from '../../entities/SaaS-Core/TenantTarget';
import {
  TenantTargetChange,
  TenantTargetHistory,
} from '../../entities/SaaS-Core/TenantTargetHistory';
import { AppError, ErrorCode } from '../../common/errors';
import {
  BranchScopeService,
  type BranchScope,
} from '../../core/branch-scope/branch-scope.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AnalyticsAggregationService } from '../analytics/analytics-aggregation.service';
import {
  AnalyticsCacheService,
  CACHE_NS,
} from '../analytics/analytics-cache.service';
import {
  currentMonthUtc,
  monthRangeUtc,
} from '../analytics/analytics.constants';
import {
  computeMetricProgress,
  type TargetMetricProgress,
} from './tenant-target-progress.util';
import {
  TargetChangesQueryDto,
  TargetHistoryQueryDto,
  TargetProgressQueryDto,
  UpdateTenantTargetsDto,
} from './dto/tenant-targets.dto';

/** How far ahead (in months) a target may be pre-set. */
export const MAX_TARGET_MONTHS_AHEAD = 12;

/**
 * Where the displayed target came from — so the UI never presents a number
 * without saying what scope it describes.
 *  - BRANCH:       the selected branch's own target.
 *  - ORGANIZATION: the clinic-wide target (tenant-wide caller, all branches).
 *  - BRANCH_SUM:   a branch-restricted caller's "all my branches" view: the SUM
 *                  of their branches' targets, only when EVERY one has one.
 */
export type TargetSource = 'BRANCH' | 'ORGANIZATION' | 'BRANCH_SUM';

export interface TargetMetric extends TargetMetricProgress {
  targetId: string | null;
  /** First value ever set for this scope/month (null if no target or a sum). */
  originalTarget: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  source: TargetSource;
  /** Set when `target` is null for a reason other than "never set". */
  unavailableReason: 'BRANCH_TARGETS_INCOMPLETE' | null;
}

export interface TenantTargetProgress {
  period: { month: string; start: string; end: string };
  currency: string;
  branch: { id: string | null; name: string | null };
  appointments: TargetMetric;
  revenue: TargetMetric;
}

export interface TargetHistoryRow {
  id: string;
  type: TenantTargetType;
  month: string;
  branch: { id: string | null; name: string | null };
  target: number;
  originalTarget: number;
  edited: boolean;
  actual: number;
  percentage: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TargetChangeRow {
  id: string;
  changeType: TenantTargetChange;
  previousValue: number | null;
  newValue: number;
  actorUserId: string | null;
  changedAt: string;
}

const num = (v: string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Compare two numerics as exact 2dp integers (no float drift). */
const cents = (n: number): number => Math.round(n * 100);

/** Pure: the 'YYYY-MM' that is `n` months after `month`. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Monthly appointment/revenue targets, scoped per branch (or clinic-wide),
 * with an append-only change ledger.
 *
 * Trust model: tenant comes from the authenticated context; a client branch
 * id is checked to belong to the tenant AND to be inside the caller's branch
 * scope before it is used; the actor on every ledger row is the principal's
 * id, never a body field.
 */
@Injectable()
export class TenantTargetsService {
  constructor(
    @InjectRepository(TenantTarget)
    private readonly targets: Repository<TenantTarget>,
    @InjectRepository(TenantTargetHistory)
    private readonly history: Repository<TenantTargetHistory>,
    @InjectRepository(TenantSetting)
    private readonly settings: Repository<TenantSetting>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    private readonly dataSource: DataSource,
    private readonly branchScope: BranchScopeService,
    private readonly aggregation: AnalyticsAggregationService,
    private readonly cache: AnalyticsCacheService,
  ) {}

  // ───────────────────────────── reads ───────────────────────────── //

  async getProgress(
    tenantId: string,
    user: Pick<AuthenticatedUser, 'id' | 'permissions'>,
    q: TargetProgressQueryDto,
  ): Promise<TenantTargetProgress> {
    const month = this.resolveMonth(q.month);
    const { start, end } = monthRangeUtc(month);
    const scope = await this.resolveScope(tenantId, user, q.branchId);
    const currency = await this.currency(tenantId);

    const totals = await this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      `targets:${month}:${this.scopeKey(scope.effective)}`,
      () =>
        this.aggregation.computeCurrentMonthTenantTotals(
          tenantId,
          month,
          scope.effective.branchIds,
        ),
    );

    const rows = await this.loadTargetRows(tenantId, month, scope);
    return {
      period: { month, start: start.toISOString(), end: end.toISOString() },
      currency,
      branch: { id: scope.branchId, name: scope.branchName },
      appointments: this.buildMetric(
        TenantTargetType.APPOINTMENTS,
        rows,
        scope,
        totals.completed_appointments,
      ),
      revenue: this.buildMetric(
        TenantTargetType.REVENUE,
        rows,
        scope,
        totals.total_revenue,
      ),
    };
  }

  async getHistory(
    tenantId: string,
    user: Pick<AuthenticatedUser, 'id' | 'permissions'>,
    q: TargetHistoryQueryDto,
  ): Promise<{
    data: TargetHistoryRow[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = q.page ?? 1;
    const limit = q.limit ?? 12;
    const scope = await this.resolveScope(tenantId, user, q.branchId);
    if (q.month) this.assertMonthFormat(q.month);

    const qb = this.targets
      .createQueryBuilder('t')
      .where('t.tenant_id = :tenantId', { tenantId })
      .andWhere('t.target_type = :type', { type: q.type });
    this.applyScope(qb, scope);
    if (q.month) qb.andWhere('t.period_month = :month', { month: q.month });
    const [rows, total] = await qb
      .orderBy('t.period_month', 'DESC')
      .addOrderBy('t.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // Names for the (≤ limit) branches on this page — one query.
    const branchIds = [
      ...new Set(rows.map((r) => r.branch_id).filter((b): b is string => !!b)),
    ];
    const names = new Map<string, string>();
    if (branchIds.length) {
      const bs = await this.branches.find({
        where: { id: In(branchIds), tenant: { id: tenantId } },
        select: { id: true, name: true },
      });
      bs.forEach((b) => names.set(b.id, b.name));
    }

    // Actuals: one grouped query per distinct scope on the page (bounded by
    // the caller's branch count), never per row.
    const scopes = new Map<string, string[] | null>();
    for (const r of rows)
      scopes.set(r.branch_id ?? '', r.branch_id ? [r.branch_id] : null);
    const actuals = new Map<
      string,
      Map<string, { completed_appointments: number; total_revenue: number }>
    >();
    const months = [...new Set(rows.map((r) => r.period_month))];
    await Promise.all(
      [...scopes.entries()].map(async ([key, ids]) => {
        actuals.set(
          key,
          await this.aggregation.computeMonthTotalsBulk(tenantId, months, ids),
        );
      }),
    );

    const data = rows.map<TargetHistoryRow>((r) => {
      const t = actuals.get(r.branch_id ?? '')?.get(r.period_month);
      const actual =
        (q.type === TenantTargetType.APPOINTMENTS
          ? t?.completed_appointments
          : t?.total_revenue) ?? 0;
      const target = Number(r.value);
      return {
        id: r.id,
        type: r.target_type,
        month: r.period_month,
        branch: {
          id: r.branch_id,
          name: r.branch_id ? (names.get(r.branch_id) ?? null) : null,
        },
        target,
        originalTarget: Number(r.original_value),
        edited:
          cents(target) !== cents(Number(r.original_value)) ||
          r.updated_at.getTime() !== r.created_at.getTime(),
        actual,
        percentage: computeMetricProgress(target, actual).percentage,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    });
    return { data, total, page, limit };
  }

  async getChanges(
    tenantId: string,
    user: Pick<AuthenticatedUser, 'id' | 'permissions'>,
    q: TargetChangesQueryDto,
  ): Promise<TargetChangeRow[]> {
    const scope = await this.resolveScope(tenantId, user, q.branchId);
    // The ledger is read for ONE concrete scope; "all branches" for a
    // restricted caller has no single scope, so a branch is required there.
    if (!scope.branchId && scope.effective.branchIds !== null) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'branchId is required',
      });
    }
    this.assertMonthFormat(q.month);
    const qb = this.history
      .createQueryBuilder('h')
      .where('h.tenant_id = :tenantId', { tenantId })
      .andWhere('h.target_type = :type', { type: q.type })
      .andWhere('h.period_month = :month', { month: q.month });
    if (scope.branchId)
      qb.andWhere('h.branch_id = :branchId', { branchId: scope.branchId });
    else qb.andWhere('h.branch_id IS NULL');
    const rows = await qb
      .orderBy('h.changed_at', 'DESC')
      .addOrderBy('h.id', 'ASC')
      .take(100)
      .getMany();
    return rows.map((h) => ({
      id: h.id,
      changeType: h.change_type,
      previousValue: num(h.previous_value),
      newValue: Number(h.new_value),
      actorUserId: h.actor_user_id,
      changedAt: h.changed_at.toISOString(),
    }));
  }

  // ───────────────────────────── write ───────────────────────────── //

  /**
   * Sets one or both targets for (month, scope). A first value is a CREATE,
   * a changed value an UPDATE (previous value kept in the ledger), an
   * identical value a no-op — all in ONE transaction with the row locked so
   * concurrent saves serialize and the ledger always matches the row.
   */
  async setTargets(
    tenantId: string,
    user: Pick<AuthenticatedUser, 'id' | 'permissions'>,
    dto: UpdateTenantTargetsDto,
  ): Promise<TenantTargetProgress> {
    const month = this.resolveMonth(dto.month);
    const current = currentMonthUtc();
    if (month < current) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Targets for past months cannot be changed',
      });
    }
    if (month > addMonths(current, MAX_TARGET_MONTHS_AHEAD)) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Targets can be set at most ${MAX_TARGET_MONTHS_AHEAD} months ahead`,
      });
    }
    const scope = await this.resolveScope(tenantId, user, dto.branchId);

    const changes: Array<[TenantTargetType, number]> = [];
    if (dto.appointmentTarget !== undefined)
      changes.push([TenantTargetType.APPOINTMENTS, dto.appointmentTarget]);
    if (dto.revenueTarget !== undefined)
      changes.push([TenantTargetType.REVENUE, dto.revenueTarget]);

    if (changes.length) {
      await this.dataSource.transaction(async (m) => {
        for (const [type, value] of changes) {
          await this.upsertOne(
            m,
            tenantId,
            user.id,
            scope.branchId,
            type,
            month,
            value,
          );
        }
      });
    }
    return this.getProgress(tenantId, user, { month, branchId: dto.branchId });
  }

  private async upsertOne(
    m: EntityManager,
    tenantId: string,
    actorId: string,
    branchId: string | null,
    type: TenantTargetType,
    month: string,
    value: number,
  ): Promise<void> {
    const qb = m
      .createQueryBuilder(TenantTarget, 't')
      .setLock('pessimistic_write')
      .where('t.tenant_id = :tenantId', { tenantId })
      .andWhere('t.target_type = :type', { type })
      .andWhere('t.period_month = :month', { month });
    if (branchId) qb.andWhere('t.branch_id = :branchId', { branchId });
    else qb.andWhere('t.branch_id IS NULL');
    const existing = await qb.getOne();
    const fixed = value.toFixed(2);

    if (!existing) {
      let saved: TenantTarget;
      try {
        saved = await m.save(
          m.create(TenantTarget, {
            tenant_id: tenantId,
            branch_id: branchId,
            target_type: type,
            period_month: month,
            value: fixed,
            original_value: fixed,
            created_by: actorId,
            updated_by: actorId,
          }),
        );
      } catch (e) {
        // Two first-writers raced past the (empty) lock: the unique index is
        // the arbiter — report it as a conflict, never a duplicate row.
        if ((e as { code?: string }).code === '23505') {
          throw new AppError(ErrorCode.CONFLICT, {
            message: 'Target was set concurrently, please retry',
          });
        }
        throw e;
      }
      await m.insert(TenantTargetHistory, {
        tenant_id: tenantId,
        target_id: saved.id,
        branch_id: branchId,
        target_type: type,
        period_month: month,
        change_type: TenantTargetChange.CREATED,
        previous_value: null,
        new_value: fixed,
        actor_user_id: actorId,
      });
      return;
    }

    if (cents(Number(existing.value)) === cents(value)) return; // no-op
    const previous = existing.value;
    await m.update(
      TenantTarget,
      { id: existing.id },
      { value: fixed, updated_by: actorId },
    );
    await m.insert(TenantTargetHistory, {
      tenant_id: tenantId,
      target_id: existing.id,
      branch_id: branchId,
      target_type: type,
      period_month: month,
      change_type: TenantTargetChange.UPDATED,
      previous_value: previous,
      new_value: fixed,
      actor_user_id: actorId,
    });
  }

  // ──────────────────────────── helpers ──────────────────────────── //

  private resolveMonth(month: string | undefined): string {
    if (!month) return currentMonthUtc();
    this.assertMonthFormat(month);
    return month;
  }

  private assertMonthFormat(month: string): void {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'month must be in YYYY-MM format',
      });
    }
  }

  private async currency(tenantId: string): Promise<string> {
    const s = await this.settings.findOne({
      where: { tenant: { id: tenantId } },
      select: { id: true, currency: true },
    });
    return s?.currency ?? 'USD'; // TenantSetting column default
  }

  private scopeKey(scope: BranchScope): string {
    if (scope.branchIds === null) return 'all';
    if (scope.branchIds.length === 0) return 'none';
    if (scope.branchIds.length === 1) return scope.branchIds[0];
    return createHash('sha1')
      .update(scope.branchIds.join(','))
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * The scope a request resolves to. A client branch id must (1) belong to
   * this tenant (404 otherwise — a foreign id is indistinguishable from a
   * missing one) and (2) lie inside the caller's own branch scope (403).
   */
  private async resolveScope(
    tenantId: string,
    user: Pick<AuthenticatedUser, 'id' | 'permissions'>,
    requestedBranchId: string | undefined,
  ): Promise<{
    branchId: string | null;
    branchName: string | null;
    effective: BranchScope;
    /** Branch-restricted caller's authorised set (null = tenant-wide). */
    allowed: string[] | null;
  }> {
    const caller = await this.branchScope.resolve(tenantId, user);
    if (!requestedBranchId) {
      return {
        branchId: null,
        branchName: null,
        effective: caller,
        allowed: caller.branchIds,
      };
    }
    const branch = await this.branches.findOne({
      where: { id: requestedBranchId, tenant: { id: tenantId } },
      select: { id: true, name: true },
    });
    if (!branch)
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    this.branchScope.assertBranchAllowed(caller, requestedBranchId);
    return {
      branchId: branch.id,
      branchName: branch.name,
      effective: { branchIds: [branch.id] },
      allowed: caller.branchIds,
    };
  }

  private applyScope(
    qb: ReturnType<Repository<TenantTarget>['createQueryBuilder']>,
    scope: { branchId: string | null; allowed: string[] | null },
  ): void {
    if (scope.branchId)
      qb.andWhere('t.branch_id = :branchId', { branchId: scope.branchId });
    else if (scope.allowed === null)
      qb.andWhere('t.branch_id IS NULL'); // clinic-wide
    else if (scope.allowed.length === 0) qb.andWhere('1 = 0');
    else
      qb.andWhere('t.branch_id IN (:...allowed)', { allowed: scope.allowed });
  }

  private async loadTargetRows(
    tenantId: string,
    month: string,
    scope: { branchId: string | null; allowed: string[] | null },
  ): Promise<TenantTarget[]> {
    const qb = this.targets
      .createQueryBuilder('t')
      .where('t.tenant_id = :tenantId', { tenantId })
      .andWhere('t.period_month = :month', { month });
    this.applyScope(qb, scope);
    return qb.getMany();
  }

  private buildMetric(
    type: TenantTargetType,
    rows: TenantTarget[],
    scope: { branchId: string | null; allowed: string[] | null },
    actual: number,
  ): TargetMetric {
    const mine = rows.filter((r) => r.target_type === type);
    const base = {
      targetId: null,
      originalTarget: null,
      createdAt: null,
      updatedAt: null,
      unavailableReason: null,
    } as const;

    // Branch-restricted "all my branches": additive ONLY when complete.
    if (!scope.branchId && scope.allowed !== null) {
      const complete =
        scope.allowed.length > 0 &&
        scope.allowed.every((id) => mine.some((r) => r.branch_id === id));
      if (!complete) {
        return {
          ...computeMetricProgress(null, actual),
          ...base,
          source: 'BRANCH_SUM',
          unavailableReason: mine.length ? 'BRANCH_TARGETS_INCOMPLETE' : null,
        };
      }
      const sumCents = mine.reduce((s, r) => s + cents(Number(r.value)), 0);
      return {
        ...computeMetricProgress(sumCents / 100, actual),
        ...base,
        source: 'BRANCH_SUM',
      };
    }

    const row = mine[0];
    const source: TargetSource = scope.branchId ? 'BRANCH' : 'ORGANIZATION';
    if (!row)
      return { ...computeMetricProgress(null, actual), ...base, source };
    return {
      ...computeMetricProgress(Number(row.value), actual),
      targetId: row.id,
      originalTarget: Number(row.original_value),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      unavailableReason: null,
      source,
    };
  }
}
