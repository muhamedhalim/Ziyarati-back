import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { UsageMetric, ResourceMetric } from './usage-metric';
import { SellableKind } from '../resource-pricing/sellable-resource.registry';

/**
 * `tenant_entitlement_ledger` — append-only capacity/credit audit trail
 * (plan §16, migration `1730043000000-ResourcePricingCatalog`). Positive
 * magnitude + `direction`, mirroring `settlement_adjustments`' house
 * pattern: nothing is ever UPDATEd or DELETEd, a reversal is an opposite
 * row. Accessed via raw SQL — no TypeORM entity, the same choice
 * `SettlementAdjustmentService` made for the same reason (avoids dev
 * `synchronize` churn on an append-only table nothing else needs to load
 * via the ORM's relation graph).
 *
 * This table is the AUDIT record for both `credit` and `capacity` items.
 * For `capacity` items it is also the SOURCE OF TRUTH for the effective
 * limit ({@link capacityMap}). For `credit` items the OPERATIONAL balance
 * lives in `tenant_metric_credits` (`TenantMetricCreditsService`) — a grant
 * here and a credit there are two halves of the same purchase event,
 * composed by the caller (Phase 2.3's `ResourceEntitlementListener`), not
 * by this service.
 *
 * All methods accept an optional `manager` so a caller can enlist the write
 * in its own open transaction (e.g. alongside marking a purchase
 * `completed`); without one, the write commits on its own via the injected
 * `DataSource`.
 */

export const LEDGER_DIRECTION = {
  GRANT: 'grant',
  REVOKE: 'revoke',
} as const;
export type LedgerDirection = (typeof LEDGER_DIRECTION)[keyof typeof LEDGER_DIRECTION];

/** Mirrors migration 1730043000000's `reason varchar(32)` comment exactly. */
export const LEDGER_REASON = {
  PURCHASE: 'purchase',
  REFUND: 'refund',
  ADMIN_GRANT: 'admin_grant',
  ADMIN_REVOKE: 'admin_revoke',
  CONSUMPTION_OVERSHOOT: 'consumption_overshoot',
} as const;
export type LedgerReason = (typeof LEDGER_REASON)[keyof typeof LEDGER_REASON];

export type LedgerMetric = UsageMetric | ResourceMetric;

export interface LedgerEntry {
  id: string;
  tenantId: string;
  metric: string;
  kind: SellableKind;
  direction: LedgerDirection;
  amountUnits: number;
  unrecoverableUnits: number;
  reason: LedgerReason;
  sourcePurchaseId: string | null;
  sourceRefundId: string | null;
  actorId: string | null;
  note: string | null;
  createdAt: Date;
}

interface GrantParams {
  tenantId: string;
  metric: LedgerMetric;
  kind: SellableKind;
  amountUnits: number;
  reason: LedgerReason;
  sourcePurchaseId?: string;
  actorId?: string;
  note?: string;
  manager?: EntityManager;
}

interface RevokeParams {
  tenantId: string;
  metric: LedgerMetric;
  kind: SellableKind;
  amountUnits: number;
  reason: LedgerReason;
  sourceRefundId?: string;
  /** Portion of `amountUnits` that could not actually be clawed back because
   *  it was already consumed (plan §14 — "partly used" / "fully used"). */
  unrecoverableUnits?: number;
  actorId?: string;
  note?: string;
  manager?: EntityManager;
}

interface LedgerRow {
  id: string;
  tenantId: string;
  metric: string;
  kind: string;
  direction: string;
  amount_units: string;
  unrecoverable_units: string;
  reason: string;
  sourcePurchaseId: string | null;
  sourceRefundId: string | null;
  actorId: string | null;
  note: string | null;
  created_at: Date;
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    metric: row.metric,
    kind: row.kind as SellableKind,
    direction: row.direction as LedgerDirection,
    amountUnits: Number(row.amount_units),
    unrecoverableUnits: Number(row.unrecoverable_units),
    reason: row.reason as LedgerReason,
    sourcePurchaseId: row.sourcePurchaseId,
    sourceRefundId: row.sourceRefundId,
    actorId: row.actorId,
    note: row.note,
    createdAt: row.created_at,
  };
}

