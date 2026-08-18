import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { UsageMetric } from './usage-metric';

/**
 * `tenant_metric_credits` — the MAINTAINED (not derived) prepaid-credit
 * balance per (tenant, metric), for the four metered `UsageMetric`s only
 * (plan §9). Purchased credits never expire and are spent only after the
 * plan's monthly allowance is exhausted — the composition with
 * `UsageService.incrementIfWithinLimit`'s `!applied` branch is Phase 1.4's
 * job, not this service's; this file is the standalone primitive.
 *
 * Accessed via raw SQL — no TypeORM entity, same reasoning as
 * `TenantEntitlementLedgerService` / `SettlementAdjustmentService`. Every
 * write is a SINGLE guarded SQL statement (a CTE where two columns must
 * move in lockstep), so the hot AI-token path stays a one-round-trip,
 * concurrency-safe primary-key hit — the same discipline
 * `UsageService.incrementIfWithinLimit`'s guarded `UPDATE ... WHERE`
 * already established (AD-10: no `SELECT ... FOR UPDATE` + separate write).
 *
 * All methods accept an optional `manager` to enlist in a caller's open
 * transaction; without one, the write commits on its own via the injected
 * `DataSource`.
 */

export interface CreditBalance {
  tenantId: string;
  metric: string;
  creditedUnits: number;
  debitedUnits: number;
  balanceUnits: number;
  updatedAt: Date;
}

interface CreditRow {
  tenantId: string;
  metric: string;
  credited_units: string;
  debited_units: string;
  balance_units: string;
  updated_at: Date;
}

