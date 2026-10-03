import { Injectable, Logger } from '@nestjs/common';

import { PaymentsConfig } from '../../payments.config';
import {
  GatewayCreatePaymentRequest,
  GatewayFeeInfo,
  GatewayPaymentResult,
  GatewayRefundRequest,
  GatewayRefundResult,
  PaymentGatewayProvider,
} from '../payment-gateway.provider.interface';
import { TapApiClient, TapResponse } from './tap-api.client';
import {
  mapChargeStatus,
  mapRefundStatus,
  safeFailureReason,
} from './tap-status.mapper';
import { sanitizeTapCharge, sanitizeTapRefund } from './tap-redaction';
import {
  TAP_SOURCE,
  TapCharge,
  toDomainMinorUnits,
  toTapAmount,
} from './tap.types';

/** User-safe text — Tap's own wording is never forwarded. */
const MSG_UNAVAILABLE = 'Payment gateway is temporarily unavailable';

/**
 * Tap Payments gateway adapter (https://developers.tap.company).
 *
 * The ONLY place that knows how a ZiyaraTech charge/refund maps onto Tap's API.
 * The domain sees the provider-neutral `PaymentGatewayProvider` contract:
 *   - amounts in MAJOR units (Tap also uses major-unit decimals — no halala maths)
 *   - `pending | paid | failed | unknown`; transport errors, 5xx, 429 and any
 *     unmapped status are `unknown`, never `failed`
 *   - `reference.transaction` carries OUR payment id, so a webhook can still
 *     find a payment whose Tap id was never persisted (REL-002)
 *
 * Hosted flow: `source.id = src_all` → Tap returns `transaction.url`; the payer
 * is returned to the SERVER-built `returnUrl` with `?tap_id=chg_…`, which is a
 * UX hint only — the webhook (re-fetched server-side) is authoritative.
 */
@Injectable()
export class TapGatewayProvider implements PaymentGatewayProvider {
  readonly name = 'tap';
  /** Tap cannot create a charge without a customer name + email/phone. */
  readonly requiresPayerDetails = true;
  /** D1 (Tap Platform): Tap settles a clinic charge to the clinic's own merchant wallet. */
  readonly settlesDirectlyToPayee = true;

  private readonly logger = new Logger('TapGatewayProvider');

  constructor(
    private readonly config: PaymentsConfig,
    private readonly client: TapApiClient,
  ) {}

  /**
   * Explicit match only — unlike the legacy adapter an unspecified gateway does
   * NOT select Tap, so two configured gateways can never both claim `undefined`.
   * Also false without a secret key, so the factory falls back (and, when
   * payments are live, fails closed) instead of calling Tap unauthenticated.
   */
  supports(gatewayName?: string): boolean {
    return gatewayName?.toLowerCase() === this.name && this.client.isConfigured;
  }

  async createPayment(
    request: GatewayCreatePaymentRequest,
  ): Promise<GatewayPaymentResult> {
    const payer = request.customer;
    if (!payer?.firstName || (!payer.email && !payer.phone)) {
      return this.rejected(
        'TAP_PAYER_REQUIRED',
        'Payer details are required to start this payment',
      );
    }
    if (!request.returnUrl) {
      return this.rejected(
        'TAP_RETURN_URL_REQUIRED',
        'A return URL is required to start this payment',
      );
    }
    if (request.payee === 'clinic' && !request.settlementMerchantId) {
      // Tap Platform: patient funds must settle to the CLINIC's merchant. With
      // no routing the charge would land in ZiyaraTech's own account — exactly
      // what the business model forbids — so refuse before any request is made.
      return this.rejected(
        'TAP_CLINIC_ROUTING_REQUIRED',
        'Online payment is not enabled for this clinic yet',
      );
    }
    if (request.settlementMerchantId && !this.config.tapPlatformId) {
      // Charging on a clinic's behalf needs the platform id Tap issues on activation.
      return this.rejected(
        'TAP_PLATFORM_ID_REQUIRED',
        'Clinic payments are not enabled yet',
      );
    }

    const res = await this.client.createCharge(this.chargeBody(request));
    if (!res.ok) return this.failedResult(res, 'create');

    const charge = res.json;
    if (!charge?.id) {
      // 2xx without an id: we cannot track it, and it may exist. Not a failure.
      return {
        success: false,
        status: 'unknown',
        failureReason: MSG_UNAVAILABLE,
        failureCode: 'TAP_NO_CHARGE_ID',
        correlationId: request.paymentId,
      };
    }

    const status = mapChargeStatus(charge.status);
    return {
      success: status !== 'failed',
      gatewayPaymentId: charge.id,
      status,
      redirectUrl: charge.transaction?.url,
      failureReason:
        status === 'failed'
          ? safeFailureReason(charge.response?.code, charge.status)
          : undefined,
      failureCode: status === 'failed' ? charge.response?.code : undefined,
      correlationId: charge.reference?.transaction ?? request.paymentId,
      fees: this.feesOf(charge),
      raw: sanitizeTapCharge(charge),
    };
  }

