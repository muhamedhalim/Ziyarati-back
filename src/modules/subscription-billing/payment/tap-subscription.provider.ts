import { Injectable, Logger } from '@nestjs/common';

import { PaymentsConfig } from '../../payments/payments.config';
import { TapApiClient } from '../../payments/providers/tap/tap-api.client';
import {
  mapChargeStatus,
  mapRefundStatus,
  safeFailureReason,
} from '../../payments/providers/tap/tap-status.mapper';
import {
  TAP_SOURCE,
  toDomainMinorUnits,
  toTapAmount,
  type TapCharge,
  type TapRefund,
} from '../../payments/providers/tap/tap.types';
import { extractSavedPaymentMethod } from '../../payments/providers/tap/tap-saved-method';
import { isUuid } from '../../payments/payments.constants';
import {
  ChargeRequest,
  ChargeResult,
  CheckoutRequest,
  CheckoutResult,
  FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  SavedPaymentMethodInfo,
  SavedPaymentMethodRef,
  VerifyChargeResult,
  VerifyCheckoutResult,
  VerifyRefundResult,
} from './payment-provider.interface';

/** User-safe text — Tap's own wording is never forwarded. */
const MSG_UNAVAILABLE = 'Payment gateway is temporarily unavailable';
const MSG_REFUND_REJECTED = 'Refund was rejected by the payment gateway';

/** `metadata.udf2` marker the Tap webhook handler uses to tell an invoice charge from a booking payment. */
export const TAP_INVOICE_MARKER = 'subscription_invoice';

/**
 * Tap errors that mean "we cannot charge this clinic's saved card WITHOUT the
 * clinic present" — a structural refusal (feature not activated, no agreement,
 * the saved customer/card no longer exists), not a card decline. They surface as
 * `TOKENIZATION_UNAVAILABLE` so the clinic is asked to pay through checkout
 * instead of being retried on a schedule that cannot succeed.
 *   1108 save-card not enabled · 1109 non-3DS not allowed · 1216 agreement missing
 *   1104–1107 customer id missing / invalid / not found / mismatched
 */
const STRUCTURAL_ERROR_CODES = new Set([
  '1108',
  '1109',
  '1216',
  '1104',
  '1105',
  '1106',
  '1107',
]);

/**
 * `client_ip` is required by the token endpoint and describes the PAYER's
 * device. A merchant-initiated charge has no payer present, so a fixed loopback
 * value is sent (the documented example uses the same).
 */
const MIT_CLIENT_IP = '127.0.0.1';

/**
 * Tap Payments adapter for SUBSCRIPTION invoices (clinic → ZiyaraTech).
 *
 * Two flows, both on ZiyaraTech's OWN merchant account (platform revenue — no
 * `merchant.id` routing to a clinic, so the money never touches a clinic wallet):
 *
 *  1. HOSTED CHECKOUT (payer present, 3-D Secure): `source.id = src_card`,
 *     `customer_initiated: true`, and — only when `TAP_RECURRING_ENABLED` — with
 *     `save_card: true`, so Tap returns the customer / card / payment-agreement
 *     ids a later renewal needs.
 *  2. MERCHANT-INITIATED CHARGE (renewal job, payer absent): `POST /v2/tokens`
 *     from the saved card, then a charge with `customer_initiated: false`,
 *     `threeDSecure: false` and the payment agreement id.
 *
 * Idempotency keys (Tap honours `reference.idempotent` for 24h and returns the
 * ORIGINAL charge on a repeat, so a lost response can never become a second capture):
 *   checkout  `subinv:{invoiceId}:co:{n}`   (n = the invoice's checkout counter)
 *   renewal   `subinv:{invoiceId}:a{k}`     (k = the invoice's retry_count)
 *
 * Never logs or returns a card number, token, key or payer detail. A transport
 * error, timeout, 5xx or unmapped status is `pending`/`unknown`, NEVER `failed`:
 * an outage must not read as a decline (it would burn a retry and email the clinic
 * "your payment failed" for money that may in fact have been captured).
 */
