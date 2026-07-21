import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  FindOptionsWhere,
  MoreThanOrEqual,
  LessThan,
  Repository,
} from 'typeorm';

import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface';
import type { PaymentProvider } from './payment/payment-provider.interface';
import { QueryInvoicesDto } from './dto/query-invoices.dto';

/**
 * Billing & invoices.
 *
 * Tenant isolation: `subscription_invoices` uses a plain `tenant_id` column, so
 * every query filters `where: { tenant_id: tenantId }`. The payment integration
 * is reached ONLY through the injected `PaymentProvider` abstraction — no
 * gateway SDK is referenced here.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    @Inject(PAYMENT_PROVIDER)
    private readonly payment: PaymentProvider,
    private readonly dataSource: DataSource,
  ) {}

  /** Issues an invoice for a billing cycle (status OPEN). Called by SubscriptionService. */
  async generateInvoice(
    tenantId: string,
    subscriptionId: string,
    amount: number,
    status: InvoiceStatus = InvoiceStatus.OPEN,
  ): Promise<SubscriptionInvoice> {
    const invoice = this.invoices.create({
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      amount: amount.toFixed(2),
      status,
      issued_at: new Date(),
    });
    return this.invoices.save(invoice);
  }

  async listInvoices(tenantId: string, query: QueryInvoicesDto) {
    const where: FindOptionsWhere<SubscriptionInvoice> = { tenant_id: tenantId };
    if (query.status) where.status = query.status;
    if (query.from && query.to) {
      where.issued_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.issued_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.issued_at = LessThan(new Date(query.to));
    }

    const [data, total] = await this.invoices.findAndCount({
      where,
      order: { issued_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  async getInvoice(tenantId: string, id: string): Promise<SubscriptionInvoice> {
    const invoice = await this.invoices.findOne({
      where: { id, tenant_id: tenantId },
    });
    if (!invoice) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Invoice not found' });
    }
    return invoice;
  }

  /** A stale charge claim (crashed attempt) may be re-claimed after this window. */
  private static readonly CHARGE_CLAIM_STALE_MS = 10 * 60_000;

  /**
   * Settles an open invoice via the payment abstraction. Double-charge safe at
   * the DATABASE level: an atomic claim on `charge_started_at` means one
   * financial obligation can have at most one in-flight charge attempt — a
   * concurrent retry gets a 409 instead of a second provider charge. The
   * provider is called OUTSIDE any lock; the outcome is finalized under a row
   * lock (idempotent: an invoice already PAID is returned as-is). The provider
   * reference is persisted for support/reconciliation.
   */
  async payInvoice(
    tenantId: string,
    id: string,
    currency = 'USD',
  ): Promise<SubscriptionInvoice> {
    // ── Phase 1: atomic claim (UPDATE … WHERE claim free/stale) ──
    const staleBefore = new Date(Date.now() - BillingService.CHARGE_CLAIM_STALE_MS);
    const claim = await this.invoices
      .createQueryBuilder()
      .update(SubscriptionInvoice)
      .set({ charge_started_at: new Date() })
      .where('id = :id AND tenant_id = :tenantId', { id, tenantId })
      .andWhere('status IN (:...payable)', {
        payable: [
          InvoiceStatus.OPEN,
          InvoiceStatus.DRAFT,
          InvoiceStatus.UNCOLLECTIBLE,
        ],
      })
      .andWhere('(charge_started_at IS NULL OR charge_started_at < :staleBefore)', {
        staleBefore,
      })
      .execute();

    if (!claim.affected) {
      const invoice = await this.getInvoice(tenantId, id);
      if (invoice.status === InvoiceStatus.PAID) {
        throw new AppError(ErrorCode.CONFLICT, { message: 'Invoice is already paid' });
      }
      if (
        invoice.status === InvoiceStatus.VOID ||
        invoice.status === InvoiceStatus.REFUNDED
      ) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Invoice in status "${invoice.status}" cannot be paid`,
        });
      }
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A charge for this invoice is already in progress',
      });
    }

    const invoice = await this.getInvoice(tenantId, id);

    // ── Phase 2: provider charge OUTSIDE any tx/lock ──
    const result = await this.payment.charge({
      tenantId,
      invoiceId: invoice.id,
      amount: Number(invoice.amount),
      currency,
    });

    // ── Phase 3: finalize under a row lock (idempotent) ──
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SubscriptionInvoice);
      const locked = await repo.findOne({
        where: { id, tenant_id: tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Invoice not found' });
      }
      if (locked.status === InvoiceStatus.PAID) return locked;

      if (!result.success) {
        locked.failure_reason = result.failureReason ?? 'Payment was declined';
        locked.charge_started_at = null; // release the claim for a future retry
        await repo.save(locked);
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Payment was declined by the provider',
          // Raw gateway decline text — provider-response detail, logs only.
          internalContext: { reason: result.failureReason },
        });
      }

      locked.status = InvoiceStatus.PAID;
      locked.paid_at = new Date();
      locked.provider_reference = result.reference;
      locked.failure_reason = null;
      return repo.save(locked);
    });
  }

  /** Aggregated billing summary for the tenant: counts + amounts by status. */
  async getSummary(tenantId: string) {
    const rows = await this.invoices
      .createQueryBuilder('i')
      .select('i.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(i.amount), 0)', 'total')
      .where('i.tenant_id = :tenantId', { tenantId })
      .groupBy('i.status')
      .getRawMany<{ status: InvoiceStatus; count: string; total: string }>();

    const byStatus: Record<string, { count: number; total: number }> = {};
    let totalInvoices = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;

    for (const r of rows) {
      const count = Number(r.count);
      const total = Number(r.total);
      byStatus[r.status] = { count, total: +total.toFixed(2) };
      totalInvoices += count;
      if (r.status === InvoiceStatus.PAID) totalPaid += total;
      if (r.status === InvoiceStatus.OPEN || r.status === InvoiceStatus.DRAFT) {
        totalOutstanding += total;
      }
    }

    return {
      tenantId,
      totalInvoices,
      totalPaid: +totalPaid.toFixed(2),
      totalOutstanding: +totalOutstanding.toFixed(2),
      byStatus,
    };
  }
}
