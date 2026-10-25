import { Injectable, Logger } from '@nestjs/common';
import {
  CheckoutRequest,
  CheckoutResult,
  SavedPaymentMethodRef,
  VerifyCheckoutResult,
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  VerifyChargeResult,
} from './payment-provider.interface';

/**
 * Default no-op payment provider.
 *
 * It simulates a successful charge/refund so the billing flow is end-to-end
 * runnable without a real gateway. Swap it for a real adapter by re-binding the
 * `PAYMENT_PROVIDER` token in the module — no BillingService changes required.
 */
@Injectable()
export class StubPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger('StubPaymentProvider');

  /**
   * The stub cannot take a payment from a present payer, so a paid subscription
   * keeps the legacy "ACTIVE + open invoice" behaviour in dev/test (decision D2
   * only applies once a provider that CAN check out is bound).
   */
  readonly name = 'stub';
  readonly supportsCheckout = false;
  readonly reportsCapturedAmount = false;
  readonly checkoutWindowMinutes = 30;

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.logger.log(
      `Simulated charge ${request.amount} ${request.currency} for invoice ${request.invoiceId}`,
    );
    return {
      success: true,
      reference: `stub_ch_${request.invoiceId}`,
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.logger.log(
      `Simulated refund ${request.amount} ${request.currency} for invoice ${request.invoiceId}`,
    );
    return {
      success: true,
      reference: `stub_rf_${request.invoiceId}`,
    };
  }

  /**
   * T084 — the stub never leaves anything unsettled: `charge()` always
   * responds synchronously and immediately. Nothing to look up, so this
   * always reports 'unknown' rather than fabricating a status — the
   * reconciliation sweep treats 'unknown' as "safe to release the stale
   * claim for a retry", never as "paid".
   */
  async verifyCharge(invoiceId: string): Promise<VerifyChargeResult> {
    this.logger.log(
      `Verify requested for invoice ${invoiceId} — stub has no record (unknown)`,
    );
    return { status: 'unknown' };
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    this.logger.warn(
      `Checkout for invoice ${request.invoiceId} refused: the stub provider has no hosted page`,
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