function toBalance(row: CreditRow): CreditBalance {
  return {
    tenantId: row.tenantId,
    metric: row.metric,
    creditedUnits: Number(row.credited_units),
    debitedUnits: Number(row.debited_units),
    balanceUnits: Number(row.balance_units),
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class TenantMetricCreditsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * TypeORM's Postgres driver returns `[rows, affectedRowCount]` from
   * `.query()` for `UPDATE`/`DELETE` statements — even ones with
   * `RETURNING` — but a plain `rows` array for `INSERT`/`SELECT`
   * (`PostgresQueryRunner.query`: `result.raw = [raw.rows, raw.rowCount]`
   * only on `raw.command === 'UPDATE' | 'DELETE'`). Every method below that
   * issues a raw `UPDATE` must unwrap through this helper, or `rows[0]`
   * silently becomes the inner rows array instead of the first row and
   * every field read comes back `undefined`/`NaN` — confirmed against a
   * real Postgres connection while verifying this file; `grant`/`revoke`
   * in `TenantEntitlementLedgerService` and {@link credit} below are
   * `INSERT` statements and do NOT go through this (their `.query()` result
   * already is the plain rows array).
   */
  private async queryUpdateRows<T>(
    exec: DataSource | EntityManager,
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    const [rows] = (await exec.query(sql, params)) as [T[], number];
    return rows;
  }

  /**
   * Guarded debit — succeeds only if the current balance can cover the full
   * `amount`. `affected === 0` (no row matched the WHERE, whether because no
   * row exists yet or because the balance is insufficient) ⇒ `false`. This
   * is the "does the tenant have enough prepaid credit to fund one more
   * unit" question `UsageService.incrementIfWithinLimit`'s `!applied`
   * branch asks (Phase 1.4).
   */
  async tryDebit(
    tenantId: string,
    metric: UsageMetric,
    amount: number,
    manager?: EntityManager,
  ): Promise<boolean> {
    if (amount <= 0) return true;
    const exec = manager ?? this.dataSource;
    const rows = await this.queryUpdateRows<{ balance_units: string }>(
      exec,
      `UPDATE "tenant_metric_credits"
          SET debited_units = debited_units + $3,
              balance_units = balance_units - $3,
              updated_at = now()
        WHERE "tenantId" = $1 AND metric = $2 AND balance_units >= $3
        RETURNING balance_units`,
      [tenantId, metric, amount],
    );
    return rows.length > 0;
  }

  /**
   * Settle the REAL cost of a turn that was admitted on credit (plan §9 —
   * the AI-tokens settlement asymmetry: 1 unit is reserved via
   * {@link tryDebit} at admission, the true cost lands later, unguarded,
   * and can exceed the remaining balance). Debits at most the current
   * balance — `balance_units` can never go negative — and reports the
   * `overshootUnits` that could not be funded, so the caller can decide
   * whether to record it (e.g. via `TenantEntitlementLedgerService` with
   * `reason: 'consumption_overshoot'`). Overshoot is bounded by one turn —
   * the same bound plan quota already has via the unguarded `increment()`
   * on the same call sites.
   *
   * A single statement: the `before` CTE locks the row and captures its
   * PRE-update balance, so `LEAST`/`GREATEST` below compute against a
   * consistent snapshot rather than racing a separate read.
   */
  async settle(
    tenantId: string,
    metric: UsageMetric,
    amount: number,
    manager?: EntityManager,
  ): Promise<{ debitedUnits: number; overshootUnits: number }> {
    if (amount <= 0) return { debitedUnits: 0, overshootUnits: 0 };
    const exec = manager ?? this.dataSource;
    const rows = await this.queryUpdateRows<{ debited: string; overshoot: string }>(
      exec,
      `WITH before AS (
         SELECT balance_units FROM "tenant_metric_credits"
          WHERE "tenantId" = $1 AND metric = $2
          FOR UPDATE
       )
       UPDATE "tenant_metric_credits" t
          SET debited_units = t.debited_units + LEAST(before.balance_units, $3),
              balance_units = GREATEST(before.balance_units - $3, 0),
              updated_at = now()
         FROM before
        WHERE t."tenantId" = $1 AND t.metric = $2
        RETURNING LEAST(before.balance_units, $3) AS debited,
                  GREATEST($3 - before.balance_units, 0) AS overshoot`,
      [tenantId, metric, amount],
    );
    // No row: this metric was never credited, so nothing could be settled —
    // "shouldn't happen" (settle is only called after a successful
    // tryDebit), but treated as total overshoot rather than thrown, since
    // tokens were already spent with the provider and cannot be undone.
    if (rows.length === 0) return { debitedUnits: 0, overshootUnits: amount };
    return { debitedUnits: Number(rows[0].debited), overshootUnits: Number(rows[0].overshoot) };
  }

  /**
   * Reverse an UNUSED reservation taken by {@link tryDebit} (the release
   * counterpart — e.g. the AI provider call failed after admission). Only
   * ever gives back what was ACTUALLY debited: both column movements are
   * computed from the SAME pre-update `debited_units` snapshot via
   * `LEAST`, so a duplicate/late call is a harmless no-op (the second call
   * sees `debited_units` already at its floor and adds back 0) rather than
   * inflating `balance_units` past what was really reserved — the
   * `balance = credited − debited` invariant is never at risk, unlike a
   * naive unconditional `balance_units += amount`.
   */
  async refundReservation(
    tenantId: string,
    metric: UsageMetric,
    amount: number,
    manager?: EntityManager,
  ): Promise<number> {
    if (amount <= 0) return 0;
    const exec = manager ?? this.dataSource;
    const rows = await this.queryUpdateRows<{ refunded: string }>(
      exec,
      `WITH before AS (
         SELECT debited_units FROM "tenant_metric_credits"
          WHERE "tenantId" = $1 AND metric = $2
          FOR UPDATE
       )
       UPDATE "tenant_metric_credits" t
          SET debited_units = GREATEST(before.debited_units - $3, 0),
              balance_units = balance_units + LEAST(before.debited_units, $3),
              updated_at = now()
         FROM before
        WHERE t."tenantId" = $1 AND t.metric = $2
        RETURNING LEAST(before.debited_units, $3) AS refunded`,
      [tenantId, metric, amount],
    );
    return rows.length === 0 ? 0 : Number(rows[0].refunded);
  }

  /**
   * Purchase grant — increases both `credited_units` and `balance_units`.
   * Upserts via the established `INSERT ... ON CONFLICT DO UPDATE ...
   * RETURNING` atomic-counter idiom (see `InvoiceService.nextInvoiceNumber`
   * in `payments/invoice.service.ts`), since a tenant's first-ever credit
   * purchase for a metric has no row yet.
   */
  async credit(
    tenantId: string,
    metric: UsageMetric,
    amount: number,
    manager?: EntityManager,
  ): Promise<CreditBalance> {
    if (amount <= 0) {
      throw new Error(
        `TenantMetricCreditsService.credit: amount must be > 0 (got ${amount})`,
      );
    }
    const exec = manager ?? this.dataSource;
    const rows: CreditRow[] = await exec.query(
      `INSERT INTO "tenant_metric_credits" ("tenantId", metric, credited_units, balance_units)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT ("tenantId", metric) DO UPDATE
         SET credited_units = "tenant_metric_credits".credited_units + $3,
             balance_units = "tenant_metric_credits".balance_units + $3,
             updated_at = now()
       RETURNING "tenantId", metric, credited_units, debited_units, balance_units, updated_at`,
      [tenantId, metric, amount],
    );
    return toBalance(rows[0]);
  }

  /**
   * Refund clawback (plan §14) — decreases `credited_units` and floors
   * `balance_units` at 0. Returns the amount ACTUALLY clawed back from the
   * balance vs. the shortfall (already-consumed credit that cannot be
   * recovered), so the caller can record the shortfall as
   * `unrecoverableUnits` on the paired ledger `revoke` row.
   *
   * `debited_units` is deliberately NEVER touched here — it is a historical
   * record of consumption that a later refund cannot undo. This means
   * `credited_units` can end up BELOW `debited_units` after a clawback on
   * already-spent credit (the "fully used" / "partly used" scenarios): the
   * three columns' true reconciliation invariant is
   * `balance_units === GREATEST(credited_units - debited_units, 0)`, not an
   * unfloored equality — `balance_units`' own CHECK constraint enforces the
   * same floor at the DB level.
   */
  async revoke(
    tenantId: string,
    metric: UsageMetric,
    amount: number,
    manager?: EntityManager,
  ): Promise<{ clawedBackUnits: number; unrecoverableUnits: number }> {
    if (amount <= 0) return { clawedBackUnits: 0, unrecoverableUnits: 0 };
    const exec = manager ?? this.dataSource;
    const rows = await this.queryUpdateRows<{ clawed_back: string; unrecoverable: string }>(
      exec,
      `WITH before AS (
         SELECT balance_units FROM "tenant_metric_credits"
          WHERE "tenantId" = $1 AND metric = $2
          FOR UPDATE
       )
       UPDATE "tenant_metric_credits" t
          SET credited_units = GREATEST(t.credited_units - $3, 0),
              balance_units = GREATEST(before.balance_units - $3, 0),
              updated_at = now()
         FROM before
        WHERE t."tenantId" = $1 AND t.metric = $2
        RETURNING LEAST(before.balance_units, $3) AS clawed_back,
                  GREATEST($3 - before.balance_units, 0) AS unrecoverable`,
      [tenantId, metric, amount],
    );
    if (rows.length === 0) return { clawedBackUnits: 0, unrecoverableUnits: amount };
    return {
      clawedBackUnits: Number(rows[0].clawed_back),
      unrecoverableUnits: Number(rows[0].unrecoverable),
    };
  }

  /** Every credit balance row for a tenant, keyed by metric. */
  async balanceMap(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Map<string, CreditBalance>> {
    const exec = manager ?? this.dataSource;
    const rows: CreditRow[] = await exec.query(
      `SELECT "tenantId", metric, credited_units, debited_units, balance_units, updated_at
         FROM "tenant_metric_credits"
        WHERE "tenantId" = $1`,
      [tenantId],
    );
    return new Map(rows.map((r) => [r.metric, toBalance(r)]));
  }
}
