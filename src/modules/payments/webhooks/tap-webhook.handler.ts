import { Injectable, Logger } from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';
import { WebhookLogService } from '../../platform/webhook-log.service';
import { WEBHOOK_LOG_STATUS } from '../../platform/platform.constants';
import {
  PaymentWebhookService,
  WebhookResult,
} from '../payment-webhook.service';
import { isUuid } from '../payments.constants';
import { PaymentsConfig } from '../payments.config';
import {
  subscriptionChargeRouting,
  subscriptionMisroutedLogLine,
} from '../providers/tap/tap-routing';
import { RefundWebhookService } from '../refund-webhook.service';
import { TapApiClient } from '../providers/tap/tap-api.client';
import {
  sanitizeTapCharge,
  sanitizeTapRefund,
} from '../providers/tap/tap-redaction';
import {
  mapChargeStatus,
  mapRefundStatus,
  safeFailureReason,
} from '../providers/tap/tap-status.mapper';
import {
  TAP_OBJECT,
  toDomainMinorUnits,
  type TapCharge,
  type TapRefund,
  type TapWebhookPayload,
} from '../providers/tap/tap.types';
import type {
  GatewayRefundEvent,
  GatewayWebhookEvent,
  GatewayWebhookTarget,
} from './gateway-webhook.types';
import { extractSavedPaymentMethod } from '../providers/tap/tap-saved-method';
import { TapWebhookVerifier } from './tap-webhook.verifier';

/** Keep attacker-controlled ids out of logs as anything but a short, plain token. */
const safeId = (v: unknown): string =>
  String(v ?? '')
    .replace(/[^\w:.-]/g, '_')
    .slice(0, 48);

/**
 * Tap webhook adapter: authenticate → re-fetch → reduce to a neutral event →
 * hand to `PaymentWebhookService.process()`.
 *
 *  1. AUTHENTICATE with the `hashstring` header (TapWebhookVerifier).
 *  2. RE-FETCH the charge from Tap with OUR key. The signature does not cover
 *     `metadata` / `merchant` / `reference.transaction`, and Tap sends no event
 *     id, so the posted body is only a pointer — every state change is driven
 *     by what Tap itself says about that charge right now. This also makes a
 *     replayed delivery harmless: it just re-reads current truth.
 *  3. DEDUPE on a synthetic `tap:{chargeId}:{STATUS}` key (the shared ledger).
 *
 * Responses (Tap retries a non-2xx twice, then marks the post ERROR):
 *   - bad signature          → 401   (never persisted: an unauthenticated caller
 *                                      must not be able to fill `webhook_logs`)
 *   - malformed body         → 400
 *   - Tap unreachable / 5xx  → 503   (transient — Tap's retry + our reconcile sweep)
 *   - handled / unmatched    → 200   (retrying cannot change the outcome)
 *
 * Refund webhooks take the same road: authenticate, RE-FETCH the refund from Tap
 * (`GET /v2/refunds/{id}` — the body is only a pointer), reduce it to a neutral
 * `GatewayRefundEvent` and let `RefundWebhookService` match it to OUR refund row.
 * A Tap refund is its own object with its own lifecycle, so it is never read as a
 * statement about the charge.
 */
@Injectable()
export class TapWebhookHandler {
  private readonly logger = new Logger('TapWebhookHandler');

  constructor(
    private readonly verifier: TapWebhookVerifier,
    private readonly client: TapApiClient,
    private readonly webhooks: PaymentWebhookService,
    private readonly refunds: RefundWebhookService,
    private readonly logs: WebhookLogService,
    private readonly config: PaymentsConfig,
  ) {}

