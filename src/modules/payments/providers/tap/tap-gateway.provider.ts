import { Injectable, Logger } from '@nestjs/common';

import { PaymentsConfig } from '../../payments.config';
import {
  GatewayCreatePaymentRequest,
  GatewayFeeInfo,
  GatewayLookupResult,
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
  TapRefund,
  toDomainMinorUnits,
  toTapAmount,
} from './tap.types';

/** User-safe text — Tap's own wording is never forwarded. */
const MSG_UNAVAILABLE = 'Payment gateway is temporarily unavailable';
const MSG_REFUND_REJECTED = 'Refund was rejected by the payment gateway';

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

    const misrouted = this.misroutedClinicCharge(request, charge);
    if (misrouted) return misrouted;

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

    return this.verifiedCharge(res.json, gatewayPaymentId);
  }

  /**
   * Finds a payment by the reference WE sent (`reference.transaction` = our Payment
   * id) — Tap documents that filter on its charge list. Used for a payment whose
   * create call reached Tap but whose id we never stored, when its webhook is lost.
   *
   * `not_found` only when Tap answered with an empty list: a refusal (a platform
   * key asking about a sub-merchant, say), an outage and an ambiguous answer are all
   * `unknown`, so the caller never concludes "nothing was charged" from silence.
   */
  async findPaymentByReference(
    paymentId: string,
  ): Promise<GatewayLookupResult> {
    const res = await this.client.listCharges({
      reference: { transaction: [paymentId] },
      limit: 5,
    });
    if (!res.ok) return { status: 'unknown' };
    const charges = (res.json?.charges ?? []).filter(
      (c) => c?.id && c.reference?.transaction === paymentId,
    );
    if (charges.length === 0) return { status: 'not_found' };
    // One idempotency key per payment means one charge. If there are several, prefer
    // the single CAPTURED one; anything else is ambiguous and left to a human.
    const captured = charges.filter(
      (c) => mapChargeStatus(c.status) === 'paid',
    );
    const chosen =
      charges.length === 1
        ? charges[0]
        : captured.length === 1
          ? captured[0]
          : undefined;
    if (!chosen) return { status: 'unknown' };
    return { status: 'found', result: this.verifiedCharge(chosen, chosen.id) };
  }

  private verifiedCharge(
    charge: TapCharge,
    gatewayPaymentId: string,
  ): GatewayPaymentResult {
    const status = mapChargeStatus(charge.status);
    return {
      success: true,
      gatewayPaymentId: charge.id ?? gatewayPaymentId,
      status,
      // Only meaningful (and only read by the domain) once the charge is paid.
      capturedMinorUnits:
        status === 'paid' ? toDomainMinorUnits(charge.amount) : undefined,
      capturedCurrency: status === 'paid' ? charge.currency : undefined,
      merchantId: this.config.tapStrictMerchantEcho
        ? String(charge.merchant?.id ?? '')
        : undefined,
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
        failureReason: res.transient ? MSG_UNAVAILABLE : MSG_REFUND_REJECTED,
        failureCode: res.errorCode ?? String(res.status),
      };
    }

    return this.refundResult(res.json);
  }

  /**
   * One refund by Tap's id (`GET /v2/refunds/{id}`) — the reaper's and the refund
   * webhook's source of truth. ANY non-2xx is `unknown`: a 404 can be a live id
   * asked with a test key, a 401 a rotated secret, a 5xx an outage — none of
   * which says the refund did not happen.
   */
  async verifyRefund(gatewayRefundId: string): Promise<GatewayRefundResult> {
    const res = await this.client.getRefund(gatewayRefundId);
    if (!res.ok || !res.json?.id) {
      return {
        success: false,
        status: 'unknown',
        gatewayRefundId,
        failureReason: MSG_UNAVAILABLE,
        failureCode: res.errorCode ?? String(res.status),
      };
    }
    return this.refundResult(res.json);
  }

  /** Reduce a Tap refund object to the neutral result (shared by create and verify). */
  private refundResult(refund: TapRefund): GatewayRefundResult {
    const outcome = mapRefundStatus(refund.status);
    return {
      // Only a COMPLETED refund is success; PENDING is not.
      success: outcome === 'succeeded',
      status: outcome,
      gatewayRefundId: refund.id,
      gatewayPaymentId: refund.charge_id,
      amountMinorUnits: toDomainMinorUnits(refund.amount),
      currency: refund.currency,
      failureReason:
        outcome === 'failed'
          ? MSG_REFUND_REJECTED
          : outcome === 'pending'
            ? 'Refund is pending at the payment gateway'
            : outcome === 'unknown'
              ? MSG_UNAVAILABLE
              : undefined,
      failureCode:
        outcome === 'failed' ? (refund.response?.code ?? undefined) : undefined,
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

  /**
   * Tap does NOT reject a charge whose `merchant.id` it does not recognise: observed in
   * the sandbox (2026-10-04), a charge sent with an unknown `merchant.id` and a made-up
   * `platform.id` came back 200, echoed the fake platform id, and belonged to the
   * AUTHENTICATED account (ours). For a clinic payment that would put the patient's
   * money in ZiyaraTech's wallet — the one outcome D1 forbids. So the merchant Tap
   * says the charge belongs to is checked before anyone is given its payment page.
   *
   * Refused when Tap echoes our own merchant, and when it echoes none (routing cannot
   * be verified). Nothing is returned that links the orphaned INITIATED charge — its
   * hosted URL is never shown, and Tap expires it by itself.
   */
  private misroutedClinicCharge(
    request: GatewayCreatePaymentRequest,
    charge: TapCharge,
  ): GatewayPaymentResult | undefined {
    if (!request.settlementMerchantId) return undefined;
    const landedOn = charge.merchant?.id ? String(charge.merchant.id) : '';
    const own = this.config.tapMerchantId;
    const onOurOwnAccount = !!own && landedOn === String(own);
    // FIN-P4: the charge must belong to THE CLINIC we routed it to. "Any merchant that
    // is not ours" is not enough — a stored or echoed id for a different sub-merchant
    // would hand this patient's money to another clinic.
    if (this.config.tapStrictMerchantEcho) {
      if (landedOn && landedOn === String(request.settlementMerchantId)) {
        return undefined;
      }
    } else if (landedOn && !onOurOwnAccount) {
      return undefined;
    }
    this.logger.error(
      `Tap clinic charge ${charge.id} was NOT routed to the clinic merchant ` +
        `(${onOurOwnAccount ? 'it belongs to the platform account' : landedOn ? 'it belongs to a different merchant' : 'the response names no merchant'}); payment refused`,
    );
    return {
      success: false,
      status: 'failed',
      failureReason: 'Online payment is not enabled for this clinic yet',
      failureCode: onOurOwnAccount
        ? 'TAP_ROUTED_TO_PLATFORM'
        : 'TAP_ROUTING_UNVERIFIED',
      correlationId: request.paymentId,
    };
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
