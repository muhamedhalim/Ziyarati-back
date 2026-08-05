import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { InvoiceItem } from '../../entities/Payments/InvoiceItem';
import { Invoice } from '../../entities/Payments/Invoice';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { InvoiceItemInputDto } from './dto/add-invoice-item.dto';
import { round2 } from './payments.constants';

/**
 * Invoice line items (`invoice_items`).
 *
 * Tenant-scoped via the `tenant` relation; items also belong to a parent invoice.
 * `total_price` is always computed server-side (quantity × unit_price) — clients
 * never set it. The parent invoice total is recomputed from its items.
 *
 * Note: the Invoice entity has no inverse `items` relation, so items are queried
 * directly here (by the `invoice` relation), keeping the frozen schema untouched.
 */
@Injectable()
export class InvoiceItemService {
  constructor(
    @InjectRepository(InvoiceItem)
    private readonly items: Repository<InvoiceItem>,
  ) {}

  addItems(
    tenantId: string,
    invoiceId: string,
    inputs: InvoiceItemInputDto[],
    manager?: EntityManager,
  ): Promise<InvoiceItem[]> {
    const repo = manager ? manager.getRepository(InvoiceItem) : this.items;
    const rows = inputs.map((input) =>
      repo.create({
        invoice: { id: invoiceId } as Invoice,
        tenant: { id: tenantId } as Tenant,
        description: input.description,
        quantity: input.quantity,
        unit_price: input.unitPrice,
        total_price: round2(Number(input.unitPrice) * Number(input.quantity)),
      }),
    );
    return repo.save(rows);
  }

  listForInvoice(
    tenantId: string,
    invoiceId: string,
    manager?: EntityManager,
  ): Promise<InvoiceItem[]> {
    const repo = manager ? manager.getRepository(InvoiceItem) : this.items;
    return repo.find({
      where: { invoice: { id: invoiceId }, tenant: { id: tenantId } },
    });
  }

  /**
   * Recomputes the parent invoice total from its items (within the caller's
   * tx). FND-029/FR-B005: sums in INTEGER MINOR UNITS (cents), not major-unit
   * floats — each `total_price` is converted to an exact integer cent count
   * (`Math.round`, matching how it was itself produced — see `addItems`)
   * before summing, so the total is exact by construction rather than
   * relying on `round2` to mask any accumulated float representation error
   * (e.g. `81.45 + 134.27 === 215.72000000000003`, not `215.72`, in raw JS
   * float arithmetic).
   */
  async recalcTotal(
    tenantId: string,
    invoiceId: string,
    manager: EntityManager,
  ): Promise<number> {
    const items = await manager.getRepository(InvoiceItem).find({
      where: { invoice: { id: invoiceId }, tenant: { id: tenantId } },
    });
    const totalCents = items.reduce(
      (sum, it) => sum + Math.round(Number(it.total_price) * 100),
      0,
    );
    const total = totalCents / 100;
    await manager
      .getRepository(Invoice)
      .update({ id: invoiceId }, { total_amount: total });
    return total;
  }
}