@Injectable()
export class TapSubscriptionProvider implements PaymentProvider {
  readonly name = 'tap';
  readonly supportsCheckout = true;

  private readonly logger = new Logger('TapSubscriptionProvider');

  constructor(
    private readonly config: PaymentsConfig,
    private readonly client: TapApiClient,
  ) {}

  /** How long a hosted page stays payable — Tap's own default is 30 unless the window is configured. */
  get checkoutWindowMinutes(): number {
    return this.config.tapChargeExpiryMinutes ?? 30;
  }

  /** TRUE when a secret key exists for the active `TAP_ENV`. */
  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  // ───────────────────────────── hosted checkout ──────────────────────────── //

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const payer = request.payer;
    if (!payer?.firstName || (!payer.email && !payer.phone)) {
      return {
        status: 'failed',
        failureCode: 'TAP_PAYER_REQUIRED',
        failureReason:
          'Add a contact email or phone number to your clinic profile to pay online',
      };
    }

    const res = await this.client.createCharge(this.checkoutBody(request));
    if (!res.ok) {
      this.logger.warn(
        `Tap subscription checkout not created (http ${res.status}, code ${res.errorCode ?? 'n/a'})`,
      );
      if (res.transient) {
        // It may have been created before the timeout / 5xx: never "failed".
        return {
          status: 'unknown',
          failureCode: res.errorCode ?? String(res.status),
          failureReason: MSG_UNAVAILABLE,
        };
      }
      return {
        status: 'failed',
        failureCode: res.errorCode ?? String(res.status),
        failureReason: 'Payment could not be started',
      };
    }

