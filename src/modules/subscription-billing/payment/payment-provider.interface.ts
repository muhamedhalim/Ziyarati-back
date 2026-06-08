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

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}

/** DI token for the payment provider implementation. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
