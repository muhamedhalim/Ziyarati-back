import type { SavedPaymentMethodInfo } from '../../../subscription-billing/payment/payment-provider.interface';
import type { TapCharge } from './tap.types';

/** Schemes Tap documents as NOT usable for recurring charges. */
const NON_RECURRING_SCHEMES = new Set(['KNET', 'BENEFIT', 'STC_PAY', 'STCPAY']);

/**
 * The card a hosted charge SAVED, read from the (re-fetched) Tap charge — the
 * single parser used by the subscription adapter AND the webhook handler, so
 * the two can never disagree about what counts as a saved method.
 *
 * Returns undefined when the charge saved nothing (recurring off, or a method
 * Tap cannot save). All three ids are required: with any one missing a
 * merchant-initiated charge cannot be made, so a half-record would only look
 * usable. Ids and display facts only — there is no PAN, expiry or CVV on a
 * Tap charge to begin with.
 *
 * The saved card id has been documented both as `card.id` and as the payment
 * agreement's `contract.id`; either is accepted (sandbox validation confirms
 * which the account returns).
 */
export function extractSavedPaymentMethod(
  charge: TapCharge,
): SavedPaymentMethodInfo | undefined {
  const customerId = charge.customer?.id;
  const agreementId = charge.payment_agreement?.id;
  const cardId = charge.card?.id ?? charge.payment_agreement?.contract?.id;
  if (!customerId || !agreementId || !cardId) return undefined;

  const scheme = String(
    charge.card?.scheme ?? charge.source?.payment_method ?? '',
  )
    .trim()
    .toUpperCase();
  return {
    provider: 'tap',
    customerId,
    cardId,
    agreementId,
    brand: charge.card?.brand ? String(charge.card.brand) : undefined,
    scheme: scheme || undefined,
    lastFour: charge.card?.last_four
      ? String(charge.card.last_four).slice(-4)
      : undefined,
    recurringCapable: !NON_RECURRING_SCHEMES.has(scheme),
  };
}