    const charge = res.json;
    if (!charge?.id) {
      return {
        status: 'unknown',
        failureCode: 'TAP_NO_CHARGE_ID',
        failureReason: MSG_UNAVAILABLE,
      };
    }
    const mapped = mapChargeStatus(charge.status);
    if (mapped === 'failed') {
      return {
        status: 'failed',
        chargeId: charge.id,
        failureCode: charge.response?.code,
        failureReason: safeFailureReason(charge.response?.code, charge.status),
      };
    }
    if (!charge.transaction?.url) {
      // A hosted charge with no page to send the payer to cannot be used.
      return {
        status: 'unknown',
        chargeId: charge.id,
        failureCode: 'TAP_NO_REDIRECT_URL',
        failureReason: MSG_UNAVAILABLE,
      };
    }
    return {
      status: 'created',
      chargeId: charge.id,
      redirectUrl: charge.transaction.url,
    };
  }

  /**
   * What Tap itself says about one hosted charge. Never trusts a webhook or a
   * client-supplied status: the charge is fetched with OUR key by id.
   */
  async verifyCheckout(chargeId: string): Promise<VerifyCheckoutResult> {
    const res = await this.client.getCharge(chargeId);
    if (!res.ok) {
      // ANY non-2xx is "could not verify", never "the payment failed": a 404 can
      // be a live id queried with a test key, a 401 a rotated secret. A DEFINITIVE
      // (4xx) answer is flagged so the caller can treat it as "not ours".
      return {
        status: 'unknown',
        chargeId,
        notFound: !res.transient,
        failureReason: MSG_UNAVAILABLE,
      };
    }
    const charge = res.json;
    const status = mapChargeStatus(charge.status);
    const isInvoice = charge.metadata?.udf2 === TAP_INVOICE_MARKER;
    const echoed = [charge.reference?.transaction, charge.metadata?.udf1].find(
      isUuid,
    );
    return {
      status:
        status === 'paid' && this.amountOf(charge) === undefined
          ? 'pending' // a CAPTURED charge without a readable amount is not booked
          : status,
      chargeId: charge.id ?? chargeId,
      invoiceId: isInvoice ? echoed : undefined,
      capturedMinorUnits: status === 'paid' ? this.amountOf(charge) : undefined,
      capturedCurrency: status === 'paid' ? charge.currency : undefined,
      redirectUrl: status === 'pending' ? charge.transaction?.url : undefined,
      failureReason:
        status === 'failed'
          ? safeFailureReason(charge.response?.code, charge.status)
          : undefined,
      savedPaymentMethod:
        status === 'paid' ? this.savedMethodOf(charge) : undefined,
    };
  }

  // ─────────────────────── merchant-initiated renewal ─────────────────────── //

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (!this.config.tapRecurringEnabled) {
      return this.tokenizationUnavailable(
        'Automatic renewal is not enabled yet: please pay this invoice online',
      );
    }
    const method = request.paymentMethod;
    if (!method?.customerId || !method.cardId || !method.agreementId) {
      return this.tokenizationUnavailable(
        'No saved payment method on file: please pay this invoice online',
      );
    }

    // 1. A single-use token from the saved card (a saved-card id alone is not
    //    accepted by /charges). Nothing is charged yet, so a failure here is safe.
    const token = await this.client.createTokenFromSavedCard({
      saved_card: { card_id: method.cardId, customer_id: method.customerId },
      client_ip: MIT_CLIENT_IP,
    });
    if (!token.ok || !token.json?.id) {
      if (token.transient) {
        // Nothing was charged, but we cannot say the card is bad either.
        return {
          success: false,
          status: 'pending',
          failureReason: MSG_UNAVAILABLE,
        };
      }
      this.logger.warn(
        `Tap token not created for invoice ${request.invoiceId} (http ${token.status}, code ${token.errorCode ?? 'n/a'})`,
      );
      // The saved card / customer no longer exists at Tap: structural, not a decline.
      return this.tokenizationUnavailable(
        'The saved payment method can no longer be used: please pay this invoice online',
      );
    }

    // 2. The merchant-initiated charge.
    const res = await this.client.createCharge(
      this.mitBody(request, method, token.json.id),
    );
    if (!res.ok) {
      if (res.errorCode && STRUCTURAL_ERROR_CODES.has(res.errorCode)) {
        this.logger.warn(
          `Tap renewal for invoice ${request.invoiceId} refused structurally (code ${res.errorCode})`,
        );
        return this.tokenizationUnavailable(
          'Automatic renewal is not available for this card: please pay this invoice online',
        );
      }
      if (res.transient) {
        // The charge may exist at Tap. No reference to verify with yet, so the
        // caller releases the claim and the NEXT attempt reuses the SAME
        // idempotency key — Tap then returns the original charge.
        return {
          success: false,
          status: 'pending',
          failureReason: MSG_UNAVAILABLE,
        };
      }
      return {
        success: false,
        status: 'failed',
        failureReason: 'Payment was declined by the card issuer',
      };
    }

    const charge = res.json;
    if (!charge?.id) {
      return {
        success: false,
        status: 'pending',
        failureReason: MSG_UNAVAILABLE,
      };
    }
    const mapped = mapChargeStatus(charge.status);
    if (mapped === 'paid') {
      return { success: true, status: 'paid', reference: charge.id };
    }
    if (mapped === 'failed') {
      return {
        success: false,
        status: 'failed',
        reference: charge.id,
        failureReason: safeFailureReason(charge.response?.code, charge.status),
      };
    }
    // INITIATED / IN_PROGRESS / unmapped: accepted, outcome not known yet.
    return {
      success: false,
      status: 'pending',
      reference: charge.id,
      failureReason: MSG_UNAVAILABLE,
    };
  }

  /**
   * Recovers a charge whose outcome never made it back. Needs the Tap charge id:
   * Tap's list endpoint cannot be filtered by our metadata (unconfirmed), so
   * without one the answer is `unknown` — which releases the stale claim, and the
   * retry reuses the same idempotency key (so Tap hands back the ORIGINAL charge
   * rather than creating a second).
   */
  async verifyCharge(
    invoiceId: string,
    reference?: string,
  ): Promise<VerifyChargeResult> {
    if (!reference || !reference.startsWith('chg_')) {
      this.logger.log(
        `Verify for invoice ${invoiceId}: no Tap charge id on file (unknown)`,
      );
      return { status: 'unknown' };
    }
    const res = await this.client.getCharge(reference);
    if (!res.ok) return { status: 'unknown', reference };

    const charge = res.json;
    const status = mapChargeStatus(charge.status);
    return {
      status,
      reference: charge.id ?? reference,
      capturedMinorUnits: status === 'paid' ? this.amountOf(charge) : undefined,
      capturedCurrency: status === 'paid' ? charge.currency : undefined,
      failureReason:
        status === 'failed'
          ? safeFailureReason(charge.response?.code, charge.status)
          : undefined,
      savedPaymentMethod:
        status === 'paid' ? this.savedMethodOf(charge) : undefined,
    };
  }

  /**
   * Refund a PAID subscription invoice, in full, on ZiyaraTech's OWN merchant (the
   * invoice was platform revenue, so no clinic wallet is involved).
   *
   * Tap refunds are asynchronous: `REFUNDED` is success, `PENDING` is NOT (Tap is
   * still checking the wallet balance) and a transport error is `unknown` — the
   * refund may exist. The per-attempt idempotency key `invrefund:{invoiceId}:{n}`
   * means a re-send of the same attempt returns the original refund (Tap honours
   * `reference.idempotent` for 24h) instead of paying out twice.
   */
  async refund(request: RefundRequest): Promise<RefundResult> {
    const charge = request.chargeReference;
    if (!charge || !charge.startsWith('chg_')) {
      return {
        success: false,
        status: 'failed',
        failureReason: 'This invoice has no payment reference to refund',
      };
    }
    const attempt = request.attempt ?? 1;
    const res = await this.client.createRefund({
      charge_id: charge,
      amount: toTapAmount(request.amount, request.currency),
      currency: request.currency.toUpperCase(),
      reason: request.reason?.trim() || 'requested_by_customer',
      reference: {
        merchant: request.invoiceId,
        idempotent: `invrefund:${request.invoiceId}:${attempt}`,
      },
      ...(this.config.tapWebhookUrl
        ? { post: { url: this.config.tapWebhookUrl } }
        : {}),
      metadata: {
        udf1: request.invoiceId,
        udf2: 'subscription_invoice_refund',
        udf3: request.tenantId,
      },
    });
    if (!res.ok) {
      return {
        success: false,
        status: res.transient ? 'unknown' : 'failed',
        failureReason: res.transient ? MSG_UNAVAILABLE : MSG_REFUND_REJECTED,
        failureCode: res.errorCode ?? String(res.status),
      };
    }
    return this.refundResult(res.json);
  }

  /** One refund by Tap's id. ANY non-2xx is `unknown` — never "the refund failed". */
  async verifyRefund(reference: string): Promise<VerifyRefundResult> {
    const res = await this.client.getRefund(reference);
    if (!res.ok || !res.json?.id) {
      return {
        success: false,
        status: 'unknown',
        reference,
        failureReason: MSG_UNAVAILABLE,
        failureCode: res.errorCode ?? String(res.status),
      };
    }
    return this.refundResult(res.json);
  }

  private refundResult(refund: TapRefund): VerifyRefundResult {
    const outcome = mapRefundStatus(refund.status);
    return {
      success: outcome === 'succeeded',
      status: outcome,
      reference: refund.id,
      chargeReference: refund.charge_id,
      amountMinorUnits: toDomainMinorUnits(refund.amount),
      currency: refund.currency,
      failureReason:
        outcome === 'failed'
          ? MSG_REFUND_REJECTED
          : outcome === 'unknown'
            ? MSG_UNAVAILABLE
            : undefined,
      failureCode:
        outcome === 'failed' ? (refund.response?.code ?? undefined) : undefined,
    };
  }

  async deletePaymentMethod(method: SavedPaymentMethodRef): Promise<boolean> {
    const res = await this.client.deleteSavedCard(
      method.customerId,
      method.cardId,
    );
    // 404 = already gone at Tap, which is the state we wanted.
    return res.ok || res.status === 404;
  }

  // ─────────────────────────────── helpers ──────────────────────────────── //

  private checkoutBody(request: CheckoutRequest): Record<string, unknown> {
    const currency = request.currency.toUpperCase();
    const payer = request.payer;
    const customer: Record<string, unknown> = { first_name: payer.firstName };
    if (payer.lastName) customer.last_name = payer.lastName;
    if (payer.email) customer.email = payer.email;
    if (payer.phone) {
      customer.phone = {
        country_code: Number(payer.phone.countryCode),
        number: Number(payer.phone.number),
      };
    }

    const body: Record<string, unknown> = {
      amount: toTapAmount(request.amount, currency),
      currency,
      customer_initiated: true,
      threeDSecure: true,
      // Asking for a card to be saved on an account without Save Card makes Tap
      // reject the WHOLE charge (1108), so it is only requested when enabled.
      save_card: request.saveCard && this.config.tapRecurringEnabled,
      description:
        request.description ?? `ZiyaraTech subscription ${request.invoiceId}`,
      // `udf1..` are the documented metadata keys; arbitrary keys are unconfirmed.
      metadata: {
        udf1: request.invoiceId,
        udf2: TAP_INVOICE_MARKER,
        udf3: request.tenantId,
      },
      reference: {
        transaction: request.invoiceId,
        idempotent: `subinv:${request.invoiceId}:co:${request.attempt}`,
      },
      customer,
      source: { id: TAP_SOURCE.CARD },
      redirect: { url: request.returnUrl },
    };
    this.attachRouting(body);
    return body;
  }

  private mitBody(
    request: ChargeRequest,
    method: SavedPaymentMethodRef,
    tokenId: string,
  ): Record<string, unknown> {
    const currency = request.currency.toUpperCase();
    const body: Record<string, unknown> = {
      amount: toTapAmount(request.amount, currency),
      currency,
      customer_initiated: false,
      threeDSecure: false,
      save_card: false,
      description: `ZiyaraTech subscription renewal ${request.invoiceId}`,
      metadata: {
        udf1: request.invoiceId,
        udf2: TAP_INVOICE_MARKER,
        udf3: request.tenantId,
      },
      reference: {
        transaction: request.invoiceId,
        idempotent: `subinv:${request.invoiceId}:a${request.attempt ?? 0}`,
      },
      customer: { id: method.customerId },
      source: { id: tokenId },
      payment_agreement: { id: method.agreementId },
      // Required on every charge even though no payer is present to be redirected.
      redirect: { url: this.config.paymentReturnUrl(true) },
    };
    this.attachRouting(body);
    return body;
  }

  /** Platform revenue lands in ZiyaraTech's own merchant account — never a clinic's. */
  private attachRouting(body: Record<string, unknown>): void {
    if (this.config.tapWebhookUrl)
      body.post = { url: this.config.tapWebhookUrl };
    const expiry = this.config.tapChargeExpiryMinutes;
    if (expiry !== undefined) {
      body.transaction = { expiry: { period: expiry, type: 'MINUTE' } };
    }
    if (this.config.tapMerchantId) {
      body.merchant = { id: this.config.tapMerchantId };
    }
  }

  private amountOf(charge: TapCharge): number | undefined {
    return toDomainMinorUnits(charge.amount);
  }

  private savedMethodOf(charge: TapCharge): SavedPaymentMethodInfo | undefined {
    return extractSavedPaymentMethod(charge);
  }

  private tokenizationUnavailable(reason: string): ChargeResult {
    return {
      success: false,
      status: 'failed',
      failureReason: reason,
      failureClass: FAILURE_CLASS_TOKENIZATION_UNAVAILABLE,
    };
  }
}
