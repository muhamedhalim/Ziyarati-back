import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { SALES_METRIC } from '../../entities/Sales/SalesTarget';
import type { SalesMetric } from '../../entities/Sales/SalesTarget';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import { BillingModeService } from '../subscription-billing/billing-mode.service';

import { QueryTargetRevisionsDto } from './dto/query-target-revisions.dto';
import type { SetSalesTargetDto } from './dto/set-sales-target.dto';
import { SALES_REASON_MAX } from './platform-sales.constants';
import { currentSalesPeriod, parseSalesPeriod } from './sales-period.util';
import type { SalesPeriod } from './sales-period.util';
import { SalesEmployeeService } from './sales-employee.service';
import {
  salesPeriodsBetween,
  salesPhaseOf,
} from './sales-progress.util';
import {
  SalesProgressService,
  type SalesTargetRecord,
} from './sales-progress.service';
import {
  normalizeSalesTargetRule,
  sameSalesTargetRule,
} from './sales-target-rule.util';
import type { SalesTargetRule } from './sales-target-rule.util';
import type {
  Paged,
  SalesMetricRow,
  SalesTargetMonth,
  SalesTargetRevisionItem,
  SalesTargetsResponse,
} from './sales.types';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: string }).code === '23505';

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/** The rule as stored in a revision / audit snapshot. */
const snapshot = (r: SalesTargetRule): Record<string, unknown> => ({
  targetValue: r.targetValue,
  currency: r.currency,
  bonusType: r.bonusType,
  bonusThresholdPct: r.bonusThresholdPct,
  bonusAmount: r.bonusAmount,
  bonusPercent: r.bonusPercent,
  bonusCurrency: r.bonusCurrency,
});

const ruleOf = (t: SalesTargetRecord): SalesTargetRule => ({
  targetValue: t.targetValue,
  currency: t.currency,
  bonusType: t.bonusType,
  bonusThresholdPct: t.bonusThresholdPct,
  bonusAmount: t.bonusAmount,
  bonusPercent: t.bonusPercent,
  bonusCurrency: t.bonusCurrency,
});

export function assertSalesMetric(metric: string): SalesMetric {
  if (!(SALES_METRIC as readonly string[]).includes(metric)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `metric must be one of ${SALES_METRIC.join(', ')}`,
      publicContext: { field: 'metric' },
    });
  }
  return metric as SalesMetric;
}

/**
 * Monthly targets.
 *
 * RULES
 *  - One target per (employee, month, metric).
 *  - A month that has CLOSED needs a written reason to create, change or clear
 *    a target in it; a target whose bonus is approved (or has bonus history)
 *    can no longer be touched.
 *  - Every change writes a `sales_target_revisions` row IN THE SAME TRANSACTION
 *    (the audit log is best-effort and is written afterwards).
 *  - Two admins editing the same target cannot overwrite each other: the row is
 *    locked `FOR UPDATE` and `expectedVersion` is compared under that lock.
 */
