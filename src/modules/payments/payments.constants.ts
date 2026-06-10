/**
 * Payments domain constants.
 *
 * Currency: Moyasar settles in SAR (Saudi Arabia), so the domain DEFAULTS to
 * SAR when a caller does not specify one. The entities keep their own column
 * default ('USD') untouched — this is purely the application-layer default and
 * never mutates the frozen schema.
 */
export const DEFAULT_PAYMENT_CURRENCY = 'SAR';

/** Number of random bytes used to mint a public, unguessable payment-link token. */
export const PAYMENT_LINK_TOKEN_BYTES = 24;

/** Default lifetime of a payment link when the caller does not pass an expiry. */
export const DEFAULT_PAYMENT_LINK_TTL_HOURS = 72;

/** Transaction.type values — the kind of gateway interaction being logged. */
export const TRANSACTION_TYPE = {
  CHARGE: 'charge',
  VERIFY: 'verify',
  WEBHOOK: 'webhook',
  REFUND: 'refund',
} as const;

/** Refund.status values (the entity stores a free-form string, not an enum). */
export const REFUND_STATUS = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

/** PaymentLink.status values (free-form string column). */
export const PAYMENT_LINK_STATUS = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  USED: 'USED',
  EXPIRED: 'EXPIRED',
} as const;

/** Round monetary values to 2 decimal places (avoids float drift in totals). */
export const round2 = (n: number): number => Math.round(Number(n) * 100) / 100;
