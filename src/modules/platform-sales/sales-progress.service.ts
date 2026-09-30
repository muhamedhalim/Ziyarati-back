import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { SALES_METRIC } from '../../entities/Sales/SalesTarget';
import type {
  SalesBonusType,
  SalesMetric,
} from '../../entities/Sales/SalesTarget';
import { SettingKey } from '../platform/settings.registry';
import { SETTINGS_REGISTRY } from '../platform/settings.registry';
import { SystemSettingService } from '../platform/system-setting.service';

import { parseSalesPeriod } from './sales-period.util';
import type { SalesPeriod } from './sales-period.util';
import { salesProgress } from './sales-progress.util';
import type { SalesMetricRow } from './sales.types';

/** A stored target, as read by `loadTargets`. */
export interface SalesTargetRecord {
  id: string;
  salesUserId: string;
  /** 'YYYY-MM' */
  period: string;
  metric: SalesMetric;
  targetValue: number;
  currency: string | null;
  bonusType: SalesBonusType;
  bonusThresholdPct: number | null;
  bonusAmount: number | null;
  bonusPercent: number | null;
  bonusCurrency: string | null;
  version: number;
  updatedAt: string | null;
  /** A non-void bonus record exists for this target. */
  locked: boolean;
}

interface TargetRow {
  id: string;
  sales_user_id: string;
  period: string;
  metric: SalesMetric;
  target_value: string;
  currency: string | null;
  bonus_type: SalesBonusType;
  bonus_threshold_pct: string | null;
  bonus_amount: string | null;
  bonus_percent: string | null;
  bonus_currency: string | null;
  version: number;
  updated_at: Date | string | null;
  locked: boolean;
}

interface CountRow {
  uid: string;
  period: string;
  n: number;
}
interface RevenueRow {
  uid: string;
  period: string;
  currency: string;
  amount: string;
}

const num = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : Number(v);

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/** Achieved values keyed by employee, month and metric (revenue also by currency). */
export class SalesAchieved {
  private readonly counts = new Map<string, number>();
  private readonly revenue = new Map<string, Map<string, number>>();

  static key(uid: string, period: string, metric: SalesMetric): string {
    return `${uid}|${period}|${metric}`;
  }

  setCount(uid: string, period: string, metric: SalesMetric, n: number): void {
    this.counts.set(SalesAchieved.key(uid, period, metric), n);
  }

  addRevenue(uid: string, period: string, currency: string, amount: number): void {
    const k = SalesAchieved.key(uid, period, 'subscription_revenue');
    const m = this.revenue.get(k) ?? new Map<string, number>();
    m.set(currency, (m.get(currency) ?? 0) + amount);
    this.revenue.set(k, m);
  }

  count(uid: string, period: string, metric: SalesMetric): number {
    return this.counts.get(SalesAchieved.key(uid, period, metric)) ?? 0;
  }

  /** Revenue collected in each currency. */
  revenueByCurrency(uid: string, period: string): Map<string, number> {
    return (
      this.revenue.get(SalesAchieved.key(uid, period, 'subscription_revenue')) ??
      new Map()
    );
  }
}

/**
 * Turns targets into progress.
 *
 * Achieved values are computed with ONE grouped query per metric for the
 * whole set of employees and months requested — never a query per employee or
 * per month — so the cost of a list page or a 24-month range does not grow
 * with its size.
 *
 * ATTRIBUTION (all UTC calendar months, half-open `[start, end)`):
 *  - `new_clinics`: `acquired` assignments created in the month, for a clinic
 *    that is not deleted or rejected. Credit stays with the acquiring rep even
 *    after a later reassignment.
 *  - `subscription_revenue`: PAID invoices whose `paid_at` is in the month,
 *    credited to whoever owned the clinic AT `paid_at`.
 *  - `paid_conversions`: clinics whose FIRST-EVER PAID invoice is in the month,
 *    credited to whoever owned the clinic at that instant.
 *
 * Ownership windows are half-open too (`assigned_at <= t < ended_at`), and a
 * reassignment closes one row and opens the next with the same timestamp, so
 * an invoice can never be credited to two employees.
 */
