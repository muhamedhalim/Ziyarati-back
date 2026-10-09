import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import type { SalesMetric } from '../../entities/Sales/SalesTarget';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import { BillingModeService } from '../subscription-billing/billing-mode.service';

import type {
  ApproveSalesBonusDto,
  QuerySalesBonusesDto,
  VoidSalesBonusDto,
} from './dto/sales-bonus-dtos';
import { SALES_REASON_MAX } from './platform-sales.constants';
import { computeBonus, storedAchievementPct } from './sales-bonus.util';
import { SalesEmployeeService } from './sales-employee.service';
import { currentSalesPeriod, parseSalesPeriod } from './sales-period.util';
import { SalesProgressService } from './sales-progress.service';
import { salesPhaseOf } from './sales-progress.util';
import { SalesTargetService } from './sales-target.service';
import type {
  SalesBonusAmount,
  SalesBonusList,
  SalesBonusMonth,
  SalesBonusPreviewItem,
  SalesBonusRecordItem,
  SalesBonusState,
  SalesBonusStatusValue,
} from './sales.types';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: string }).code === '23505';

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface RecordRow {
  id: string;
  target_id: string;
  period: string;
  metric: SalesMetric;
  target_value: string;
  achieved_value: string;
  achievement_pct: string;
  rule_snapshot: Record<string, unknown>;
  bonus_amount: string;
  currency: string | null;
  status: SalesBonusStatusValue;
  computed_at: Date | string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | string | null;
  paid_marked_by: string | null;
  paid_marked_by_name: string | null;
  paid_marked_at: Date | string | null;
  void_reason: string | null;
  voided_by: string | null;
  voided_by_name: string | null;
  voided_at: Date | string | null;
}

/** Every column of a bonus record plus the names of the people who acted on it. */
const RECORD_SELECT = `SELECT b.id, b.target_id,
       to_char(b.period_month, 'YYYY-MM') AS period, b.metric,
       b.target_value, b.achieved_value, b.achievement_pct, b.rule_snapshot,
       b.bonus_amount, b.currency, b.status, b.computed_at,
       b.approved_by, COALESCE(ua.full_name, ua.email) AS approved_by_name, b.approved_at,
       b.paid_marked_by, COALESCE(up.full_name, up.email) AS paid_marked_by_name, b.paid_marked_at,
       b.void_reason,
       b.voided_by, COALESCE(uv.full_name, uv.email) AS voided_by_name, b.voided_at
  FROM sales_bonus_records b
  LEFT JOIN users ua ON ua.id = b.approved_by
  LEFT JOIN users up ON up.id = b.paid_marked_by
  LEFT JOIN users uv ON uv.id = b.voided_by`;

const who = (
  id: string | null,
  name: string | null,
): { id: string; name: string | null } | null => (id ? { id, name } : null);

function toRecordItem(r: RecordRow): SalesBonusRecordItem {
  return {
    id: r.id,
    targetId: r.target_id,
    period: r.period,
    metric: r.metric,
    targetValue: Number(r.target_value),
    achievedValue: Number(r.achieved_value),
    achievementPct: Number(r.achievement_pct),
    rule: r.rule_snapshot,
    amount: Number(r.bonus_amount),
    currency: r.currency ? r.currency.trim() : null,
    status: r.status,
    computedAt: iso(r.computed_at),
    approvedBy: who(r.approved_by, r.approved_by_name),
    approvedAt: iso(r.approved_at),
    paidMarkedBy: who(r.paid_marked_by, r.paid_marked_by_name),
    paidMarkedAt: iso(r.paid_marked_at),
    voidReason: r.void_reason,
    voidedBy: who(r.voided_by, r.voided_by_name),
    voidedAt: iso(r.voided_at),
  };
}

/**
 * Bonuses.
 *
 * LIFECYCLE  (preview) → approved → paid, or void.
 *  - The "draft" is never stored: `preview` recomputes it from the target's rule
 *    and the month's real progress every time.
 *  - `approve` (a CLOSED month only) recomputes on the server and freezes the
 *    numbers in `sales_bonus_records`. The client never supplies an amount.
 *  - `markPaid` is bookkeeping ("finance says it was paid"): nothing here moves money.
 *  - `void` needs a reason and unlocks the target so a corrected bonus can be
 *    approved; the voided record stays as history.
 *
 * CONCURRENCY
 *  - `approve` takes the target row lock (`FOR UPDATE`) — the same lock a target
 *    edit takes — so an edit and an approval serialize: either the edit lands
 *    first and the approval computes from the new rule, or the approval lands
 *    first and the edit is refused as locked. Two approvals of one target are
 *    also stopped by `UQ_sales_bonus_live_per_target`.
 *  - `markPaid` and `void` are conditional on the current status, so a double
 *    click or two admins cannot apply the same transition twice.
 *
 * A record is always loaded together with the employee in the route, so a bonus
 * id can never be reached through another employee.
 */
