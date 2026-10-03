/**
 * Payment provider abstraction.
 *
 * The billing layer depends ONLY on this interface — never on Stripe/PayPal/etc.
 * directly. A concrete adapter (StripePaymentProvider, …) can be bound to the
 * `PAYMENT_PROVIDER` token later without touching BillingService. This keeps
 * the payment integration swappable and the domain logic testable.
 */

/**
 * Who is paying — only what a hosted checkout needs. Structurally identical to
 * the payments module's `GatewayPayer` (deliberately re-declared: this module is
 * imported BY the payments module, so it must not import back).
 */
export interface PaymentPayer {
  firstName: string;
  lastName?: string;
  email?: string;
  /** Digits only: country calling code without '+' and the national number. */
  phone?: { countryCode: string; number: string };
}

/**
 * The provider-side ids a merchant-initiated (clinic-not-present) charge needs.
 * Opaque to the domain: only the adapter that issued them can read them.
 */
export interface SavedPaymentMethodRef {
  customerId: string;
  cardId: string;
  agreementId: string;
}

/**
 * A card the payer saved during a hosted checkout, as the provider reports it.
 * Never contains a PAN, CVV or expiry — ids and display facts only.
 */
export interface SavedPaymentMethodInfo extends SavedPaymentMethodRef {
  provider: string;
  brand?: string;
  scheme?: string;
  lastFour?: string;
  /** FALSE for a scheme the provider cannot charge without the payer present. */
  recurringCapable: boolean;
}

export interface ChargeRequest {
  tenantId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  /** Free-form metadata forwarded to the provider (never persisted with secrets). */
  metadata?: Record<string, string>;
  /**
   * The clinic's saved card, for a merchant-initiated charge. A provider that
   * cannot charge without one (Tap) answers `TOKENIZATION_UNAVAILABLE` when it
   * is absent; a provider that never needed one (stub) ignores it.
   */
  paymentMethod?: SavedPaymentMethodRef;
  /**
   * The invoice's charge-attempt number (its `retry_count`). Makes the
   * provider-side idempotency key unique per attempt while staying STABLE across
   * a retry of the SAME attempt, so a lost response can never become a second
   * capture.
   */
  attempt?: number;
  /** Who the charge is billed to (the clinic's contact) — some providers require it. */
  payer?: PaymentPayer;
}

export interface ChargeResult {
  success: boolean;
  /**
   * `pending` = the provider accepted the charge but cannot say yet whether it
   * was captured (async method, timeout, 5xx). The caller KEEPS the claim and
   * leaves the invoice OPEN; the webhook / reconciliation sweep settles it.
   * Omitted = derived from `success` (true → paid, false → failed), which is how
   * every pre-existing provider answers.
   */
  status?: 'paid' | 'failed' | 'pending';
  /** Opaque provider reference (e.g. Stripe PaymentIntent id). */
  reference?: string;
  failureReason?: string;
  /**
   * T081 (spec 014, US5) — coarse, additive-only decline classification
   * (mirrors `APPOINTMENT_AUDIT_ACTION`'s convention). Undefined means an
   * ordinary provider decline; a provider that fails a charge for a
   * structural reason (not yet a card issue) sets this so callers can tell
   * "we cannot charge yet" apart from "the card was declined" without
   * string-matching `failureReason`.
   */
  failureClass?: string;
  /** The card that was charged, when the provider reports it (display + recurring flag). */
  savedPaymentMethod?: SavedPaymentMethodInfo;
}

export interface RefundRequest {
  tenantId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  reason?: string;
}

export interface RefundResult {
  success: boolean;
  reference?: string;
  failureReason?: string;
}

/**
 * T084 (spec 014, US5, FR-B016) — recovers a "lost confirmation": a charge
 * whose synchronous `charge()` response never made it back (e.g. a worker
 * crash between the provider call and recording the outcome). Looked up by
 * OUR invoice id, not a gateway reference — `payInvoice`'s stuck-claim
 * scenario leaves no `provider_reference` recorded either way, so a real
 * provider must search its own records by the `subscriptionInvoiceId`
 * metadata every `charge()` call already carries.
 */