  async verifyPayment(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
    const res = await this.client.getCharge(gatewayPaymentId);
    if (!res.ok) {
      // ANY non-2xx here is "could not verify", never "the payment failed": a
      // 404 can be a live id queried with a test key, a 401 a rotated secret.
      return {
        success: false,
        gatewayPaymentId,
        status: 'unknown',
        failureReason: MSG_UNAVAILABLE,
        failureCode: res.errorCode ?? String(res.status),
      };
    }

    const charge = res.json;
    const status = mapChargeStatus(charge.status);
    return {
      success: true,
      gatewayPaymentId: charge.id ?? gatewayPaymentId,
      status,
      // Only meaningful (and only read by the domain) once the charge is paid.
      capturedMinorUnits:
        status === 'paid' ? toDomainMinorUnits(charge.amount) : undefined,
      capturedCurrency: status === 'paid' ? charge.currency : undefined,
      failureReason:
        status === 'failed'
          ? safeFailureReason(charge.response?.code, charge.status)
          : undefined,
      failureCode: status === 'failed' ? charge.response?.code : undefined,
      correlationId: charge.reference?.transaction,
      // A Tap charge carries no refund total: refund state comes from the
      // refund object (`verifyRefund`, Phase 5), so refundedMinorUnits is left
      // undefined and the legacy reaper keeps such a refund PENDING + alerting.
      fees: this.feesOf(charge),
      raw: sanitizeTapCharge(charge),
    };
  }

  async refundPayment(
    request: GatewayRefundRequest,
  ): Promise<GatewayRefundResult> {
    if (!request.refundId) {
      // The idempotency key MUST be unique per refund. Falling back to the
      // payment id would make two different partial refunds on one payment
      // share a key, and Tap would silently return the first one's response.
      return {
        success: false,
        status: 'failed',
        failureReason: 'A refund id is required to refund through this gateway',
      };
    }
    const res = await this.client.createRefund({
      charge_id: request.gatewayPaymentId,
      amount: toTapAmount(request.amount, request.currency),
      currency: request.currency.toUpperCase(),
      reason: request.reason?.trim() || 'requested_by_customer',
      reference: {
        merchant: request.refundId,
        // Same refund row ⇒ same key ⇒ Tap returns the first response (24h).
        idempotent: `refund:${request.refundId}`,
      },
      ...(this.config.tapWebhookUrl
        ? { post: { url: this.config.tapWebhookUrl } }
        : {}),
      metadata: {
        udf1: request.paymentId,
        udf2: 'refund',
        udf3: request.tenantId,
      },
    });

    if (!res.ok) {
      return {
        success: false,
        // A transport error / 5xx may mean the refund WAS created — unknown,
        // not failed. Anything else (e.g. 1161 amount too high) is definitive.
        status: res.transient ? 'unknown' : 'failed',
        failureReason: res.transient
          ? MSG_UNAVAILABLE
          : 'Refund was rejected by the payment gateway',
      };
    }

    const refund = res.json;
    const outcome = mapRefundStatus(refund.status);
    return {
      // Only a COMPLETED refund is success; PENDING is not.
      success: outcome === 'succeeded',
      status: outcome,
      gatewayRefundId: refund.id,
      failureReason:
        outcome === 'failed'
          ? 'Refund was rejected by the payment gateway'
          : outcome === 'pending'
            ? 'Refund is pending at the payment gateway'
            : undefined,
      raw: sanitizeTapRefund(refund),
    };
  }

  // ─────────────────────────────── helpers ──────────────────────────────── //

  private chargeBody(
    request: GatewayCreatePaymentRequest,
  ): Record<string, unknown> {
    const payer = request.customer!;
    const currency = request.currency.toUpperCase();
    const expiry = this.config.tapChargeExpiryMinutes;

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
      save_card: false,
      description: request.description ?? `Payment ${request.paymentId}`,
      // `udf1..` are the documented metadata keys; arbitrary keys are unconfirmed.
      metadata: {
        udf1: request.paymentId,
        udf2: 'payment',
        udf3: request.tenantId,
      },
      reference: {
        transaction: request.paymentId,
        ...(request.reference?.order ? { order: request.reference.order } : {}),
        idempotent: `pay:${request.paymentId}`,
      },
      customer,
      source: { id: TAP_SOURCE.ALL },
      redirect: { url: request.returnUrl },
    };

    if (this.config.tapWebhookUrl)
      body.post = { url: this.config.tapWebhookUrl };
    if (expiry !== undefined) {
      body.transaction = { expiry: { period: expiry, type: 'MINUTE' } };
    }

    if (request.settlementMerchantId) {
      // Tap Platform: the clinic is the merchant of record, we are the platform.
      body.merchant = { id: request.settlementMerchantId };
      body.platform = { id: this.config.tapPlatformId };
    } else if (this.config.tapMerchantId) {
      body.merchant = { id: this.config.tapMerchantId };
    }
    return body;
  }

  /** A Tap charge reports no fee, so only the payment method is extracted. */
  private feesOf(charge: TapCharge): GatewayFeeInfo {
    const method = charge.source?.payment_method ?? charge.source?.type;
    return { paymentMethod: method ? String(method).toLowerCase() : undefined };
  }

  private rejected(code: string, reason: string): GatewayPaymentResult {
    // Raised before any request is made, so nothing exists at Tap: a clean failure.
    return {
      success: false,
      status: 'failed',
      failureReason: reason,
      failureCode: code,
    };
  }

  private failedResult(res: TapResponse, op: string): GatewayPaymentResult {
    this.logger.warn(
      `Tap ${op} charge not created (http ${res.status}, code ${res.errorCode ?? 'n/a'})`,
    );
    if (res.transient) {
      // May have been created before the timeout / 5xx: unknown, never failed.
      return {
        success: false,
        status: 'unknown',
        failureReason: MSG_UNAVAILABLE,
        failureCode: res.errorCode ?? String(res.status),
      };
    }
    return {
      success: false,
      status: 'failed',
      failureReason: 'Payment could not be started',
      failureCode: res.errorCode ?? String(res.status),
    };
  }
}