  async handle(
    payload: TapWebhookPayload,
    hashstring?: string,
  ): Promise<WebhookResult> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.id !== 'string' ||
      typeof payload.object !== 'string'
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Malformed webhook payload',
      });
    }

    if (!this.verifier.verify(payload, hashstring)) {
      this.logger.warn(
        `Rejected Tap webhook: invalid signature (${safeId(payload.object)} ${safeId(payload.id)})`,
      );
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'Invalid webhook signature',
      });
    }

    switch (payload.object) {
      case TAP_OBJECT.CHARGE:
        return this.handleCharge(payload as TapCharge);
      case TAP_OBJECT.REFUND:
        return this.handleRefund(payload as TapRefund);
      default:
        // Authentic but not something we create (e.g. authorize): accept so Tap
        // does not retry, and leave a trace.
        this.logger.warn(
          `Tap webhook for unsupported object "${safeId(payload.object)}" — ignored`,
        );
        await this.record(
          'FAILED',
          `${safeId(payload.object)}.${safeId(payload.status)}`,
          payload,
          'Unsupported object type',
        );
        return { accepted: true, matched: false };
    }
  }

  private async handleCharge(posted: TapCharge): Promise<WebhookResult> {
    const label = `charge.${safeId(posted.status).toLowerCase()}`;

    const res = await this.client.getCharge(posted.id);
    if (!res.ok) {
      if (res.transient) {
        // We cannot confirm the charge right now. Ask Tap to retry rather than
        // trust an unverified body; the reconcile sweep is the backstop.
        await this.record(
          'FAILED',
          label,
          sanitizeTapCharge(posted),
          'Could not re-fetch charge (transient)',
        );
        throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
          message: 'Payment gateway is temporarily unavailable',
          internalContext: {
            tapStatus: res.status,
            tapErrorCode: res.errorCode,
          },
        });
      }
      // The signature was valid, yet Tap will not show us this charge (wrong
      // environment/account, unknown id). A retry cannot fix that.
      this.logger.error(
        `Tap charge ${safeId(posted.id)} could not be re-fetched (http ${res.status}, code ${res.errorCode ?? 'n/a'})`,
      );
      await this.record(
        'FAILED',
        label,
        sanitizeTapCharge(posted),
        `Re-fetch failed (http ${res.status})`,
      );
      return { accepted: true, matched: false };
    }

    const charge = res.json;
    if (!charge || charge.id !== posted.id) {
      this.logger.error(
        `Tap returned a different charge than requested for ${safeId(posted.id)}`,
      );
      await this.record(
        'FAILED',
        label,
        sanitizeTapCharge(posted),
        'Re-fetched charge id mismatch',
      );
      return { accepted: true, matched: false };
    }

    const event = this.toGatewayEvent(charge);
    try {
      const result = await this.webhooks.process(event);
      await this.record(
        result.matched ? WEBHOOK_LOG_STATUS.SUCCESS : WEBHOOK_LOG_STATUS.FAILED,
        event.eventLabel,
        event.raw,
        result.matched
          ? undefined
          : 'No matching payment or subscription invoice',
      );
      return result;
    } catch (err) {
      await this.record(
        WEBHOOK_LOG_STATUS.FAILED,
        event.eventLabel,
        event.raw,
        (err as Error)?.message,
      );
      throw err;
    }
  }

  private async handleRefund(posted: TapRefund): Promise<WebhookResult> {
    const label = `refund.${safeId(posted.status).toLowerCase()}`;

    const res = await this.client.getRefund(posted.id);
    if (!res.ok) {
      if (res.transient) {
        // Cannot confirm the refund right now: ask Tap to retry rather than trust
        // an unverified body. The reaper is the backstop.
        await this.record(
          'FAILED',
          label,
          sanitizeTapRefund(posted),
          'Could not re-fetch refund (transient)',
        );
        throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
          message: 'Payment gateway is temporarily unavailable',
          internalContext: {
            tapStatus: res.status,
            tapErrorCode: res.errorCode,
          },
        });
      }
      this.logger.error(
        `Tap refund ${safeId(posted.id)} could not be re-fetched (http ${res.status}, code ${res.errorCode ?? 'n/a'})`,
      );
      await this.record(
        'FAILED',
        label,
        sanitizeTapRefund(posted),
        `Re-fetch failed (http ${res.status})`,
      );
      return { accepted: true, matched: false };
    }

    const refund = res.json;
    if (!refund || refund.id !== posted.id) {
      this.logger.error(
        `Tap returned a different refund than requested for ${safeId(posted.id)}`,
      );
      await this.record(
        'FAILED',
        label,
        sanitizeTapRefund(posted),
        'Re-fetched refund id mismatch',
      );
      return { accepted: true, matched: false };
    }

    const event = this.toRefundEvent(refund);
    try {
      const result = await this.refunds.process(event);
      await this.record(
        result.matched ? WEBHOOK_LOG_STATUS.SUCCESS : WEBHOOK_LOG_STATUS.FAILED,
        event.eventLabel,
        event.raw,
        result.matched ? undefined : 'No matching payment',
      );
      return result;
    } catch (err) {
      await this.record(
        WEBHOOK_LOG_STATUS.FAILED,
        event.eventLabel,
        event.raw,
        (err as Error)?.message,
      );
      throw err;
    }
  }

  /** Reduce the RE-FETCHED refund to the neutral event. Tap vocabulary stops here. */
  private toRefundEvent(refund: TapRefund): GatewayRefundEvent {
    const outcome = mapRefundStatus(refund.status);
    const status = String(refund.status ?? 'unknown');
    return {
      provider: 'tap',
      gatewayRefundId: refund.id,
      gatewayPaymentId: refund.charge_id,
      outcome,
      amountMinorUnits: toDomainMinorUnits(refund.amount),
      currency: refund.currency,
      dedupeKey: `tap:${refund.id}:${status.toUpperCase()}`,
      eventLabel: `refund.${status.toLowerCase()}`,
      // Our refund id, when Tap echoes the `reference.merchant` we sent.
      correlationId: isUuid(refund.reference?.merchant)
        ? (refund.reference?.merchant as string)
        : undefined,
      failureReason:
        outcome === 'failed'
          ? 'Refund was rejected by the payment gateway'
          : undefined,
      raw: sanitizeTapRefund(refund),
    };
  }

  /**
   * Reduce the RE-FETCHED charge to the neutral event. Tap vocabulary stops here.
   *
   * A CAPTURED charge whose amount we cannot read is demoted to `pending`: the
   * domain reconciles captured-vs-expected before booking PAID, and "no figure"
   * would otherwise skip that check.
   */
  private toGatewayEvent(charge: TapCharge): GatewayWebhookEvent {
    const mapped = mapChargeStatus(charge.status);
    const amountMinor = toDomainMinorUnits(charge.amount);

    let target: GatewayWebhookTarget =
      mapped === 'paid' ? 'paid' : mapped === 'failed' ? 'failed' : 'pending';
    if (target === 'paid' && amountMinor === undefined) {
      this.logger.error(
        `Tap charge ${safeId(charge.id)} is CAPTURED without a readable amount — not applied`,
      );
      target = 'pending';
    }

    // Our id echoed back: `reference.transaction`, falling back to metadata.udf1.
    const echoed = [charge.reference?.transaction, charge.metadata?.udf1].find(
      isUuid,
    );
    const isInvoice = charge.metadata?.udf2 === 'subscription_invoice';
    if (isInvoice && target === 'paid') {
      // Subscription revenue is only booked when Tap says the charge belongs to
      // ZiyaraTech's own merchant (Tap books an unknown merchant.id to the
      // authenticated account). Otherwise it is held as `pending` for an operator.
      const routing = subscriptionChargeRouting(
        charge,
        this.config.tapMerchantId,
      );
      if (routing !== 'ok') {
        this.logger.error(subscriptionMisroutedLogLine(charge.id, routing));
        target = 'pending';
      }
    }
    const method = charge.source?.payment_method ?? charge.source?.type;
    const status = String(charge.status ?? 'unknown');

    return {
      provider: 'tap',
      gatewayPaymentId: charge.id,
      dedupeKey: `tap:${charge.id}:${status.toUpperCase()}`,
      target,
      eventLabel: `charge.${status.toLowerCase()}`,
      capturedMinorUnits: target === 'paid' ? amountMinor : undefined,
      capturedCurrency: target === 'paid' ? charge.currency : undefined,
      failureReason:
        target === 'failed'
          ? safeFailureReason(charge.response?.code, charge.status)
          : undefined,
      fees: {
        paymentMethod: method ? String(method).toLowerCase() : undefined,
      },
      correlationId: isInvoice ? undefined : echoed,
      subscriptionInvoiceId: isInvoice ? echoed : undefined,
      savedPaymentMethod:
        isInvoice && target === 'paid'
          ? extractSavedPaymentMethod(charge)
          : undefined,
      raw: sanitizeTapCharge(charge),
    };
  }

  /** Best-effort: a logging failure must never turn a processed webhook into an error. */
  private async record(
    status: string,
    eventType: string,
    payload: Record<string, any> | TapWebhookPayload,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.logs.record(null, {
        source: 'tap',
        eventType,
        payload,
        status,
        errorMessage,
      });
    } catch (err) {
      this.logger.warn(`webhook_logs write failed: ${(err as Error)?.message}`);
    }
  }
}
