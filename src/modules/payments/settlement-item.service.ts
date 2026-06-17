import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { SettlementItem } from '../../entities/Payments/SettlementItem';

/**
 * Settlement ↔ payment mapping (`settlement_items`, composite PK).
 *
 * This join entity has NO tenant column, so it is tenant-scoped THROUGH its
 * parent settlement: callers must verify the settlement belongs to the tenant
 * (SettlementService does) before mapping or listing items. Listing filters by
 * the explicit `settlement_id` primary column — never a raw FK string.
 */
@Injectable()
export class SettlementItemService {
  constructor(
    @InjectRepository(SettlementItem)
    private readonly items: Repository<SettlementItem>,
  ) {}

  async mapPayments(
    settlementId: string,
    paymentIds: string[],
    manager?: EntityManager,
  ): Promise<void> {
    if (paymentIds.length === 0) return;
    const em = manager ?? this.items.manager;
    // Single batched INSERT (no per-row round-trips). This entity carries BOTH a
    // composite PK (settlement_id/payment_id) AND relation FK columns
    // (settlementId/paymentId) — TypeORM's QueryBuilder can't reliably populate
    // both, so we write all four explicitly via parameterized SQL. The relation
    // columns must be set so the detail read (which joins `payment`) works.
    // ON CONFLICT keeps it idempotent if a pair is already mapped.
    const params: unknown[] = [settlementId, ...paymentIds];
    const rows = paymentIds
      .map((_, i) => {
        const p = `$${i + 2}`;
        return `($1, ${p}, $1, ${p})`;
      })
      .join(', ');
    await em.query(
      `INSERT INTO settlement_items (settlement_id, payment_id, "settlementId", "paymentId")
       VALUES ${rows}
       ON CONFLICT (settlement_id, payment_id) DO NOTHING`,
      params,
    );
  }

  /** Items for a settlement (the settlement is tenant-verified by the caller). */
  listForSettlement(
    settlementId: string,
    manager?: EntityManager,
  ): Promise<SettlementItem[]> {
    const repo = manager ? manager.getRepository(SettlementItem) : this.items;
    return repo.find({
      where: { settlement_id: settlementId },
      relations: { payment: true },
    });
  }
}