@Injectable()
export class TenantEntitlementLedgerService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Append a `grant` row. Throws (Postgres 23505) on a second grant for the
   * same `sourcePurchaseId` — the DB backstop behind
   * `UQ_tenant_entitlement_ledger_source_purchase` — deliberately NOT
   * swallowed here: redelivery idempotency belongs to the caller (the
   * listener that already knows how to recognize "already applied" and
   * return cleanly), not silently absorbed by this data-access layer.
   */
  async grant(params: GrantParams): Promise<LedgerEntry> {
    if (params.amountUnits <= 0) {
      throw new Error(
        `TenantEntitlementLedgerService.grant: amountUnits must be > 0 (got ${params.amountUnits})`,
      );
    }
    const exec = params.manager ?? this.dataSource;
    const rows: LedgerRow[] = await exec.query(
      `INSERT INTO "tenant_entitlement_ledger"
         ("tenantId","metric","kind","direction","amount_units","reason","sourcePurchaseId","actorId","note")
       VALUES ($1,$2,$3,'grant',$4,$5,$6,$7,$8)
       RETURNING id,"tenantId",metric,kind,direction,amount_units,unrecoverable_units,reason,"sourcePurchaseId","sourceRefundId","actorId",note,created_at`,
      [
        params.tenantId,
        params.metric,
        params.kind,
        params.amountUnits,
        params.reason,
        params.sourcePurchaseId ?? null,
        params.actorId ?? null,
        params.note ?? null,
      ],
    );
    return toEntry(rows[0]);
  }

  /**
   * Append a `revoke` row (opposite entry — the grant row is never touched).
   * Throws (Postgres 23505) on a second revoke for the same
   * `sourceRefundId` — `UQ_tenant_entitlement_ledger_source_refund` — same
   * "caller owns redelivery idempotency" reasoning as {@link grant}.
   */
  async revoke(params: RevokeParams): Promise<LedgerEntry> {
    if (params.amountUnits <= 0) {
      throw new Error(
        `TenantEntitlementLedgerService.revoke: amountUnits must be > 0 (got ${params.amountUnits})`,
      );
    }
    const unrecoverable = params.unrecoverableUnits ?? 0;
    if (unrecoverable < 0 || unrecoverable > params.amountUnits) {
      throw new Error(
        `TenantEntitlementLedgerService.revoke: unrecoverableUnits (${unrecoverable}) must be between 0 and amountUnits (${params.amountUnits})`,
      );
    }
    const exec = params.manager ?? this.dataSource;
    const rows: LedgerRow[] = await exec.query(
      `INSERT INTO "tenant_entitlement_ledger"
         ("tenantId","metric","kind","direction","amount_units","unrecoverable_units","reason","sourceRefundId","actorId","note")
       VALUES ($1,$2,$3,'revoke',$4,$5,$6,$7,$8,$9)
       RETURNING id,"tenantId",metric,kind,direction,amount_units,unrecoverable_units,reason,"sourcePurchaseId","sourceRefundId","actorId",note,created_at`,
      [
        params.tenantId,
        params.metric,
        params.kind,
        params.amountUnits,
        unrecoverable,
        params.reason,
        params.sourceRefundId ?? null,
        params.actorId ?? null,
        params.note ?? null,
      ],
    );
    return toEntry(rows[0]);
  }

  /**
   * Effective CAPACITY per metric — `GREATEST(SUM(grant − revoke), 0)`
   * (plan §16), `kind = 'capacity'` only. `credit` items are NOT summed
   * here; their operational balance is `TenantMetricCreditsService`'s
   * maintained `balance_units`, not a ledger derivation.
   */
  async capacityMap(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Map<string, number>> {
    const exec = manager ?? this.dataSource;
    const rows: Array<{ metric: string; capacity: string }> = await exec.query(
      `SELECT metric,
              GREATEST(SUM(CASE direction WHEN 'grant' THEN amount_units ELSE -amount_units END), 0) AS capacity
         FROM "tenant_entitlement_ledger"
        WHERE "tenantId" = $1 AND kind = 'capacity'
        GROUP BY metric`,
      [tenantId],
    );
    return new Map(rows.map((r) => [r.metric, Number(r.capacity)]));
  }
}
