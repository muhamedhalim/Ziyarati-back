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

/**
 * What a `payments` row is FOR (`payments.purpose`, free-form varchar like the
 * other status-ish columns, so a new purpose never needs an ALTER).
 *
 * The distinction is financial, not cosmetic: BOOKING/MANUAL money belongs to
 * the CLINIC, while ADDON/BILLING_UPGRADE money is the clinic paying the
 * PLATFORM. Before this column existed the two were indistinguishable, so the
 * settlement run treated a clinic's add-on purchase as money owed back to it.
 */
export const PAYMENT_PURPOSE = {
  /** A patient paying a clinic for a booking. */
  BOOKING: 'BOOKING',
  /** Staff-entered payment with no appointment (POS style). Clinic money. */
  MANUAL: 'MANUAL',
  /** A clinic buying a resource add-on from the platform. Platform revenue. */
  ADDON: 'ADDON',
  /** A clinic paying the platform for a plan/feature upgrade. Platform revenue. */
  BILLING_UPGRADE: 'BILLING_UPGRADE',
} as const;

export type PaymentPurpose =
  (typeof PAYMENT_PURPOSE)[keyof typeof PAYMENT_PURPOSE];

/** Purposes whose money is owed to the clinic — the ONLY ones a settlement may claim. */
export const CLINIC_REVENUE_PURPOSES: readonly PaymentPurpose[] = [
  PAYMENT_PURPOSE.BOOKING,
  PAYMENT_PURPOSE.MANUAL,
];

/** Purposes where the clinic is the PAYER and the platform is the recipient. */
export const PLATFORM_REVENUE_PURPOSES: readonly PaymentPurpose[] = [
  PAYMENT_PURPOSE.ADDON,
  PAYMENT_PURPOSE.BILLING_UPGRADE,
];

export const isPlatformRevenuePurpose = (
  purpose: PaymentPurpose | undefined,
): boolean =>
  purpose !== undefined && PLATFORM_REVENUE_PURPOSES.includes(purpose);

/**
 * Who moves a payment's money to the clinic (`payments.settlement_mode`).
 *
 *  - INTERNAL — ZiyaraTech collected it and batches it into a `settlements`
 *    payout (the legacy / simulator model). The only mode the settlement run claims.
 *  - PROVIDER — the gateway settles straight to the clinic's own merchant
 *    account (Tap Platform). ZiyaraTech never holds the funds, so there is
 *    nothing to batch.
 *  - NONE     — nothing is owed to a clinic at all: the money IS the
 *    platform's revenue (ADDON / BILLING_UPGRADE).
 */
export const SETTLEMENT_MODE = {
  INTERNAL: 'INTERNAL',
  PROVIDER: 'PROVIDER',
  NONE: 'NONE',
} as const;

export type SettlementMode =
  (typeof SETTLEMENT_MODE)[keyof typeof SETTLEMENT_MODE];

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

/**
 * MerchantAccount.status values (free-form string column, Refund precedent).
 * The financial-onboarding state of a clinic. A clinic can accept LIVE payments
 * only in APPROVED; every other state fails `assertChargeable` with a clear
 * domain message. Transitions are enforced by MerchantAccountService.
 */
export const MERCHANT_ACCOUNT_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  PENDING_DOCUMENTS: 'PENDING_DOCUMENTS',
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  REQUIRES_ACTION: 'REQUIRES_ACTION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
} as const;

export type MerchantAccountStatusValue =
  (typeof MERCHANT_ACCOUNT_STATUS)[keyof typeof MERCHANT_ACCOUNT_STATUS];

/** Round monetary values to 2 decimal places (avoids float drift in totals). */
export const round2 = (n: number): number => Math.round(Number(n) * 100) / 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Ids echoed back by a gateway payload are untrusted input: never feed a
 * non-UUID to a uuid column (Postgres would throw and turn a webhook into a 500).
 */
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);
