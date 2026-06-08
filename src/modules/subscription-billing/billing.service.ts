import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, MoreThanOrEqual, LessThan, Repository } from 'typeorm';

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

  /**
   * Settles an open invoice via the payment abstraction. On success the invoice
   * is marked PAID; on provider failure it stays unpaid and a 422 is returned.
   */
  async payInvoice(
    tenantId: string,
    id: string,
    currency = 'USD',
  ): Promise<SubscriptionInvoice> {
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

    const result = await this.payment.charge({
      tenantId,
      invoiceId: invoice.id,
      amount: Number(invoice.amount),
      currency,
    });

    if (!result.success) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Payment was declined by the provider',
        context: { reason: result.failureReason },
      });
    }

    invoice.status = InvoiceStatus.PAID;
    invoice.paid_at = new Date();
    return this.invoices.save(invoice);
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
