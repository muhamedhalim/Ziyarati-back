import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { SettlementItem } from '../../entities/Payments/SettlementItem';
import { Settlement } from '../../entities/Payments/Settlement';
import { Payment } from '../../entities/Payments/Payment';

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

  mapPayments(
    settlementId: string,
    paymentIds: string[],
    manager?: EntityManager,
  ): Promise<SettlementItem[]> {
    const repo = manager ? manager.getRepository(SettlementItem) : this.items;
    const rows = paymentIds.map((paymentId) =>
      repo.create({
        settlement_id: settlementId,
        payment_id: paymentId,
        settlement: { id: settlementId } as Settlement,
        payment: { id: paymentId } as Payment,
      }),
    );
    return repo.save(rows);
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