@Injectable()
export class SalesTargetService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly employees: SalesEmployeeService,
    private readonly progress: SalesProgressService,
    private readonly billingMode: BillingModeService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  // ─────────────────────────────── reads ─────────────────────────────────── //

  async list(
    employeeId: string,
    from?: string,
    to?: string,
  ): Promise<SalesTargetsResponse> {
    await this.employees.requireEmployee(employeeId);
    const cur = currentSalesPeriod().period;
    const fromP = parseSalesPeriod(from ?? to ?? cur);
    const toP = parseSalesPeriod(to ?? from ?? cur);
    const periods = salesPeriodsBetween(fromP.period, toP.period);

    const [rows, defaultCurrency, mode] = await Promise.all([
      this.progress.rows({
        employeeIds: [employeeId],
        from: fromP,
        to: toP,
        includeUntargeted: true,
      }),
      this.progress.defaultCurrency(),
      this.billingMode.get(),
    ]);

    const now = new Date();
    const months: SalesTargetMonth[] = periods.map((p) => ({
      period: p.period,
      phase: salesPhaseOf(p, now),
      metrics: rows.filter((r) => r.period === p.period),
    }));
    return {
      employeeId,
      from: fromP.period,
      to: toP.period,
      defaultCurrency,
      currencies: this.progress.allowedCurrencies(),
      billingLive: String(mode).toUpperCase() === 'PAID',
      months,
    };
  }

  async revisions(
    employeeId: string,
    query: QueryTargetRevisionsDto,
  ): Promise<Paged<SalesTargetRevisionItem>> {
    await this.employees.requireEmployee(employeeId);
    const params: unknown[] = [employeeId];
    const filters = ['t.sales_user_id = $1'];
    if (query.period) {
      params.push(parseSalesPeriod(query.period).periodMonth);
      filters.push(`t.period_month = $${params.length}::date`);
    }
    if (query.metric) {
      params.push(assertSalesMetric(query.metric));
      filters.push(`t.metric = $${params.length}`);
    }
    const where = filters.join(' AND ');

    const [countRows, rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total
           FROM sales_target_revisions r
           INNER JOIN sales_targets t ON t.id = r.target_id
          WHERE ${where}`,
        params,
      ) as Promise<Array<{ total: number }>>,
      this.dataSource.query(
        `SELECT r.id, r.target_id, to_char(t.period_month, 'YYYY-MM') AS period,
                t.metric, r.revision, r.before, r.after, r.reason, r.created_at,
                r.changed_by, u.full_name AS changed_by_name, u.email AS changed_by_email
           FROM sales_target_revisions r
           INNER JOIN sales_targets t ON t.id = r.target_id
           LEFT JOIN users u ON u.id = r.changed_by
          WHERE ${where}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.limit, query.offset()],
      ) as Promise<
        Array<{
          id: string;
          target_id: string;
          period: string;
          metric: SalesMetric;
          revision: number;
          before: Record<string, unknown> | null;
          after: Record<string, unknown> | null;
          reason: string | null;
          created_at: Date | string;
          changed_by: string;
          changed_by_name: string | null;
          changed_by_email: string | null;
        }>
      >,
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        targetId: r.target_id,
        period: r.period,
        metric: r.metric,
        revision: r.revision,
        before: r.before,
        after: r.after,
        reason: r.reason,
        changedBy: r.changed_by
          ? { id: r.changed_by, name: r.changed_by_name ?? r.changed_by_email }
          : null,
        createdAt: iso(r.created_at),
      })),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  // ─────────────────────────────── writes ────────────────────────────────── //

  /**
   * Creates or updates one target. Returns the row with fresh progress. A
   * request that changes nothing writes nothing (no version bump, no revision).
   */
  async upsert(
    employeeId: string,
    period: string,
    metric: SalesMetric,
    dto: SetSalesTargetDto,
    actorUserId: string,
  ): Promise<SalesMetricRow> {
    const p = parseSalesPeriod(period);
    const phase = salesPhaseOf(p);
    const reason = dto.reason?.trim() || null;
    const [defaultCurrency] = await Promise.all([this.progress.defaultCurrency()]);
    const rule = normalizeSalesTargetRule(
      metric,
      dto,
      defaultCurrency,
      this.progress.allowedCurrencies(),
    );

    let outcome: {
      targetId: string;
      before: SalesTargetRule | null;
      changed: boolean;
    };
    try {
      outcome = await this.dataSource.transaction(async (m) => {
        // A deactivated employee gets no NEW open-month targets, but a closed
        // month can still be corrected.
        await this.employees.requireEmployee(employeeId, {
          manager: m,
          requireActive: phase !== 'past',
        });
        const existing = await this.lockTarget(m, employeeId, p, metric);

        if (existing?.locked) {
          throw new AppError(ErrorCode.SALES_TARGET_LOCKED);
        }
        if (phase === 'past' && !reason) {
          throw new AppError(ErrorCode.SALES_REASON_REQUIRED);
        }
        if (
          existing &&
          dto.expectedVersion !== undefined &&
          dto.expectedVersion !== existing.version
        ) {
          throw new AppError(ErrorCode.SALES_TARGET_VERSION_CONFLICT);
        }

        if (!existing) {
          const rows = (await m.query(
            `INSERT INTO sales_targets
               (sales_user_id, period_month, metric, target_value, currency,
                bonus_type, bonus_threshold_pct, bonus_amount, bonus_percent,
                bonus_currency, version, created_by, updated_by)
             VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)
             RETURNING id`,
            [
              employeeId,
              p.periodMonth,
              metric,
              rule.targetValue,
              rule.currency,
              rule.bonusType,
              rule.bonusThresholdPct,
              rule.bonusAmount,
              rule.bonusPercent,
              rule.bonusCurrency,
              actorUserId,
            ],
          )) as Array<{ id: string }>;
          const id = rows[0].id;
          await this.writeRevision(m, id, 1, null, rule, reason, actorUserId);
          return { targetId: id, before: null, changed: true };
        }

        const before = ruleOf(existing);
        if (sameSalesTargetRule(before, rule)) {
          return { targetId: existing.id, before, changed: false };
        }
        const version = existing.version + 1;
        await m.query(
          `UPDATE sales_targets
              SET target_value = $2, currency = $3, bonus_type = $4,
                  bonus_threshold_pct = $5, bonus_amount = $6, bonus_percent = $7,
                  bonus_currency = $8, version = $9, updated_by = $10, updated_at = now()
            WHERE id = $1`,
          [
            existing.id,
            rule.targetValue,
            rule.currency,
            rule.bonusType,
            rule.bonusThresholdPct,
            rule.bonusAmount,
            rule.bonusPercent,
            rule.bonusCurrency,
            version,
            actorUserId,
          ],
        );
        await this.writeRevision(
          m,
          existing.id,
          version,
          before,
          rule,
          reason,
          actorUserId,
        );
        return { targetId: existing.id, before, changed: true };
      });
    } catch (err) {
      // Two admins creating the same target at once: the loser hits the unique key.
      if (isUniqueViolation(err)) {
        throw new AppError(ErrorCode.SALES_TARGET_VERSION_CONFLICT, {
          cause: err,
        });
      }
      throw err;
    }

    if (outcome.changed) {
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_TARGET_SET,
        userId: actorUserId,
        entityType: 'SalesTarget',
        entityId: outcome.targetId,
        before: outcome.before
          ? { ...snapshot(outcome.before), period, metric, employeeId }
          : undefined,
        after: { ...snapshot(rule), period, metric, employeeId, reason },
      });
    }
    return this.rowFor(employeeId, p, metric);
  }

  /**
   * Clears a target of the current or a future month. A closed month's target,
   * or one with any bonus record, is kept. (Its revisions go with it — the
   * audit entry keeps the last state and the reason.)
   */
  async remove(
    employeeId: string,
    period: string,
    metric: SalesMetric,
    reason: string | undefined,
    actorUserId: string,
  ): Promise<{ deleted: true }> {
    const p = parseSalesPeriod(period);
    const trimmed = reason?.trim().slice(0, SALES_REASON_MAX) || null;

    const before = await this.dataSource.transaction(async (m) => {
      await this.employees.requireEmployee(employeeId, { manager: m });
      const existing = await this.lockTarget(m, employeeId, p, metric);
      if (!existing) throw new AppError(ErrorCode.SALES_TARGET_NOT_FOUND);
      if (salesPhaseOf(p) === 'past') {
        throw new AppError(ErrorCode.SALES_TARGET_LOCKED, {
          message: 'A closed month keeps its target. Set it to a new value instead.',
        });
      }
      const [bonus] = (await m.query(
        `SELECT 1 FROM sales_bonus_records WHERE target_id = $1 LIMIT 1`,
        [existing.id],
      )) as unknown[];
      if (existing.locked || bonus) {
        throw new AppError(ErrorCode.SALES_TARGET_LOCKED);
      }
      await m.query(`DELETE FROM sales_targets WHERE id = $1`, [existing.id]);
      return existing;
    });

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_TARGET_DELETED,
      userId: actorUserId,
      entityType: 'SalesTarget',
      entityId: before.id,
      before: { ...snapshot(ruleOf(before)), period, metric, employeeId },
      after: { reason: trimmed },
    });
    return { deleted: true };
  }

  // ─────────────────────────────── internals ─────────────────────────────── //

  /**
   * Locks the target row (if any) for the rest of the transaction. Bonus approval
   * takes the SAME lock, so a rule edit and an approval can never interleave.
   *
   * `locked` (a live bonus exists) is deliberately read in a SECOND statement,
   * after the lock is granted. Read in the same statement it would come from that
   * statement's snapshot, taken BEFORE the wait: an approval commits a bonus
   * record without touching the target row, so a waiter gets the lock on an
   * unchanged row, PostgreSQL does not re-run the statement for it, and the flag
   * would still say "not locked" — letting an edit through onto an approved target.
   */
  async lockTarget(
    m: EntityManager,
    employeeId: string,
    p: SalesPeriod,
    metric: SalesMetric,
  ): Promise<SalesTargetRecord | null> {
    const rows = (await m.query(
      `SELECT t.id, t.sales_user_id, to_char(t.period_month, 'YYYY-MM') AS period,
              t.metric, t.target_value, t.currency, t.bonus_type,
              t.bonus_threshold_pct, t.bonus_amount, t.bonus_percent, t.bonus_currency,
              t.version, t.updated_at
         FROM sales_targets t
        WHERE t.sales_user_id = $1 AND t.period_month = $2::date AND t.metric = $3
          FOR UPDATE OF t`,
      [employeeId, p.periodMonth, metric],
    )) as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    const [live] = (await m.query(
      `SELECT EXISTS (SELECT 1 FROM sales_bonus_records b
                       WHERE b.target_id = $1::uuid AND b.status <> 'void') AS locked`,
      [r.id],
    )) as Array<{ locked: boolean }>;
    const n = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);
    const c = (v: unknown): string | null =>
      typeof v === 'string' ? v.trim() : null;
    return {
      id: r.id as string,
      salesUserId: r.sales_user_id as string,
      period: r.period as string,
      metric: r.metric as SalesMetric,
      targetValue: Number(r.target_value),
      currency: c(r.currency),
      bonusType: r.bonus_type as SalesTargetRecord['bonusType'],
      bonusThresholdPct: n(r.bonus_threshold_pct),
      bonusAmount: n(r.bonus_amount),
      bonusPercent: n(r.bonus_percent),
      bonusCurrency: c(r.bonus_currency),
      version: r.version as number,
      updatedAt: iso(r.updated_at as Date | string | null),
      locked: live?.locked === true,
    };
  }

  private async writeRevision(
    m: EntityManager,
    targetId: string,
    revision: number,
    before: SalesTargetRule | null,
    after: SalesTargetRule,
    reason: string | null,
    actorUserId: string,
  ): Promise<void> {
    await m.query(
      `INSERT INTO sales_target_revisions
         (target_id, revision, before, after, reason, changed_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
      [
        targetId,
        revision,
        before ? JSON.stringify(snapshot(before)) : null,
        JSON.stringify(snapshot(after)),
        reason ? reason.slice(0, SALES_REASON_MAX) : null,
        actorUserId,
      ],
    );
  }

  private async rowFor(
    employeeId: string,
    p: SalesPeriod,
    metric: SalesMetric,
  ): Promise<SalesMetricRow> {
    const rows = await this.progress.rows({
      employeeIds: [employeeId],
      from: p,
      to: p,
      includeUntargeted: true,
      metrics: new Set<SalesMetric>([metric]),
    });
    return rows.find((r) => r.metric === metric)!;
  }
}
