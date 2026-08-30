/**
 * Payment provider abstraction.
 *
 * The billing layer depends ONLY on this interface — never on Stripe/PayPal/etc.
 * directly. A concrete adapter (StripePaymentProvider, …) can be bound to the
 * `PAYMENT_PROVIDER` token later without touching BillingService. This keeps
 * the payment integration swappable and the domain logic testable.
 */
export interface ChargeRequest {
  tenantId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  /** Free-form metadata forwarded to the provider (never persisted with secrets). */
  metadata?: Record<string, string>;
}

export interface ChargeResult {
  success: boolean;
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
  raw?: unknown;
}

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  verifyCharge(invoiceId: string): Promise<VerifyChargeResult>;
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
