import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { SettlementStatus } from '../../entities/enums';

/**
 * Clawback / settlement-adjustment ledger (R1). When a refund is finalized on a
 * payment that has already been claimed into a settlement batch (IN_BATCH) or
 * settled (SETTLED), we cannot mutate that batch — instead we append an OPEN
 * adjustment. The next settlement run claims OPEN adjustments and subtracts them
 * from the net, so cumulative settled = collected − refunded − fees regardless of
 * refund timing (deterministic). Backed by the `settlement_adjustments` table
 * (created by PaymentsSchemaBootstrap / migration); accessed via raw SQL so it
 * carries no TypeORM entity (avoids dev `synchronize` churn).
 *
 * All methods take the caller's EntityManager so they enlist in the open tx.
 */
@Injectable()
export class SettlementAdjustmentService {
  /** Record a clawback when (and only when) the payment was already in a batch. */
  async recordClawbackIfSettled(
    manager: EntityManager,
    tenantId: string,
    paymentId: string,
    settlementStatus: SettlementStatus,
    amountCents: number,
    refundId?: string,
  ): Promise<void> {
    if (amountCents <= 0) return;
    if (
      settlementStatus !== SettlementStatus.IN_BATCH &&
      settlementStatus !== SettlementStatus.SETTLED
    ) {
      return; // still UNSETTLED → the refund will be netted at settlement time
    }
    await manager.query(
      `INSERT INTO settlement_adjustments
         (id, tenant_id, payment_id, refund_id, origin_settlement_id, amount_cents, reason, status)
       VALUES ($1,$2,$3,$4,
         (SELECT settlement_id FROM settlement_items WHERE payment_id = $3 LIMIT 1),
         $5,$6,'OPEN')`,
      [randomUUID(), tenantId, paymentId, refundId ?? null, amountCents, 'Refund after settlement'],
    );
  }

  /** Lock the tenant's OPEN adjustments for this settlement run (SKIP LOCKED → no double-apply). */
  async lockOpen(
    manager: EntityManager,
    tenantId: string,
  ): Promise<{ ids: string[]; totalCents: number }> {
    const rows: Array<{ id: string; amount_cents: string }> = await manager.query(
      `SELECT id, amount_cents FROM settlement_adjustments
       WHERE tenant_id = $1 AND status = 'OPEN'
       FOR UPDATE SKIP LOCKED`,
      [tenantId],
    );
    return {
      ids: rows.map((r) => r.id),
      totalCents: rows.reduce((c, r) => c + Number(r.amount_cents), 0),
    };
  }

  /** Mark the claimed adjustments APPLIED against the generated settlement. */
  async markApplied(
    manager: EntityManager,
    ids: string[],
    settlementId: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await manager.query(
      `UPDATE settlement_adjustments
       SET status = 'APPLIED', applied_settlement_id = $2
       WHERE id = ANY($1)`,
      [ids, settlementId],
    );
  }
}