@Injectable()
export class SalesProgressService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: SystemSettingService,
  ) {}

  /** Currencies a revenue target / bonus may use (the platform's billing currencies). */
  allowedCurrencies(): string[] {
    const def = SETTINGS_REGISTRY[SettingKey.DEFAULT_CURRENCY] as {
      allowedValues?: readonly string[];
    };
    return [...(def.allowedValues ?? ['SAR'])];
  }

  async defaultCurrency(): Promise<string> {
    return String(
      await this.settings.getTyped<string>(SettingKey.DEFAULT_CURRENCY),
    ).toUpperCase();
  }

  // ─────────────────────────────── targets ─────────────────────────────── //

  /** Targets of these employees for the months in `[from, to]` — one query. */
  async loadTargets(
    employeeIds: readonly string[],
    from: SalesPeriod,
    to: SalesPeriod,
  ): Promise<SalesTargetRecord[]> {
    if (employeeIds.length === 0) return [];
    const rows = (await this.dataSource.query(
      `${TARGET_SELECT}
        WHERE t.sales_user_id = ANY($1::uuid[])
          AND t.period_month >= $2::date AND t.period_month <= $3::date`,
      [[...employeeIds], from.periodMonth, to.periodMonth],
    )) as TargetRow[];
    return rows.map(toRecord);
  }

  /**
   * Every target of the team for one month. `activeOnly` drops deactivated
   * employees — used for a month that is still open, so a rep who left does
   * not inflate the team's target.
   */
  async loadTeamTargets(
    period: SalesPeriod,
    activeOnly: boolean,
  ): Promise<SalesTargetRecord[]> {
    const rows = (await this.dataSource.query(
      `${TARGET_SELECT}
        INNER JOIN users u ON u.id = t.sales_user_id
                          AND u."tenantId" IS NULL AND u.deleted_at IS NULL
        WHERE t.period_month = $1::date
          AND ($2::boolean = false OR u.is_active)`,
      [period.periodMonth, activeOnly],
    )) as TargetRow[];
    return rows.map(toRecord);
  }

  // ─────────────────────────────── achieved ────────────────────────────── //

  /**
   * Achieved values for `employeeIds` over `[from, to]`, computing only the
   * metrics in `metrics`. Each metric is exactly one query.
   */
  async achieved(
    employeeIds: readonly string[],
    from: SalesPeriod,
    to: SalesPeriod,
    metrics: ReadonlySet<SalesMetric>,
    manager?: EntityManager,
  ): Promise<SalesAchieved> {
    const runner = manager ?? this.dataSource;
    const out = new SalesAchieved();
    if (employeeIds.length === 0 || metrics.size === 0) return out;
    const ids = [...employeeIds];
    const start = from.start.toISOString();
    const end = to.end.toISOString();

    await Promise.all([
      metrics.has('new_clinics')
        ? runner
            .query(
              `SELECT a.sales_user_id AS uid,
                      to_char(a.assigned_at AT TIME ZONE 'UTC', 'YYYY-MM') AS period,
                      COUNT(*)::int AS n
                 FROM sales_clinic_assignments a
                INNER JOIN tenants t ON t.id = a.tenant_id
                                    AND t.deleted_at IS NULL
                                    AND t.approval_status <> 'REJECTED'
                WHERE a.sales_user_id = ANY($1::uuid[])
                  AND a.kind = 'acquired'
                  AND a.assigned_at >= $2::timestamptz AND a.assigned_at < $3::timestamptz
                GROUP BY 1, 2`,
              [ids, start, end],
            )
            .then((rows: CountRow[]) => {
              for (const r of rows) out.setCount(r.uid, r.period, 'new_clinics', r.n);
            })
        : undefined,

      metrics.has('subscription_revenue')
        ? runner
            .query(
              `SELECT a.sales_user_id AS uid,
                      to_char(i.paid_at AT TIME ZONE 'UTC', 'YYYY-MM') AS period,
                      i.currency AS currency,
                      SUM(i.amount) AS amount
                 FROM sales_clinic_assignments a
                INNER JOIN subscription_invoices i
                        ON i.tenant_id = a.tenant_id::text AND i.status = 'PAID'
                       AND i.paid_at >= $2::timestamptz AND i.paid_at < $3::timestamptz
                       AND i.paid_at >= a.assigned_at
                       AND (a.ended_at IS NULL OR i.paid_at < a.ended_at)
                WHERE a.sales_user_id = ANY($1::uuid[])
                  AND a.assigned_at < $3::timestamptz
                  AND (a.ended_at IS NULL OR a.ended_at > $2::timestamptz)
                GROUP BY 1, 2, 3`,
              [ids, start, end],
            )
            .then((rows: RevenueRow[]) => {
              for (const r of rows) {
                out.addRevenue(r.uid, r.period, r.currency, Number(r.amount));
              }
            })
        : undefined,

      metrics.has('paid_conversions')
        ? runner
            .query(
              `SELECT a.sales_user_id AS uid,
                      to_char(fp.first_at AT TIME ZONE 'UTC', 'YYYY-MM') AS period,
                      COUNT(DISTINCT a.tenant_id)::int AS n
                 FROM sales_clinic_assignments a
                INNER JOIN LATERAL (
                        SELECT MIN(i.paid_at) AS first_at
                          FROM subscription_invoices i
                         WHERE i.tenant_id = a.tenant_id::text AND i.status = 'PAID'
                      ) fp ON true
                WHERE a.sales_user_id = ANY($1::uuid[])
                  AND a.assigned_at < $3::timestamptz
                  AND (a.ended_at IS NULL OR a.ended_at > $2::timestamptz)
                  AND fp.first_at >= $2::timestamptz AND fp.first_at < $3::timestamptz
                  AND fp.first_at >= a.assigned_at
                  AND (a.ended_at IS NULL OR fp.first_at < a.ended_at)
                GROUP BY 1, 2`,
              [ids, start, end],
            )
            .then((rows: CountRow[]) => {
              for (const r of rows) out.setCount(r.uid, r.period, 'paid_conversions', r.n);
            })
        : undefined,
    ]);
    return out;
  }

  // ─────────────────────────────── assembly ────────────────────────────── //

  /**
   * One row per (employee, month, metric) that has a target — plus, when
   * `includeUntargeted` is set, a row for every metric of every requested
   * employee/month (progress without a target, for the details page).
   *
   * Query cost: 1 (targets) + 1 per computed metric, regardless of size.
   */
  async rows(opts: {
    employeeIds: readonly string[];
    from: SalesPeriod;
    to: SalesPeriod;
    includeUntargeted: boolean;
    /** Restrict the computed metrics (default: every metric / every targeted metric). */
    metrics?: ReadonlySet<SalesMetric>;
    now?: Date;
    /** Pre-loaded targets (skips the targets query). */
    targets?: SalesTargetRecord[];
    /** Read through this transaction's connection instead of taking another one from the pool. */
    manager?: EntityManager;
  }): Promise<SalesMetricRow[]> {
    const now = opts.now ?? new Date();
    const targets =
      opts.targets ??
      (await this.loadTargets(opts.employeeIds, opts.from, opts.to));

    const wanted = opts.metrics ?? new Set<SalesMetric>(SALES_METRIC);
    const needed = opts.includeUntargeted
      ? new Set<SalesMetric>(wanted)
      : new Set<SalesMetric>(targets.map((t) => t.metric));
    const uids = opts.includeUntargeted
      ? [...opts.employeeIds]
      : [...new Set(targets.map((t) => t.salesUserId))];
    const [achieved, defaultCurrency] = await Promise.all([
      this.achieved(uids, opts.from, opts.to, needed, opts.manager),
      opts.includeUntargeted || targets.some((t) => t.metric === 'subscription_revenue')
        ? this.defaultCurrency()
        : Promise.resolve('SAR'),
    ]);

    const byKey = new Map(
      targets.map((t) => [`${t.salesUserId}|${t.period}|${t.metric}`, t]),
    );
    const rows: SalesMetricRow[] = [];
    const periods = opts.includeUntargeted
      ? monthsOf(opts.from, opts.to)
      : [...new Set(targets.map((t) => t.period))].map(parseSalesPeriod);

    for (const uid of uids) {
      for (const p of periods) {
        for (const metric of SALES_METRIC) {
          if (!wanted.has(metric)) continue;
          const t = byKey.get(`${uid}|${p.period}|${metric}`);
          if (!t && !opts.includeUntargeted) continue;
          rows.push(
            this.buildRow(uid, p, metric, t ?? null, achieved, defaultCurrency, now),
          );
        }
      }
    }
    return rows;
  }

  private buildRow(
    uid: string,
    period: SalesPeriod,
    metric: SalesMetric,
    t: SalesTargetRecord | null,
    achieved: SalesAchieved,
    defaultCurrency: string,
    now: Date,
  ): SalesMetricRow {
    let value: number;
    let currency: string | null = null;
    let excluded: Array<{ currency: string; amount: number }> = [];

    if (metric === 'subscription_revenue') {
      currency = t?.currency ?? defaultCurrency;
      const byCurrency = achieved.revenueByCurrency(uid, period.period);
      value = round2(byCurrency.get(currency) ?? 0);
      excluded = [...byCurrency.entries()]
        .filter(([c, amount]) => c !== currency && amount > 0)
        .map(([c, amount]) => ({ currency: c, amount: round2(amount) }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
    } else {
      value = achieved.count(uid, period.period, metric);
    }

    const progress = salesProgress(t ? t.targetValue : null, value, period, now);
    return {
      employeeId: uid,
      metric,
      period: period.period,
      targetId: t?.id ?? null,
      version: t?.version ?? null,
      target: progress.target,
      currency,
      achieved: value,
      remaining: progress.remaining,
      percentage: progress.percentage,
      isCompleted: progress.isCompleted,
      expectedPercentage: progress.expectedPercentage,
      onTrack: progress.onTrack,
      bonusRule:
        t && t.bonusType !== 'none'
          ? {
              type: t.bonusType,
              thresholdPct: t.bonusThresholdPct,
              amount: t.bonusAmount,
              percent: t.bonusPercent,
              currency: t.bonusCurrency,
            }
          : null,
      locked: t?.locked ?? false,
      excludedCurrencies: excluded,
      updatedAt: t?.updatedAt ?? null,
    };
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function monthsOf(from: SalesPeriod, to: SalesPeriod): SalesPeriod[] {
  const out: SalesPeriod[] = [];
  let y = from.start.getUTCFullYear();
  let m = from.start.getUTCMonth();
  const endY = to.start.getUTCFullYear();
  const endM = to.start.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push(parseSalesPeriod(`${y}-${String(m + 1).padStart(2, '0')}`));
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

const TARGET_SELECT = `SELECT t.id, t.sales_user_id,
       to_char(t.period_month, 'YYYY-MM') AS period,
       t.metric, t.target_value, t.currency, t.bonus_type,
       t.bonus_threshold_pct, t.bonus_amount, t.bonus_percent, t.bonus_currency,
       t.version, t.updated_at,
       EXISTS (SELECT 1 FROM sales_bonus_records b
                WHERE b.target_id = t.id AND b.status <> 'void') AS locked
  FROM sales_targets t`;

function toRecord(r: TargetRow): SalesTargetRecord {
  return {
    id: r.id,
    salesUserId: r.sales_user_id,
    period: r.period,
    metric: r.metric,
    targetValue: Number(r.target_value),
    currency: r.currency ? r.currency.trim() : null,
    bonusType: r.bonus_type,
    bonusThresholdPct: num(r.bonus_threshold_pct),
    bonusAmount: num(r.bonus_amount),
    bonusPercent: num(r.bonus_percent),
    bonusCurrency: r.bonus_currency ? r.bonus_currency.trim() : null,
    version: r.version,
    updatedAt: iso(r.updated_at),
    locked: r.locked,
  };
}
