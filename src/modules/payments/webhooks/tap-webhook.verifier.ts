import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { constantTimeEqual } from '../../../common/utils/constant-time.util';
import { PaymentsConfig } from '../payments.config';
import {
  TAP_OBJECT,
  formatTapAmount,
  type TapCharge,
  type TapRefund,
  type TapWebhookPayload,
} from '../providers/tap/tap.types';

/**
 * Tap webhook authenticity check.
 *
 * Tap signs the POST body fields (NOT the raw bytes) with HMAC-SHA256 keyed by
 * the merchant SECRET key and sends the hex digest in the `hashstring` header
 * (https://developers.tap.company/docs/webhook, verified 2026-10-01). For a
 * charge / authorize / refund the signed string is:
 *
 *   x_id{id}x_amount{amount}x_currency{currency}
 *   x_gateway_reference{reference.gateway}x_payment_reference{reference.payment}
 *   x_status{status}x_created{created}
 *
 * with `created` = `transaction.created` for a charge/authorize and the
 * top-level `created` for a refund, an absent reference as an empty string, and
 * the amount rounded to the currency's ISO decimals (SAR "1.00", KWD "1.000").
 *
 * FAIL-CLOSED, with no dev bypass: without the secret key there is no way to
 * authenticate a delivery, and no way to re-fetch the object from Tap either
 * (the handler does that before trusting anything), so a "dev accept" branch
 * would only be an attack surface. Tests supply a key and a real signature.
 *
 * What the signature does NOT cover — `metadata`, `merchant`, `reference.transaction`
 * — is exactly why the handler never trusts the body for state: it re-fetches
 * the charge from Tap with our own key.
 */
@Injectable()
export class TapWebhookVerifier {
  private readonly logger = new Logger('TapWebhookVerifier');

  constructor(private readonly config: PaymentsConfig) {}

  verify(
    payload: TapWebhookPayload | undefined,
    hashstring: string | undefined,
  ): boolean {
    const secret = this.config.tapSecretKey;
    if (!secret) {
      this.logger.error(
        'Tap secret key not configured for TAP_ENV — rejecting webhook',
      );
      return false;
    }
    if (typeof hashstring !== 'string' || hashstring.trim() === '')
      return false;

    const canonical = this.canonicalString(payload);
    if (canonical === null) return false;

    const expected = createHmac('sha256', secret)
      .update(canonical)
      .digest('hex');
    return constantTimeEqual(expected, hashstring.trim().toLowerCase());
  }

  /**
   * The exact string Tap signs, or null when the payload is not one we can
   * authenticate (unsupported `object`, missing id/status/amount/currency).
   * Exposed for tests; never log its value — it embeds amounts and ids.
   */
  canonicalString(payload: TapWebhookPayload | undefined): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const object = String(payload.object ?? '');
    if (
      object !== TAP_OBJECT.CHARGE &&
      object !== TAP_OBJECT.AUTHORIZE &&
      object !== TAP_OBJECT.REFUND
    ) {
      return null;
    }
    if (!payload.id || !payload.status || !payload.currency) return null;

    const amount = formatTapAmount(payload.amount, payload.currency);
    if (amount === null) return null;

    const created =
      object === TAP_OBJECT.REFUND
        ? (payload as TapRefund).created
        : (payload as TapCharge).transaction?.created;
    if (created === undefined || created === null || created === '')
      return null;

    const reference = payload.reference ?? {};
    return (
      `x_id${payload.id}` +
      `x_amount${amount}` +
      `x_currency${payload.currency}` +
      `x_gateway_reference${reference.gateway ?? ''}` +
      `x_payment_reference${reference.payment ?? ''}` +
      `x_status${payload.status}` +
      `x_created${created}`
    );
  }
}
