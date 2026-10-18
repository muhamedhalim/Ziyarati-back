import type { TapCharge } from './tap.types';

/**
 * Where a ZiyaraTech SUBSCRIPTION charge landed, according to Tap itself.
 *
 * Tap does not reject a charge whose `merchant.id` it does not recognise: observed in
 * the sandbox (2026-10-04), such a charge is accepted and booked to the AUTHENTICATED
 * account. So the request alone proves nothing about where the money went — the
 * merchant Tap echoes on the charge is the evidence, and it must be ZiyaraTech's own
 * (`TAP_MERCHANT_ID`) before an invoice is activated or a payment page is handed out.
 *
 *  - `ok`         Tap says the charge belongs to the expected merchant.
 *  - `misrouted`  Tap says it belongs to a DIFFERENT merchant.
 *  - `unverified` Tap names no merchant, or no expected merchant is configured.
 */
export type SubscriptionRouting = 'ok' | 'misrouted' | 'unverified';

export function subscriptionChargeRouting(
  charge: Pick<TapCharge, 'merchant'> | undefined,
  expectedMerchantId: string | undefined,
): SubscriptionRouting {
  const expected = expectedMerchantId?.trim();
  const landedOn = charge?.merchant?.id
    ? String(charge.merchant.id).trim()
    : '';
  if (!expected || !landedOn) return 'unverified';
  return landedOn === expected ? 'ok' : 'misrouted';
}

/**
 * Pinned by `tap-alert-log-lines.spec.ts`: alarm infrastructure matches this exact text.
 */
export function subscriptionMisroutedLogLine(
  chargeId: unknown,
  routing: Exclude<SubscriptionRouting, 'ok'>,
): string {
  const id = String(chargeId ?? '')
    .replace(/[^\w:.-]/g, '_')
    .slice(0, 48);
  return (
    `ALERT: subscription charge ${id} was NOT routed to the ZiyaraTech merchant ` +
    `(${routing === 'misrouted' ? 'it belongs to another merchant' : 'routing could not be verified'}); not applied`
  );
}
