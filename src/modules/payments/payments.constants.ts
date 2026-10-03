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
 * Per-IP throttles for the `@Public()` patient pay routes. Same shape as
 * `PATIENT_ACTION_LINK_*_THROTTLE`: the platform-wide default is far too loose
 * for routes reachable by anyone holding (or guessing at) a link, and `checkout`
 * can create a charge at the gateway, so it is the tightest.
 */
const publicThrottle = (limit: number) => ({
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : limit,
    ttl: 60_000,
  },
});
export const PUBLIC_PAY_RESOLVE_THROTTLE = publicThrottle(60);
export const PUBLIC_PAY_CHECKOUT_THROTTLE = publicThrottle(10);
export const PUBLIC_PAY_RETURN_THROTTLE = publicThrottle(30);
/** The Tap onboarding callback: low volume by nature (a handful per clinic, ever). */
export const TAP_ONBOARDING_CALLBACK_THROTTLE = publicThrottle(20);

/**
 * Why a clinic cannot take an online booking payment right now. Reason CODES
 * only — what a patient sees is chosen by the frontend, so no gateway or
 * onboarding detail ever leaks through a public response.
 */
export const ONLINE_PAYMENT_UNAVAILABLE = {
  /** `TAP_BOOKING_PAYMENTS_ENABLED` is off. */
  DISABLED: 'DISABLED',
  /** The platform has no usable Tap credentials / `TAP_PLATFORM_ID`. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** The clinic has no APPROVED Tap merchant with a merchant id. */
  CLINIC_NOT_ONBOARDED: 'CLINIC_NOT_ONBOARDED',
} as const;

export type OnlinePaymentUnavailableReason =
  (typeof ONLINE_PAYMENT_UNAVAILABLE)[keyof typeof ONLINE_PAYMENT_UNAVAILABLE];

/**
 * A "connect" claim older than this is treated as abandoned (the process that
 * took it died between claiming and creating the lead), so a retry may proceed.
 */
export const TAP_ONBOARDING_CLAIM_STALE_MS = 2 * 60_000;

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

/**
 * Shape check for a provider-issued merchant id (Tap `merchant_…`, or a numeric
 * legacy MID). It is interpolated into a charge request and into logs, so
 * anything outside a conservative token charset is refused outright.
 */
export const isProviderMerchantId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(v);

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
