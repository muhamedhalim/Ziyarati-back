/**
 * Tap Payments wire types and amount helpers.
 *
 * Only the fields this codebase actually reads are modelled; every interface
 * keeps an index signature because Tap adds fields over time and the global
 * ValidationPipe must never be asked to whitelist-strip a provider payload.
 *
 * Source of truth: https://developers.tap.company (verified 2026-10-01):
 *  - amounts are DECIMALS in the currency's major unit (SAR 49.99), not minor units
 *  - charge `transaction.created` is a millisecond-epoch STRING
 *  - a charge is successful ONLY at `status: CAPTURED`
 */

/** `source.id` values this integration uses. `src_all` = hosted page, every enabled method. */
export const TAP_SOURCE = {
  ALL: 'src_all',
  /** Hosted page restricted to cards (Visa, MasterCard, AMEX, mada). */
  CARD: 'src_card',
} as const;

/** `object` discriminator on a Tap webhook / API payload. */
export const TAP_OBJECT = {
  CHARGE: 'charge',
  REFUND: 'refund',
  AUTHORIZE: 'authorize',
} as const;

export interface TapReference {
  transaction?: string;
  order?: string;
  gateway?: string;
  payment?: string;
  track?: string;
  merchant?: string;
  idempotent?: string;
  [key: string]: unknown;
}

export interface TapCharge {
  id: string;
  object?: string;
  live_mode?: boolean;
  status?: string;
  /** Decimal major units. Tap returns a JSON number; tolerate a numeric string. */
  amount?: number | string;
  currency?: string;
  customer_initiated?: boolean;
  reference?: TapReference;
  transaction?: {
    /** Millisecond epoch, as a string. */
    created?: string;
    url?: string;
    expiry?: { period?: number; type?: string };
    [key: string]: unknown;
  };
  response?: { code?: string; message?: string };
  source?: {
    id?: string;
    object?: string;
    type?: string;
    payment_type?: string;
    payment_method?: string;
    channel?: string;
    [key: string]: unknown;
  };
  card?: {
    id?: string;
    scheme?: string;
    brand?: string;
    last_four?: string;
    first_six?: string;
    first_eight?: string;
    [key: string]: unknown;
  };
  customer?: { id?: string; [key: string]: unknown };
  /**
   * Present on a charge that saved a card (`save_card: true`) or was charged
   * on one. `contract.id` has been documented as the saved card id.
   */
  payment_agreement?: {
    id?: string;
    contract?: { id?: string; type?: string };
    [key: string]: unknown;
  };
  metadata?: Record<string, string>;
  merchant?: { id?: string };
  post?: { status?: string; url?: string; attempt?: number };
  redirect?: { status?: string; url?: string };
  [key: string]: unknown;
}

/** `POST /v2/tokens` result — `tok_…`, single use, valid 5 minutes. */
export interface TapToken {
  id: string;
  object?: string;
  status?: string;
  used?: boolean;
  [key: string]: unknown;
}

export interface TapRefund {
  id: string;
  object?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  charge_id?: string;
  /** Top-level on a refund (a charge carries it under `transaction`). */
  created?: string;
  reference?: TapReference;
  response?: { code?: string; message?: string };
  [key: string]: unknown;
}

/**
 * `POST /v3/lead` result. Tap documents the response only as the echo of the
 * request plus an `id` (`led_…`); no onboarding-state field is documented, so
 * none is modelled.
 */
export interface TapLead {
  id: string;
  object?: string;
  [key: string]: unknown;
}

/**
 * `POST /v3/connect` result: the hosted onboarding page the clinic is sent to.
 * Documented as `connect.url` (a shortened URL); the `token` and `operator`
 * fields it also returns are never read or stored.
 */
export interface TapConnect {
  id?: string;
  connect?: { url?: string };
  [key: string]: unknown;
}

/** `POST /v2/charges/list` result. */
export interface TapChargeList {
  object?: string;
  count?: number;
  has_more?: boolean;
  charges?: TapCharge[];
  [key: string]: unknown;
}

/**
 * One payout in `POST /v2/payouts/list`. The `wallet.bank.beneficiary.iban` the
 * response also carries is deliberately NOT modelled: ZiyaraTech never stores or
 * reads a clinic's IBAN (Tap's hosted pages hold it).
 */
export interface TapPayout {
  id: string;
  /** `PAID_OUT` is the documented example; the full list is not published. */
  status?: string;
  /** Unix milliseconds. */
  date?: number | string;
  /** Documented as an integer in the schema; treated as the currency's MAJOR unit (UNVERIFIED — see the Phase 5 doc). */
  amount?: number | string;
  currency?: string;
  merchant_id?: string;
  bank_reference?: string;
  settlements_available?: boolean;
  [key: string]: unknown;
}

export interface TapPayoutList {
  object?: string;
  count?: number;
  has_more?: boolean;
  payouts?: TapPayout[];
  [key: string]: unknown;
}

/** A Tap webhook body IS the object itself (charge/refund/…) — there is no envelope and no event id. */
export type TapWebhookPayload = TapCharge | TapRefund;

/** Currencies Tap quotes to 3 decimals; everything else (incl. SAR) is 2. */
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'KWD', 'OMR', 'JOD']);

export function currencyDecimals(currency: string | undefined): number {
  return THREE_DECIMAL_CURRENCIES.has(String(currency ?? '').toUpperCase())
    ? 3
    : 2;
}

/**
 * Canonical amount text for the webhook signature ("rounded with standard
 * decimal value" per ISO currency decimals): SAR 1 → "1.00", KWD 1 → "1.000".
 * Returns null when the amount is absent or not a finite number so a malformed
 * payload can never produce a signature that happens to match.
 */
export function formatTapAmount(
  amount: number | string | undefined | null,
  currency: string | undefined,
): string | null {
  if (amount === undefined || amount === null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(currencyDecimals(currency));
}

/** Request-body amount: a JSON number rounded to the currency's decimals. */
export function toTapAmount(amount: number, currency: string): number {
  return Number(Number(amount).toFixed(currencyDecimals(currency)));
}

/**
 * The domain compares captured amounts in integer cents (`round(amount*100)`)
 * everywhere (`assertCapturedMatches`, reconciliation, webhook). Tap reports
 * major units, so convert with the same ×100 the domain uses — NOT the
 * currency's own minor unit — to keep that comparison apples-to-apples.
 */
export function toDomainMinorUnits(
  amount: number | string | undefined,
): number | undefined {
  if (amount === undefined || amount === null || amount === '')
    return undefined;
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}
