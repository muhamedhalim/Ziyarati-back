import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { InvoiceStatus, SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { PaymentsConfig } from '../payments/payments.config';
import { buildPayer } from '../payments/providers/payer.util';

import { InvoiceSettlementService } from './invoice-settlement.service';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type VerifyCheckoutResult,
} from './payment/payment-provider.interface';

const PAYABLE: InvoiceStatus[] = [
  InvoiceStatus.OPEN,
  InvoiceStatus.DRAFT,
  InvoiceStatus.UNCOLLECTIBLE,
];
/** Same window `BillingService` uses for a stale merchant-initiated claim. */
const CHARGE_CLAIM_STALE_MS = 10 * 60_000;

export type CheckoutOutcome =
  | { status: 'redirect'; invoiceId: string; redirectUrl: string }
  | { status: 'paid'; invoiceId: string };

export interface CheckoutVerification {
  /** `unknown` = the provider could not be asked right now — the caller should simply check again. */
  status: 'paid' | 'pending' | 'failed' | 'unknown';
  invoiceId?: string;
  /** The subscription's status after the verification, so the UI can tell activation from "still waiting". */
  subscriptionStatus?: SubscriptionStatus;
}

/**
 * Hosted checkout for a subscription invoice (clinic present, 3-D Secure).
 *
 * `createCheckout` opens (or RESUMES) the provider's hosted page; the clinic pays
 * there and returns to `/app/billing?checkout=return`. That return is only a
 * hint: `verifyCheckout` re-asks the provider about the charge by id, and the
 * webhook and the reconciliation sweep reach the very same settle path, so the
 * subscription becomes ACTIVE exactly once whichever of the three lands first.
 *
 * Concurrency: opening a checkout is an atomic claim (`checkout_started_at`), so
 * two clicks cannot open two hosted charges; and a fresh checkout makes
 * `BillingService.payInvoice` (the renewal job) stand down — see its claim.
 *
 * Tenant isolation: every lookup filters by the caller's `tenant_id`; a charge id
 * that resolves to another clinic's invoice — or to no invoice of ours — answers
 * the same plain 404, so a probe learns nothing.
 */
@Injectable()
export class SubscriptionCheckoutService {

  constructor(
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @Inject(PAYMENT_PROVIDER)
    private readonly payment: PaymentProvider,
    private readonly settlement: InvoiceSettlementService,
    private readonly config: PaymentsConfig,
  ) {}