export interface VerifyChargeResult {
  /** 'unknown' — the provider has no record, or cannot say (safe default:
   *  never claims 'paid' without evidence). */
  status: 'paid' | 'failed' | 'pending' | 'unknown';
  reference?: string;
  capturedMinorUnits?: number;
  capturedCurrency?: string;
  failureReason?: string;
  /** The card saved by this charge, when it was a save-card checkout. */
  savedPaymentMethod?: SavedPaymentMethodInfo;
  raw?: unknown;
}

/** A hosted checkout to open for one invoice (the payer is PRESENT: 3-D Secure applies). */
export interface CheckoutRequest {
  tenantId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  description?: string;
  /** This invoice's n-th hosted checkout — part of the provider idempotency key. */
  attempt: number;
  payer: PaymentPayer;
  /** Save the card for later merchant-initiated charges (the renewal job). */
  saveCard: boolean;
  /** SERVER-built URL the payer returns to. Never client-supplied. */
  returnUrl: string;
}

export interface CheckoutResult {
  /**
   * `created` — a hosted page exists, send the payer to `redirectUrl`.
   * `failed`  — nothing was created (bad request / not configured): safe to retry.
   * `unknown` — the provider may or may not have created it (timeout, 5xx): the
   *             caller must NOT treat it as failed.
   */
  status: 'created' | 'failed' | 'unknown';
  redirectUrl?: string;
  /** Provider charge id, persisted so the checkout can be resumed / verified. */
  chargeId?: string;
  /** Provider response code, for logs/audit only — never shown to a user. */
  failureCode?: string;
  /** User-safe text. */
  failureReason?: string;
}

/** What the provider says about one hosted checkout charge, by ITS id. */
export interface VerifyCheckoutResult {
  status: 'paid' | 'failed' | 'pending' | 'unknown';
  /**
   * With status `unknown`: TRUE when the provider DEFINITIVELY does not know this
   * charge (a 4xx answer), as opposed to being unreachable (timeout / 5xx / 429).
   * A caller answering an end user treats it exactly like a charge that belongs to
   * someone else — otherwise the difference would tell a prober which charge ids
   * exist — while a real outage stays "try again shortly".
   */
  notFound?: boolean;
  chargeId?: string;
  /**
   * OUR invoice id, as echoed back by the provider (`reference`/`metadata` we
   * set at creation). The caller still checks it belongs to the calling tenant
   * and that `chargeId` is the one issued for it — never trusts it alone.
   */
  invoiceId?: string;
  capturedMinorUnits?: number;
  capturedCurrency?: string;
  /** Present while `pending`: where the payer can resume the same hosted page. */
  redirectUrl?: string;
  failureReason?: string;
  savedPaymentMethod?: SavedPaymentMethodInfo;
}

export interface PaymentProvider {
  /** Stored on `subscription_invoices.provider` when this provider settles one. */
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  /**
   * `reference` = the provider charge id already on the invoice (its
   * `provider_reference` or last hosted checkout), when one is known.
   */
  verifyCharge(
    invoiceId: string,
    reference?: string,
  ): Promise<VerifyChargeResult>;

  /**
   * TRUE when this provider can take a payment from a PRESENT payer through a
   * hosted page. It is the switch for decision D2: only then does a paid
   * subscription start PENDING_PAYMENT (and wait for the payment). A provider
   * that cannot (the production stand-in, the dev stub) keeps the legacy
   * "ACTIVE + open invoice" behaviour, so nothing is ever locked behind a
   * payment that cannot be made.
   */
  readonly supportsCheckout: boolean;
  /** Minutes a hosted checkout stays payable (a fresh one blocks a merchant-initiated charge of the same invoice). */
  readonly checkoutWindowMinutes: number;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  verifyCheckout(chargeId: string): Promise<VerifyCheckoutResult>;
  /** Best-effort removal of a saved card at the provider. Resolves false when it could not be confirmed. */
  deletePaymentMethod(method: SavedPaymentMethodRef): Promise<boolean>;
}

/** DI token for the payment provider implementation. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * T089 (spec 014, US5, FR-B005e) — the `failureClass` value `RecurringUnavailableProvider`
 * sets on every decline. Shared so `BillingService.listTokenizationDeclines()`
 * filters on the same literal the provider writes, never a re-typed copy.
 */
export const FAILURE_CLASS_TOKENIZATION_UNAVAILABLE =
  'TOKENIZATION_UNAVAILABLE';
