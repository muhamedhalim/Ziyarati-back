import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  FindOptionsWhere,
  In,
  MoreThanOrEqual,
  LessThan,
  Repository,
} from 'typeorm';

import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { InvoiceStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import {
  FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
  PAYMENT_PROVIDER,
} from './payment/payment-provider.interface';
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
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @Inject(PAYMENT_PROVIDER)
    private readonly payment: PaymentProvider,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Issues an invoice for a billing cycle (status OPEN). Called by
   * `SubscriptionService` (creation, plan change) and `RenewalService`
   * (spec 014, T080).
   *
   * `periodStart`/`periodEnd`/`currency` are required, not optional: T079
   * made all three NOT NULL at the database level (`UQ_sub_invoice_period`
   * enforces "at most one non-VOID invoice per period"), so a caller that
   * omitted them would fail at the DB, not silently proceed with a guess.
   */
  async generateInvoice(
    tenantId: string,
    subscriptionId: string,
    amount: number,
    periodStart: Date,
    periodEnd: Date,
    currency: string,
    status: InvoiceStatus = InvoiceStatus.OPEN,
  ): Promise<SubscriptionInvoice> {
    const invoice = this.invoices.create({
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      amount: amount.toFixed(2),
      status,
      issued_at: new Date(),
      period_start: periodStart,
      period_end: periodEnd,
      currency,
    });
    return this.invoices.save(invoice);
  }

  async listInvoices(tenantId: string, query: QueryInvoicesDto) {
    const where: FindOptionsWhere<SubscriptionInvoice> = {
      tenant_id: tenantId,
    };
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
  async payInvoice(tenantId: string, id: string): Promise<SubscriptionInvoice> {
    // ── Phase 1: atomic claim (UPDATE … WHERE claim free/stale) ──
    const staleBefore = new Date(
      Date.now() - BillingService.CHARGE_CLAIM_STALE_MS,
    );
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
      .andWhere(
        '(charge_started_at IS NULL OR charge_started_at < :staleBefore)',
        {
          staleBefore,
        },
      )
      .execute();

    if (!claim.affected) {
      const invoice = await this.getInvoice(tenantId, id);
      if (invoice.status === InvoiceStatus.PAID) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'Invoice is already paid',
        });
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
    // Charges in the invoice's OWN currency (T079: snapshotted at issue
    // time from the platform's billing default) — never a caller-supplied
    // value, which previously defaulted to a hardcoded 'USD' regardless of
    // what the invoice actually said.
    const result = await this.payment.charge({
      tenantId,
      invoiceId: invoice.id,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      // T083 — echoed back by a real provider's webhook so
      // PaymentWebhookService can correlate a late/async confirmation to
      // this invoice even when `provider_reference` was never recorded (the
      // "lost confirmation" case FR-B016 names).
      metadata: { subscriptionInvoiceId: invoice.id },
    });

    // ── Phase 3: finalize under a row lock (idempotent) ──
    // The decline write MUST commit — it must never THROW from inside this
    // callback: `DataSource.transaction()` rolls back everything the
    // callback did the moment it throws, which silently discarded
    // `failure_reason`/`failure_class`/the claim release on every real
    // decline (only ever masked by the mocked `DataSource` in tests, whose
    // `transaction()` double has no real rollback semantics). The outcome is
    // returned instead, and the decline is raised as an error AFTER the
    // transaction has actually committed.
    const finalized = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SubscriptionInvoice);
      const locked = await repo.findOne({
        where: { id, tenant_id: tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Invoice not found',
        });
      }
      if (locked.status === InvoiceStatus.PAID) {
        return { declined: false as const, invoice: locked };
      }

      if (!result.success) {
        locked.failure_reason = result.failureReason ?? 'Payment was declined';
        // T081 — an ordinary decline (undefined) is distinct from a
        // structural refusal like TOKENIZATION_UNAVAILABLE; never treated
        // as a system error, never retried faster, never marked paid.
        locked.failure_class = result.failureClass ?? null;
        locked.charge_started_at = null; // release the claim for a future retry
        const saved = await repo.save(locked);
        return { declined: true as const, invoice: saved };
      }

      locked.status = InvoiceStatus.PAID;
      locked.paid_at = new Date();
      locked.provider_reference = result.reference;
      locked.failure_reason = null;
      locked.failure_class = null;
      const saved = await repo.save(locked);
      return { declined: false as const, invoice: saved };
    });

    if (finalized.declined) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Payment was declined by the provider',
        // Raw gateway decline text — provider-response detail, logs only.
        internalContext: { reason: result.failureReason },
      });
    }
    return finalized.invoice;
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

  /**
   * T089 (spec 014, US5, FR-B005e) — platform-wide visibility into renewals
   * blocked specifically on tokenization, distinguishable from an ordinary
   * decline: every OPEN invoice whose last decline carries
   * `FAILURE_CLASS_TOKENIZATION_UNAVAILABLE`. This is the only remaining
   * blocker while the production provider is `RecurringUnavailableProvider`
   * (see subscription-billing.module.ts), so it must stay visible rather than
   * silently accumulating in the past-due backlog.
   */
  async listTokenizationDeclines(): Promise<
    Array<{
      tenantId: string;
      tenantName: string | null;
      invoiceId: string;
      subscriptionId: string;
      amount: string;
      retryCount: number;
      nextRetryAt: Date | null;
    }>
  > {
    const invoices = await this.invoices.find({
      where: {
        status: InvoiceStatus.OPEN,
        failure_class: FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
      },
      order: { next_retry_at: 'ASC' },
    });
    if (invoices.length === 0) return [];

    const tenantIds = [...new Set(invoices.map((i) => i.tenant_id))];
    const tenants = await this.tenants.find({
      where: { id: In(tenantIds) },
    });
    const nameById = new Map(tenants.map((t) => [t.id, t.name]));

    return invoices.map((i) => ({
      tenantId: i.tenant_id,
      tenantName: nameById.get(i.tenant_id) ?? null,
      invoiceId: i.id,
      subscriptionId: i.subscription_id,
      amount: i.amount,
      retryCount: i.retry_count,
      nextRetryAt: i.next_retry_at ?? null,
    }));
  }
}