  async createCheckout(
    tenantId: string,
    invoiceId: string,
  ): Promise<CheckoutOutcome> {
    if (!this.payment.supportsCheckout) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Online payment is not available yet',
      });
    }

    const invoice = await this.getOwnedInvoice(tenantId, invoiceId);
    this.assertPayable(invoice);
    await this.assertSubscriptionPayable(invoice);

    // ── 1. A hosted checkout is already open: resume it instead of opening a second ──
    const windowMs = this.payment.checkoutWindowMinutes * 60_000;
    const open =
      invoice.checkout_charge_id &&
      invoice.checkout_started_at &&
      Date.now() - invoice.checkout_started_at.getTime() < windowMs;
    if (open) {
      const v = await this.payment.verifyCheckout(invoice.checkout_charge_id!);
      if (v.status === 'paid') {
        await this.settle(
          invoice,
          invoice.checkout_charge_id!,
          v,
          'checkout_verify',
        );
        return { status: 'paid', invoiceId: invoice.id };
      }
      if (v.status === 'pending' && v.redirectUrl) {
        return {
          status: 'redirect',
          invoiceId: invoice.id,
          redirectUrl: v.redirectUrl,
        };
      }
      if (v.status === 'unknown' && !v.notFound) {
        throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
          message: 'Payment gateway is temporarily unavailable',
        });
      }
      // failed / expired / the provider no longer knows it / nothing to resume:
      // that checkout is dead.
      await this.clearCheckout(invoice.id, invoice.checkout_charge_id!);
    }

    // ── 2. Claim ──
    const tenant = await this.tenants.findOne({ where: { id: tenantId } });
    const payer = buildPayer({
      name: tenant?.name,
      email: tenant?.contact_email,
      phone: tenant?.contact_phone,
      fallbackFirstName: 'Clinic',
    });
    if (!payer.email && !payer.phone) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Add a valid contact email or phone number to your clinic profile to pay online',
      });
    }

    const attempt = await this.claimCheckout(invoice.id, tenantId);
    if (attempt === null) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A payment for this invoice is already in progress',
      });
    }

    // ── 3. Open the hosted page OUTSIDE any lock ──
    const res = await this.payment.createCheckout({
      tenantId,
      invoiceId: invoice.id,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      attempt,
      payer,
      saveCard: true,
      returnUrl: this.config.paymentReturnUrl(true),
    });

    if (res.status === 'created' && res.chargeId && res.redirectUrl) {
      await this.invoices.update(
        { id: invoice.id },
        { checkout_charge_id: res.chargeId, provider: this.payment.name },
      );
      return {
        status: 'redirect',
        invoiceId: invoice.id,
        redirectUrl: res.redirectUrl,
      };
    }

    if (res.status === 'unknown') {
      // The hosted charge may exist. Hand the counter back so a retry reuses the
      // SAME idempotency key (the provider returns the original, not a second).
      await this.invoices
        .createQueryBuilder()
        .update(SubscriptionInvoice)
        .set({
          checkout_started_at: null,
          checkout_attempts: () => 'GREATEST(checkout_attempts - 1, 0)',
        })
        .where('id = :id AND checkout_charge_id IS NULL', { id: invoice.id })
        .execute();
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Payment gateway is temporarily unavailable',
        internalContext: { code: res.failureCode },
      });
    }

    // Nothing was created: free the invoice for another try.
    await this.invoices.update(
      { id: invoice.id },
      { checkout_started_at: null },
    );
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message: res.failureReason ?? 'Payment could not be started',
      internalContext: { code: res.failureCode },
    });
  }

  /**
   * The return page: ask the provider about the charge by id, and settle the
   * invoice if (and only if) it is captured for the right amount.
   */
  async verifyCheckout(
    tenantId: string,
    chargeId: string,
  ): Promise<CheckoutVerification> {
    const v = await this.payment.verifyCheckout(chargeId);
    if (v.status === 'unknown') {
      // A charge the provider definitively does not know is answered exactly like
      // one that belongs to another clinic (a plain 404): the difference must not
      // let a caller probe which charge ids exist. Only a real outage is "unknown".
      if (v.notFound) throw this.notFound();
      return { status: 'unknown' };
    }

    // The provider says which of OUR invoices this charge was created for; a
    // charge that is not an invoice charge of ours is simply not found.
    if (!v.invoiceId) throw this.notFound();
    const invoice = await this.invoices.findOne({
      where: { id: v.invoiceId, tenant_id: tenantId },
    });
    if (!invoice) throw this.notFound();
    // …and it must be the charge WE issued for that invoice.
    if (
      invoice.checkout_charge_id !== chargeId &&
      invoice.provider_reference !== chargeId
    ) {
      throw this.notFound();
    }

    if (v.status === 'paid') {
      await this.settle(invoice, chargeId, v, 'checkout_verify');
    } else if (v.status === 'failed') {
      await this.clearCheckout(invoice.id, chargeId);
    }

    const sub = await this.subscriptions.findOne({
      where: { id: invoice.subscription_id },
    });
    return {
      status: v.status,
      invoiceId: invoice.id,
      subscriptionStatus: sub?.status,
    };
  }

  // ─────────────────────────────── helpers ──────────────────────────────── //

  private async settle(
    invoice: SubscriptionInvoice,
    chargeId: string,
    v: VerifyCheckoutResult,
    source: 'checkout_verify',
  ): Promise<void> {
    const settled = await this.settlement.settleInvoicePaid(invoice.id, {
      source,
      provider: this.payment.name,
      reference: chargeId,
      capturedMinorUnits: v.capturedMinorUnits,
      capturedCurrency: v.capturedCurrency,
      savedPaymentMethod: v.savedPaymentMethod,
    });
    if (settled.outcome === 'rejected') {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This payment could not be applied to the invoice',
        internalContext: { reason: settled.reason },
      });
    }
  }

  /** Atomically opens a checkout; returns the invoice's n-th checkout number, or null if it cannot be opened now. */
  private async claimCheckout(
    invoiceId: string,
    tenantId: string,
  ): Promise<number | null> {
    const now = Date.now();
    const res = await this.invoices
      .createQueryBuilder()
      .update(SubscriptionInvoice)
      .set({
        checkout_started_at: new Date(now),
        checkout_attempts: () => 'checkout_attempts + 1',
      })
      .where('id = :invoiceId AND tenant_id = :tenantId', {
        invoiceId,
        tenantId,
      })
      .andWhere('status IN (:...payable)', { payable: PAYABLE })
      .andWhere(
        '(charge_started_at IS NULL OR charge_started_at < :chargeStale)',
        { chargeStale: new Date(now - CHARGE_CLAIM_STALE_MS) },
      )
      .andWhere(
        '(checkout_started_at IS NULL OR checkout_started_at < :checkoutStale)',
        {
          checkoutStale: new Date(
            now - this.payment.checkoutWindowMinutes * 60_000,
          ),
        },
      )
      .returning(['checkout_attempts'])
      .execute();
    if (!res.affected) return null;
    const raw = (res.raw as Array<{ checkout_attempts: number }>)[0];
    return Number(raw?.checkout_attempts);
  }

  /** Marks a dead hosted checkout as no longer in flight, so a new one can start. */
  private async clearCheckout(
    invoiceId: string,
    chargeId: string,
  ): Promise<void> {
    await this.invoices
      .createQueryBuilder()
      .update(SubscriptionInvoice)
      .set({ checkout_started_at: null })
      .where('id = :invoiceId AND checkout_charge_id = :chargeId', {
        invoiceId,
        chargeId,
      })
      .andWhere('status <> :paid', { paid: InvoiceStatus.PAID })
      .execute();
  }

  private async getOwnedInvoice(
    tenantId: string,
    id: string,
  ): Promise<SubscriptionInvoice> {
    const invoice = await this.invoices.findOne({
      where: { id, tenant_id: tenantId },
    });
    if (!invoice) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Invoice not found' });
    }
    return invoice;
  }

  private assertPayable(invoice: SubscriptionInvoice): void {
    if (invoice.status === InvoiceStatus.PAID) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Invoice is already paid',
      });
    }
    if (!PAYABLE.includes(invoice.status)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Invoice in status "${invoice.status}" cannot be paid`,
      });
    }
  }

  /**
   * Never take money the subscription cannot use: a cancelled or suspended
   * subscription has nothing for a payment to apply to.
   */
  private async assertSubscriptionPayable(
    invoice: SubscriptionInvoice,
  ): Promise<void> {
    const sub = await this.subscriptions.findOne({
      where: { id: invoice.subscription_id },
    });
    if (
      sub &&
      (sub.status === SubscriptionStatus.CANCELLED ||
        sub.status === SubscriptionStatus.SUSPENDED)
    ) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This subscription cannot be paid in its current state',
      });
    }
  }

  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
  }
}
