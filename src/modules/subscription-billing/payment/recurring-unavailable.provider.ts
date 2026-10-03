import { Injectable, Logger } from '@nestjs/common';
import {
  CheckoutRequest,
  CheckoutResult,
  SavedPaymentMethodRef,
  VerifyCheckoutResult,
  ChargeRequest,
  ChargeResult,
  FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  VerifyChargeResult,
} from './payment-provider.interface';

/**
 * Production stand-in until recurring charges are actually enabled.
 *
 * Moyasar DOES support saved-card tokenization + recurring charges, but that
 * flow needs (a) tokenization enabled on the merchant account and (b) a stored
 * per-clinic card token captured through the client-side form — neither exists
 * yet. Until then, a LIVE deployment must not "simulate" a subscription charge:
 * the stub marking invoices PAID with no money moved is exactly the incorrect
 * financial behavior the platform must never exhibit.
 *
 * This provider fails every charge with a clear domain message instead. Once
 * tokenization is contractually enabled and tokens are stored, replace this
 * binding with a real token-charge adapter — BillingService stays untouched.
 */
@Injectable()
export class RecurringUnavailableProvider implements PaymentProvider {
  private readonly logger = new Logger('RecurringUnavailableProvider');

  /** No hosted page either: a paid subscription stays on the legacy path until a real provider is bound. */
  readonly name = 'none';
  readonly supportsCheckout = false;
  readonly checkoutWindowMinutes = 30;

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.logger.warn(
      `Subscription charge for invoice ${request.invoiceId} rejected: recurring payments are not yet enabled`,
    );
    return {
      success: false,
      failureReason:
        'Subscription auto-charge is not yet enabled: it requires provider tokenization (a saved payment method). No charge was attempted.',
      failureClass: FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.logger.warn(
      `Subscription refund for invoice ${request.invoiceId} rejected: recurring payments are not yet enabled`,
    );
    return {
      success: false,
      failureReason:
        'Subscription refunds are not available until recurring payments are enabled with the provider.',
    };
  }

  /**
   * T084 — never charges anything, so never has anything to verify. Reports
   * 'unknown' (never 'paid' without evidence) — the reconciliation sweep
   * treats 'unknown' as "safe to release the stale claim for a retry".
   */
  async verifyCharge(invoiceId: string): Promise<VerifyChargeResult> {
    this.logger.warn(
      `Verify requested for invoice ${invoiceId} — recurring payments are not yet enabled, nothing to verify`,
    );
    return { status: 'unknown' };
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    this.logger.warn(
      `Checkout for invoice ${request.invoiceId} refused: online payment is not enabled`,
    );
    return {
      status: 'failed',
      failureCode: 'CHECKOUT_UNAVAILABLE',
      failureReason: 'Online payment is not available yet',
    };
  }

  async verifyCheckout(): Promise<VerifyCheckoutResult> {
    return { status: 'unknown' };
  }

  async deletePaymentMethod(_method: SavedPaymentMethodRef): Promise<boolean> {
    return true; // nothing was ever stored at a provider
  }
}
