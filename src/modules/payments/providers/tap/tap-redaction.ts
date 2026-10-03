import type { TapCharge, TapRefund } from './tap.types';

/**
 * Allow-list sanitiser for Tap objects BEFORE they are persisted.
 *
 * Tap objects land in `transactions.raw_response` (readable through the
 * tenant-facing transactions API with `payments.read`) and in `webhook_logs`.
 * A charge carries payer PII (name, email, phone) and card BIN digits
 * (`first_six`/`first_eight`), none of which a clinic user or a log reader
 * needs. An allow-list is used rather than a deny-list so a field Tap adds
 * tomorrow is excluded by default, not leaked by default.
 *
 * Kept: ids, status, amount/currency, our own references/metadata, response
 * code/message, 3DS status, payment method + card scheme/brand/last four.
 * Dropped: customer PII, BIN digits, saved-card ids, hosted-page URL (carries a
 * session token), receipts, activities.
 */

const pick = <T extends Record<string, any>>(
  obj: T | undefined,
  keys: readonly string[],
): Record<string, any> | undefined => {
  if (!obj || typeof obj !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : undefined;
};

const drop = (o: Record<string, any>): Record<string, any> => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

export function sanitizeTapCharge(charge: TapCharge): Record<string, any> {
  return drop({
    id: charge.id,
    object: charge.object,
    live_mode: charge.live_mode,
    status: charge.status,
    amount: charge.amount,
    currency: charge.currency,
    customer_initiated: charge.customer_initiated,
    threeDSecure: charge.threeDSecure,
    save_card: charge.save_card,
    description: charge.description,
    metadata: charge.metadata,
    reference: charge.reference,
    response: pick(charge.response, ['code', 'message']),
    security: pick((charge as any).security?.threeDSecure, ['status'])
      ? {
          threeDSecure: pick((charge as any).security.threeDSecure, ['status']),
        }
      : undefined,
    transaction: pick(charge.transaction, [
      'created',
      'timezone',
      'expiry',
      'amount',
      'currency',
    ]),
    source: pick(charge.source, [
      'object',
      'type',
      'payment_type',
      'payment_method',
      'channel',
      'id',
    ]),
    card: pick(charge.card, [
      'scheme',
      'brand',
      'last_four',
      'type',
      'category',
    ]),
    customer: pick(charge.customer, ['id']),
    merchant: pick(charge.merchant, ['id']),
    post: pick(charge.post, ['status', 'attempt']),
    redirect: pick(charge.redirect, ['status']),
    payment_agreement: pick((charge as any).payment_agreement, ['id', 'type']),
  });
}

export function sanitizeTapRefund(refund: TapRefund): Record<string, any> {
  return drop({
    id: refund.id,
    object: refund.object,
    status: refund.status,
    amount: refund.amount,
    currency: refund.currency,
    charge_id: refund.charge_id,
    created: refund.created,
    reason: refund.reason,
    reference: refund.reference,
    response: pick(refund.response, ['code', 'message']),
    merchant: pick(refund.merchant as any, ['id']),
  });
}