@Injectable()
export class SalesBonusService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly employees: SalesEmployeeService,
    private readonly targets: SalesTargetService,
    private readonly progress: SalesProgressService,
    private readonly billingMode: BillingModeService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  // ─────────────────────────────── reads ─────────────────────────────────── //

  /** The month's bonuses: what each rule pays for the progress so far, and the live record if any. */
  async preview(employeeId: string, period?: string): Promise<SalesBonusMonth> {
    await this.employees.requireEmployee(employeeId);
    const p = period ? parseSalesPeriod(period) : currentSalesPeriod();
    const now = new Date();
    const phase = salesPhaseOf(p, now);

    const [rows, mode] = await Promise.all([
      this.progress.rows({
        employeeIds: [employeeId],
        from: p,
        to: p,
        includeUntargeted: false,
        now,
      }),
      this.billingMode.get(),
    ]);

    const targetIds = rows.map((r) => r.targetId).filter((x): x is string => !!x);
    const records = targetIds.length
      ? ((await this.dataSource.query(
          `${RECORD_SELECT}
            WHERE b.target_id = ANY($1::uuid[])
            ORDER BY b.created_at DESC, b.id DESC`,
          [targetIds],
        )) as RecordRow[])
      : [];

    const items: SalesBonusPreviewItem[] = [];
    for (const r of rows) {
      if (r.targetId === null || r.target === null || r.version === null) continue;
      const mine = records.filter((rec) => rec.target_id === r.targetId);
      const live = mine.find((rec) => rec.status !== 'void') ?? null;
      const computed = r.bonusRule
        ? computeBonus(r.bonusRule, r.target, r.achieved)
        : computeBonus(
            { type: 'none', thresholdPct: null, amount: null, percent: null, currency: null },
            r.target,
            r.achieved,
          );
      let state: SalesBonusState;
      if (live) state = live.status === 'paid' ? 'paid' : 'approved';
      else if (!r.bonusRule) state = 'no_rule';
      else state = phase === 'past' ? 'ready' : 'open';

      items.push({
        metric: r.metric,
        period: r.period,
        targetId: r.targetId,
        version: r.version,
        target: r.target,
        achieved: r.achieved,
        percentage: r.percentage,
        currency: r.metric === 'subscription_revenue' ? r.currency : null,
        rule: r.bonusRule,
        applicable: computed.applicable,
        thresholdMet: computed.thresholdMet,
        amount: computed.amount,
        bonusCurrency: computed.currency,
        excludedCurrencies: r.excludedCurrencies,
        state,
        record: live ? toRecordItem(live) : null,
        voidedCount: mine.filter((rec) => rec.status === 'void').length,
      });
    }

    return {
      employeeId,
      period: p.period,
      phase,
      billingLive: String(mode).toUpperCase() === 'PAID',
      items,
    };
  }

  /** The employee's bonus records, newest month first, with lifetime owed / paid totals. */
  async list(
    employeeId: string,
    query: QuerySalesBonusesDto,
    opts: { excludeVoid?: boolean } = {},
  ): Promise<SalesBonusList> {
    await this.employees.requireEmployee(employeeId);
    const params: unknown[] = [employeeId];
    const filters = ['b.sales_user_id = $1'];
    // The employee's own view never lists a voided record (an admin correction).
    if (opts.excludeVoid) filters.push("b.status <> 'void'");
    if (query.period) {
      params.push(parseSalesPeriod(query.period).periodMonth);
      filters.push(`b.period_month = $${params.length}::date`);
    }
    if (query.status) {
      params.push(query.status);
      filters.push(`b.status = $${params.length}`);
    }
    const where = filters.join(' AND ');

    const [countRows, rows, totalRows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM sales_bonus_records b WHERE ${where}`,
        params,
      ) as Promise<Array<{ total: number }>>,
      this.dataSource.query(
        `${RECORD_SELECT}
          WHERE ${where}
          ORDER BY b.period_month DESC, b.created_at DESC, b.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.limit, query.offset()],
      ) as Promise<RecordRow[]>,
      this.dataSource.query(
        `SELECT status, currency, SUM(bonus_amount) AS amount
           FROM sales_bonus_records
          WHERE sales_user_id = $1 AND status IN ('approved', 'paid') AND currency IS NOT NULL
          GROUP BY status, currency
          ORDER BY currency`,
        [employeeId],
      ) as Promise<
        Array<{ status: 'approved' | 'paid'; currency: string; amount: string }>
      >,
    ]);

    const amounts = (status: 'approved' | 'paid'): SalesBonusAmount[] =>
      totalRows
        .filter((t) => t.status === status)
        .map((t) => ({ currency: t.currency.trim(), amount: round2(Number(t.amount)) }));

    return {
      data: rows.map(toRecordItem),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
      // "Owed" is what was approved and has not been marked paid yet.
      totals: { owed: amounts('approved'), paid: amounts('paid') },
    };
  }

  // ─────────────────────────────── writes ────────────────────────────────── //

  /**
   * Approves the bonus of one target of a CLOSED month, freezing the calculation.
   * A deactivated employee can still be approved — a rep who has left may be owed
   * a bonus for the months they worked.
   */
  async approve(
    employeeId: string,
    period: string,
    metric: SalesMetric,
    dto: ApproveSalesBonusDto,
    actorUserId: string,
  ): Promise<SalesBonusRecordItem> {
    const p = parseSalesPeriod(period);
    // Warm the (cached) default-currency setting BEFORE the transaction: inside it,
    // every other read goes through the transaction's own connection, so a burst of
    // approvals can never each hold a connection while waiting for a second one.
    await this.progress.defaultCurrency();

    let result: {
      id: string;
      amount: number;
      currency: string | null;
      target: number;
      achieved: number;
      pct: number;
      rule: Record<string, unknown>;
    };
    try {
      result = await this.dataSource.transaction(async (m) => {
        await this.employees.requireEmployee(employeeId, { manager: m });
        const t = await this.targets.lockTarget(m, employeeId, p, metric);
        if (!t) throw new AppError(ErrorCode.SALES_TARGET_NOT_FOUND);
        if (salesPhaseOf(p) !== 'past') {
          throw new AppError(ErrorCode.SALES_PERIOD_NOT_CLOSED);
        }
        if (t.locked) throw new AppError(ErrorCode.SALES_BONUS_EXISTS);
        if (dto.expectedVersion !== undefined && dto.expectedVersion !== t.version) {
          throw new AppError(ErrorCode.SALES_TARGET_VERSION_CONFLICT);
        }
        if (t.bonusType === 'none') throw new AppError(ErrorCode.SALES_BONUS_NO_RULE);

        // Progress is recomputed HERE, under the lock, on this connection.
        const [row] = await this.progress.rows({
          employeeIds: [employeeId],
          from: p,
          to: p,
          includeUntargeted: false,
          targets: [t],
          metrics: new Set<SalesMetric>([metric]),
          manager: m,
        });
        const rule = {
          type: t.bonusType,
          thresholdPct: t.bonusThresholdPct,
          amount: t.bonusAmount,
          percent: t.bonusPercent,
          currency: t.bonusCurrency,
        };
        const computed = computeBonus(rule, row.target ?? t.targetValue, row.achieved);
        const snapshot = {
          ...rule,
          thresholdMet: computed.thresholdMet,
          metricCurrency: row.currency,
          excludedCurrencies: row.excludedCurrencies,
        };
        const pct = storedAchievementPct(row.percentage);

        const inserted = (await m.query(
          `INSERT INTO sales_bonus_records
             (target_id, sales_user_id, period_month, metric, target_value,
              achieved_value, achievement_pct, rule_snapshot, bonus_amount, currency,
              status, computed_at, approved_by, approved_at)
           VALUES ($1::uuid, $2::uuid, $3::date, $4::varchar, $5::numeric,
                   $6::numeric, $7::numeric, $8::jsonb, $9::numeric, $10::char(3),
                   'approved', now(), $11::uuid, now())
           RETURNING id`,
          [
            t.id,
            employeeId,
            p.periodMonth,
            metric,
            t.targetValue,
            row.achieved,
            pct,
            JSON.stringify(snapshot),
            computed.amount,
            computed.currency,
            actorUserId,
          ],
        )) as Array<{ id: string }>;
        return {
          id: inserted[0].id,
          amount: computed.amount,
          currency: computed.currency,
          target: t.targetValue,
          achieved: row.achieved,
          pct,
          rule: snapshot,
        };
      });
    } catch (err) {
      // Backstop: the row lock already serializes approvals, the unique index guarantees it.
      if (isUniqueViolation(err)) {
        throw new AppError(ErrorCode.SALES_BONUS_EXISTS, { cause: err });
      }
      throw err;
    }

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_BONUS_APPROVED,
      userId: actorUserId,
      entityType: 'SalesBonusRecord',
      entityId: result.id,
      after: {
        employeeId,
        period,
        metric,
        amount: result.amount,
        currency: result.currency,
        targetValue: result.target,
        achievedValue: result.achieved,
        achievementPct: result.pct,
        rule: result.rule,
      },
    });
    return this.recordById(employeeId, result.id);
  }

  /** `approved → paid`. Bookkeeping only. */
  async markPaid(
    employeeId: string,
    bonusId: string,
    actorUserId: string,
  ): Promise<SalesBonusRecordItem> {
    await this.employees.requireEmployee(employeeId);
    // TypeORM's query() returns a `[rows, affectedCount]` TUPLE for UPDATE ... RETURNING.
    const [updated] = (await this.dataSource.query(
      `UPDATE sales_bonus_records
          SET status = 'paid', paid_marked_by = $3::uuid, paid_marked_at = now()
        WHERE id = $1::uuid AND sales_user_id = $2::uuid AND status = 'approved'
      RETURNING id, bonus_amount, currency, to_char(period_month, 'YYYY-MM') AS period, metric`,
      [bonusId, employeeId, actorUserId],
    )) as [
      Array<{
        id: string;
        bonus_amount: string;
        currency: string | null;
        period: string;
        metric: SalesMetric;
      }>,
      number,
    ];
    if (updated.length === 0) await this.explainMiss(employeeId, bonusId);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_BONUS_MARKED_PAID,
      userId: actorUserId,
      entityType: 'SalesBonusRecord',
      entityId: bonusId,
      before: { status: 'approved' },
      after: {
        status: 'paid',
        employeeId,
        period: updated[0].period,
        metric: updated[0].metric,
        amount: Number(updated[0].bonus_amount),
        currency: updated[0].currency ? updated[0].currency.trim() : null,
      },
    });
    return this.recordById(employeeId, bonusId);
  }

  /**
   * `approved | paid → void`, with a reason. Unlocks the target for a corrected
   * re-approval. Voiding a bonus that was already marked paid is allowed (a
   * mistaken mark has to be correctable) and is recorded as such in the audit log.
   */
  async voidBonus(
    employeeId: string,
    bonusId: string,
    dto: VoidSalesBonusDto,
    actorUserId: string,
  ): Promise<SalesBonusRecordItem> {
    const reason = dto.reason?.trim().slice(0, SALES_REASON_MAX);
    if (!reason) {
      throw new AppError(ErrorCode.SALES_REASON_REQUIRED, {
        message: 'A reason is required to void a bonus',
      });
    }

    const before = await this.dataSource.transaction(async (m) => {
      await this.employees.requireEmployee(employeeId, { manager: m });
      const rows = (await m.query(
        `SELECT id, status, bonus_amount, currency, to_char(period_month, 'YYYY-MM') AS period, metric
           FROM sales_bonus_records
          WHERE id = $1::uuid AND sales_user_id = $2::uuid
            FOR UPDATE`,
        [bonusId, employeeId],
      )) as Array<{
        id: string;
        status: SalesBonusStatusValue;
        bonus_amount: string;
        currency: string | null;
        period: string;
        metric: SalesMetric;
      }>;
      const row = rows[0];
      if (!row) throw new AppError(ErrorCode.SALES_BONUS_NOT_FOUND);
      if (row.status === 'void') {
        throw new AppError(ErrorCode.SALES_BONUS_STATE_CONFLICT, {
          publicContext: { status: row.status },
        });
      }
      await m.query(
        `UPDATE sales_bonus_records
            SET status = 'void', void_reason = $2::varchar,
                voided_by = $3::uuid, voided_at = now()
          WHERE id = $1::uuid`,
        [bonusId, reason, actorUserId],
      );
      return row;
    });

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_BONUS_VOIDED,
      userId: actorUserId,
      entityType: 'SalesBonusRecord',
      entityId: bonusId,
      before: { status: before.status },
      after: {
        status: 'void',
        reason,
        employeeId,
        period: before.period,
        metric: before.metric,
        amount: Number(before.bonus_amount),
        currency: before.currency ? before.currency.trim() : null,
        wasPaid: before.status === 'paid',
      },
    });
    return this.recordById(employeeId, bonusId);
  }

  // ─────────────────────────────── internals ─────────────────────────────── //

  private async recordById(
    employeeId: string,
    bonusId: string,
  ): Promise<SalesBonusRecordItem> {
    const rows = (await this.dataSource.query(
      `${RECORD_SELECT} WHERE b.id = $1::uuid AND b.sales_user_id = $2::uuid`,
      [bonusId, employeeId],
    )) as RecordRow[];
    if (!rows[0]) throw new AppError(ErrorCode.SALES_BONUS_NOT_FOUND);
    return toRecordItem(rows[0]);
  }

  /** A conditional transition matched no row: it does not exist here (404) or is in another state (409). */
  private async explainMiss(employeeId: string, bonusId: string): Promise<never> {
    const rows = (await this.dataSource.query(
      `SELECT status FROM sales_bonus_records
        WHERE id = $1::uuid AND sales_user_id = $2::uuid`,
      [bonusId, employeeId],
    )) as Array<{ status: SalesBonusStatusValue }>;
    if (!rows[0]) throw new AppError(ErrorCode.SALES_BONUS_NOT_FOUND);
    throw new AppError(ErrorCode.SALES_BONUS_STATE_CONFLICT, {
      publicContext: { status: rows[0].status },
    });
  }
}
