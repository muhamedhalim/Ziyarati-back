import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  MoreThanOrEqual,
  LessThan,
  Repository,
} from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import {
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import {
  FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
  PAYMENT_PROVIDER,
} from './payment/payment-provider.interface';
import type { PaymentProvider } from './payment/payment-provider.interface';
import { QueryInvoicesDto } from './dto/query-invoices.dto';
import {
  InvoiceSettlementService,
  type SettleEvidence,
} from './invoice-settlement.service';
import { PaymentMethodService } from './payment-method.service';
import { chargeClaimBlocks, chargeClaimFree } from './charge-claim';

/** Optional fields a caller sets when it issues an invoice (all NULL on a legacy invoice). */
export interface GenerateInvoiceExtra {
  kind?: SubscriptionInvoiceKind;
  /** The plan this invoice pays for — settling it makes this the subscription's plan. */
  targetPlanId?: string;
  provider?: string;
}

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
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @Inject(PAYMENT_PROVIDER)
    private readonly payment: PaymentProvider,
    private readonly dataSource: DataSource,
    private readonly settlement: InvoiceSettlementService,
    private readonly methods: PaymentMethodService,
  ) {}

  /**
   * TRUE when the bound provider can take a payment from a present payer through
   * a hosted page. Decision D2 (a paid subscription is ACTIVE only after payment)
   * applies exactly then — see `PaymentProvider.supportsCheckout`.
   */
  get supportsCheckout(): boolean {
    return this.payment.supportsCheckout;
  }

  /** The bound provider's name — stored on the invoices it settles. */
  get providerName(): string {
    return this.payment.name;
  }

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
    extra: GenerateInvoiceExtra = {},
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
      kind: extra.kind ?? null,
      target_plan_id: extra.targetPlanId ?? null,
      provider: extra.provider ?? null,
    });
    return this.invoices.save(invoice);
  }

  /**
   * Voids every OPEN invoice of a subscription (a superseded quote, a cancelled
   * pending payment). VOID frees both unique indexes: `UQ_sub_invoice_period`
   * ignores VOID rows and `UQ_sub_invoice_open_per_subscription` only counts OPEN.
   * A payment that still arrives for a voided invoice is NOT booked — it raises
   * an ALERT in the settle path so an operator can refund it.
   */
  async voidOpenInvoices(
    subscriptionId: string,
    reason: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = manager
      ? manager.getRepository(SubscriptionInvoice)
      : this.invoices;
    const res = await repo
      .createQueryBuilder()
      .update(SubscriptionInvoice)
      .set({
        status: InvoiceStatus.VOID,
        failure_reason: reason,
        charge_started_at: null,
        next_retry_at: null,
      })
      .where('subscription_id = :subscriptionId', { subscriptionId })
      .andWhere('status = :open', { open: InvoiceStatus.OPEN })
      .execute();
    return res.affected ?? 0;
  }

  /**
   * Voids the OPEN invoices that a renewal makes obsolete — a pre-Tap creation
   * invoice (kind NULL) or an upgrade quote — but ONLY those nobody is paying
   * right now (no fresh charge claim, no open checkout). They would otherwise
   * hold the subscription's single OPEN-invoice slot and block the renewal
   * invoice from ever being issued.
   *
   * `scope: 'all'` drops the kind filter: an immediate cancellation leaves no use for
   * ANY unpaid invoice, but the same "nobody is paying it" rule still holds.
   */
  async voidSupersededOpenInvoices(
    subscriptionId: string,
    reason: string,
    scope: 'superseded' | 'all' = 'superseded',
  ): Promise<number> {
    const now = Date.now();
    const claimFree = chargeClaimFree(now);
    const res = await this.invoices
      .createQueryBuilder()
      .update(SubscriptionInvoice)
      .set({
        status: InvoiceStatus.VOID,
        failure_reason: reason,
        next_retry_at: null,
      })
      .where('subscription_id = :subscriptionId', { subscriptionId })
      .andWhere('status = :open', { open: InvoiceStatus.OPEN })
      .andWhere(
        scope === 'all' ? '1 = 1' : '(kind IS NULL OR kind = :upgrade)',
        { upgrade: SubscriptionInvoiceKind.UPGRADE },
      )
      // Not while a charge is live OR unresolved: voiding under it would orphan money.
      .andWhere(claimFree.sql, claimFree.params)
      .andWhere(
        '(checkout_started_at IS NULL OR checkout_started_at < :checkoutStale)',
        {
          checkoutStale: new Date(
            now - this.payment.checkoutWindowMinutes * 60_000,
          ),
        },
      )
      .execute();
    return res.affected ?? 0;
  }

  /** The subscription's single OPEN invoice, if any (the open-invoice unique index makes it at most one). */
  findOpenInvoice(subscriptionId: string): Promise<SubscriptionInvoice | null> {
    return this.invoices.findOne({
      where: { subscription_id: subscriptionId, status: InvoiceStatus.OPEN },
    });
  }

  /**
   * TRUE while a payment for this invoice may still land: a merchant-initiated
   * charge holds a fresh claim, or a hosted checkout was opened within its
   * payable window. Used to refuse changes (re-quoting, voiding) that would leave
   * a live charge pointing at an invoice that no longer exists.
   */
  isPaymentInFlight(invoice: SubscriptionInvoice, now = Date.now()): boolean {
    const checkoutOpen =
      !!invoice.checkout_started_at &&
      now - invoice.checkout_started_at.getTime() <
        this.payment.checkoutWindowMinutes * 60_000;
    // Includes an UNRESOLVED charge (id known, or too old to retry): it may still
    // capture, so nothing may re-quote or void the invoice under it.
    return checkoutOpen || chargeClaimBlocks(invoice, now);
  }

  /**
   * Asks the provider what became of the hosted checkout charge on an OPEN invoice,
   * so a decision about that invoice (supersede it, refuse a plan change) rests on
   * the provider's confirmed status instead of our own timers:
   *
   *  - `paid`    — captured: booked through the ONE settle path (the invoice is PAID
   *                and the subscription advanced exactly as the webhook would have).
   *  - `cleared` — failed, unknown to the provider, or a page past its payable
   *                window: that checkout is dead and no longer counts as in flight.
   *  - `pending` — still payable on the hosted page, captured but not bookable
   *                (left for an operator), or the provider cannot be asked right
   *                now: treat the invoice as being paid.
   *  - `none`    — nothing to ask: no hosted charge id, or a merchant-initiated
   *                charge claim owns the invoice (the reconciliation sweep resolves
   *                those).
   */
  async reconcileHostedCheckout(
    invoice: SubscriptionInvoice,
  ): Promise<'paid' | 'cleared' | 'pending' | 'none'> {
    const chargeId = invoice.checkout_charge_id;
    if (!chargeId || invoice.charge_started_at) return 'none';

    const v = await this.payment.verifyCheckout(chargeId);
    // A charge echoing another invoice is not this invoice's payment.
    if (v.invoiceId && v.invoiceId !== invoice.id) return 'pending';

    if (v.status === 'paid') {
      const settled = await this.settlement.settleInvoicePaid(invoice.id, {
        source: 'checkout_verify',
        provider: this.payment.name,
        reference: chargeId,
        capturedMinorUnits: v.capturedMinorUnits,
        capturedCurrency: v.capturedCurrency,
        amountRequired: this.payment.supportsCheckout,
        savedPaymentMethod: v.savedPaymentMethod,
      });
      // Rejected (amount mismatch, …) is left for manual review: still blocking.
      return settled.outcome === 'rejected' ? 'pending' : 'paid';
    }
    // Still INITIATED on a hosted page whose payable window has passed: nobody can
    // complete it any more (the same rule `isPaymentInFlight` applies). A pending
    // answer WITHOUT a page (captured but unreadable, misrouted) is for an operator.
    const expiredPage =
      v.status === 'pending' &&
      !!v.redirectUrl &&
      !this.isPaymentInFlight(invoice);
    if (
      v.status === 'failed' ||
      (v.status === 'unknown' && v.notFound) ||
      expiredPage
    ) {
      await this.invoices
        .createQueryBuilder()
        .update(SubscriptionInvoice)
        .set({ checkout_started_at: null })
        .where('id = :id AND checkout_charge_id = :chargeId', {
          id: invoice.id,
          chargeId,
        })
        .andWhere('status = :open', { open: InvoiceStatus.OPEN })
        .execute();
      invoice.checkout_started_at = null;
      return 'cleared';
    }
    return 'pending';
  }

  /** Settles an invoice from a proof of payment. See {@link InvoiceSettlementService}. */
  settleInvoicePaid(invoiceId: string, evidence: SettleEvidence) {
    return this.settlement.settleInvoicePaid(invoiceId, evidence);
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

  /**
   * Settles an open invoice via the payment abstraction. Double-charge safe at
   * the DATABASE level: an atomic claim on `charge_started_at` means one
   * financial obligation can have at most one in-flight charge attempt — a
   * concurrent retry gets a 409 instead of a second provider charge. The claim
   * also refuses an invoice whose hosted checkout is still open
   * (`checkout_started_at` younger than the checkout window), so a clinic paying
   * by hand can never be double-captured by the renewal job.
   *
   * The provider is called OUTSIDE any lock. A captured charge is booked through
   * the ONE settle path (`InvoiceSettlementService`), which also advances the
   * subscription; a decline / still-pending outcome is finalized here under a row
   * lock (idempotent: an invoice already PAID is returned as-is).
   *
   * `pending` (the provider accepted the charge but cannot say yet): the claim is
   * KEPT and the invoice stays OPEN — the webhook or the reconciliation sweep
   * settles it. Without a provider charge id the sweep finds the charge by the
   * invoice reference; a retry under the same idempotency key is only allowed
   * while the provider's 24h guarantee holds (`charge-claim.ts`).
   */
  async payInvoice(tenantId: string, id: string): Promise<SubscriptionInvoice> {
    // ── Phase 1: atomic claim (UPDATE … WHERE claim free/stale, no fresh checkout) ──
    const now = Date.now();
    const claimFree = chargeClaimFree(now);
    const checkoutStaleBefore = new Date(
      now - this.payment.checkoutWindowMinutes * 60_000,
    );
    const claim = await this.invoices
      .createQueryBuilder()
      .update(SubscriptionInvoice)
      // The claim owns the slot: a hosted-checkout id left by a dead checkout is
      // cleared, so a charge id present with a claim is always THIS claim's charge.
      .set({ charge_started_at: new Date(), checkout_charge_id: null })
      .where('id = :id AND tenant_id = :tenantId', { id, tenantId })
      .andWhere('status IN (:...payable)', {
        payable: [
          InvoiceStatus.OPEN,
          InvoiceStatus.DRAFT,
          InvoiceStatus.UNCOLLECTIBLE,
        ],
      })
      .andWhere(claimFree.sql, claimFree.params)
      .andWhere(
        '(checkout_started_at IS NULL OR checkout_started_at < :checkoutStaleBefore)',
        { checkoutStaleBefore },
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
        message:
          invoice.checkout_started_at &&
          invoice.checkout_started_at >= checkoutStaleBefore
            ? 'A checkout for this invoice is already open'
            : 'A charge for this invoice is already in progress',
      });
    }

    const invoice = await this.getInvoice(tenantId, id);

    // Never take money the subscription cannot use: a charge on a cancelled /
    // suspended / deleted subscription would be captured and then land as
    // `settled_unapplied`. The claim is handed back untouched — nothing was sent.
    const sub = await this.subscriptions.findOne({
      where: { id: invoice.subscription_id },
    });
    if (
      !sub ||
      sub.status === SubscriptionStatus.CANCELLED ||
      sub.status === SubscriptionStatus.SUSPENDED
    ) {
      await this.invoices.update({ id }, { charge_started_at: null });
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This subscription cannot be paid in its current state',
      });
    }

    // ── Phase 2: provider charge OUTSIDE any tx/lock ──
    // Charges in the invoice's OWN currency (T079: snapshotted at issue
    // time from the platform's billing default) — never a caller-supplied
    // value, which previously defaulted to a hardcoded 'USD' regardless of
    // what the invoice actually said.
    const method = await this.methods.resolveForCharge(tenantId);
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
      paymentMethod: method?.ref,
      // Stable across a retry of the SAME attempt, new for the next one.
      attempt: invoice.retry_count,
    });
    const outcome = result.status ?? (result.success ? 'paid' : 'failed');

    // ── Phase 3a: a captured charge goes through the single settle path ──
    if (outcome === 'paid') {
      const settled = await this.settlement.settleInvoicePaid(id, {
        source: 'charge',
        provider: this.payment.name,
        reference: result.reference ?? `${this.payment.name}:${invoice.id}`,
        capturedMinorUnits: result.capturedMinorUnits,
        capturedCurrency: result.capturedCurrency,
        amountRequired: this.payment.supportsCheckout,
        paymentMethodId: method?.id,
        savedPaymentMethod: result.savedPaymentMethod,
      });
      if (settled.outcome === 'rejected' || !settled.invoice) {
        // Money moved but the invoice cannot take it (voided under us, amount
        // mismatch). The settle path already raised the ALERT. The charge id is
        // kept on the invoice so the claim stays an UNRESOLVED charge (no second
        // charge on top of it) and the sweep keeps surfacing it.
        if (result.reference) {
          await this.invoices.update(
            { id },
            { checkout_charge_id: result.reference },
          );
        }
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'Invoice can no longer be paid',
          internalContext: { reason: settled.reason },
        });
      }
      return settled.invoice;
    }

    // ── Phase 3b: decline / pending — finalize under a row lock (idempotent) ──
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

      if (outcome === 'pending') {
        // The claim is KEPT either way — a charge may exist and must be resolved,
        // not re-created. With an id the sweep verifies it; without one it looks the
        // charge up by the invoice reference (see `chargeClaimBlocks` for how long a
        // retry under the same idempotency key stays safe).
        if (result.reference) locked.checkout_charge_id = result.reference;
        const saved = await repo.save(locked);
        return { declined: false as const, invoice: saved };
      }

      locked.failure_reason = result.failureReason ?? 'Payment was declined';
      // T081 — an ordinary decline (undefined) is distinct from a
      // structural refusal like TOKENIZATION_UNAVAILABLE; never treated
      // as a system error, never retried faster, never marked paid.
      locked.failure_class = result.failureClass ?? null;
      locked.charge_started_at = null; // release the claim for a future retry
      const saved = await repo.save(locked);
      return { declined: true as const, invoice: saved };
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
