import type { GatewayPaymentStatus } from '../payment-gateway.provider.interface';

/**
 * The ONE table that turns Tap vocabulary into the domain's. Nothing outside
 * `providers/tap` and `webhooks/tap-*` ever sees a Tap status string.
 *
 * Charge statuses (https://developers.tap.company/reference/charges):
 *   INITIATED, IN_PROGRESS, ABANDONED, CANCELLED, FAILED, DECLINED, RESTRICTED,
 *   CAPTURED, VOID, TIMEDOUT, UNKNOWN   (AUTHORIZED exists for /authorize only)
 *
 * Only CAPTURED is success. Anything we cannot positively classify maps to
 * `unknown` — NEVER to `failed`: a failed payment frees the one-PENDING guard
 * and permits a second charge, which is unacceptable for money that may in
 * fact have been captured.
 */
export function mapChargeStatus(
  status: string | undefined,
): GatewayPaymentStatus {
  switch (
    String(status ?? '')
      .trim()
      .toUpperCase()
  ) {
    case 'CAPTURED':
      return 'paid';
    case 'INITIATED':
    case 'IN_PROGRESS':
    case 'PENDING':
    case 'AUTHORIZED': // not expected on /charges — treated as "not settled yet"
      return 'pending';
    case 'ABANDONED':
    case 'CANCELLED':
    case 'FAILED':
    case 'DECLINED':
    case 'RESTRICTED':
    case 'VOID':
    case 'TIMEDOUT':
    case 'TIMED_OUT':
      return 'failed';
    default:
      return 'unknown'; // UNKNOWN or any value we have not mapped
  }
}

export type TapRefundOutcome = 'succeeded' | 'pending' | 'failed' | 'unknown';

/**
 * Refund statuses: `PENDING` means Tap is still checking the merchant wallet
 * balance — NOT a failure. Refund Logic V2 (beta) adds ACCEPTED/REJECTED.
 */
export function mapRefundStatus(status: string | undefined): TapRefundOutcome {
  switch (
    String(status ?? '')
      .trim()
      .toUpperCase()
  ) {
    case 'REFUNDED':
      return 'succeeded';
    case 'PENDING':
    case 'IN_PROGRESS':
    case 'ACCEPTED':
      return 'pending';
    case 'DECLINED':
    case 'FAILED':
    case 'RESTRICTED':
    case 'REJECTED':
    case 'CANCELLED':
      return 'failed';
    default:
      return 'unknown'; // TIMED_OUT, UNKNOWN, unmapped
  }
}

/**
 * A short, user-safe reason by Tap response-code family. The raw
 * `response.message` is deliberately NOT used: provider decline text must not
 * be returned verbatim (FND-030). The numeric code is kept separately in
 * `failureCode` for logs and audit.
 *
 * Families (https://developers.tap.company/reference/charge-response-codes):
 * 301 abandoned · 302 cancelled · 304 expired · 401–408 failed · 501–516
 * declined · 701–704 restricted · 801 timed out.
 */
export function safeFailureReason(
  code: string | undefined,
  status?: string,
): string {
  const n = Number(code);
  if (n === 301 || String(status).toUpperCase() === 'ABANDONED') {
    return 'Payment was not completed';
  }
  if (n === 302 || String(status).toUpperCase() === 'CANCELLED') {
    return 'Payment was cancelled';
  }
  if (n === 304) return 'Payment session expired';
  if (n === 801 || /^TIMED_?OUT$/i.test(String(status))) {
    return 'Payment timed out';
  }
  if (n >= 501 && n <= 516) return 'Payment was declined by the card issuer';
  if (n >= 701 && n <= 704) return 'Payment method is not permitted';
  if (n >= 401 && n <= 408) return 'Payment failed';
  if (String(status).toUpperCase() === 'DECLINED') {
    return 'Payment was declined by the card issuer';
  }
  return 'Payment failed';
}
