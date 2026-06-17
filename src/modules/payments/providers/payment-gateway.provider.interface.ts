/**
 * Payment GATEWAY provider abstraction.
 *
 * The Payments domain depends ONLY on this interface — never on Moyasar (or any
 * other gateway SDK/HTTP) directly. Concrete adapters (MoyasarProvider, …) are
 * registered into the `PAYMENT_GATEWAY_PROVIDERS` array and resolved by
 * `PaymentGatewayFactory`, so the gateway is swappable and the domain logic
 * stays testable.
 *
 * Credentials live ONLY at the platform/config layer (ConfigService) inside the
 * concrete adapter — they are never passed down from, or exposed to, a tenant.
 */

export interface GatewayCreatePaymentRequest {
  /** Owning tenant (used only as opaque correlation metadata for the gateway). */
  tenantId: string;
  /** Our internal Payment id — correlates the gateway record back to ours. */
  paymentId: string;
  /** Amount in MAJOR units (e.g. 49.99). Adapters convert to the gateway's unit. */
  amount: number;
  currency: string;
  description?: string;
  /** Where the gateway should return the payer after a hosted-page/3DS flow. */
  callbackUrl?: string;
  /** Free-form, client-safe metadata forwarded to the gateway. NEVER secrets. */
  metadata?: Record<string, string>;
  /** Makes the create call safe to retry without double-charging. */
  idempotencyKey?: string;
}

/** Normalized gateway status — the domain never sees provider-specific strings. */
export type GatewayPaymentStatus = 'pending' | 'paid' | 'failed';

export interface GatewayPaymentResult {
  success: boolean;
  /** Opaque provider payment id, persisted as `Payment.gateway_payment_id`. */
  gatewayPaymentId?: string;
  status: GatewayPaymentStatus;
  /** Hosted payment-page / 3DS redirect, when the provider returns one. */
  redirectUrl?: string;
  failureReason?: string;
  /**
   * Cumulative amount refunded so far, in the smallest unit (e.g. halalas).
   * Returned by `verifyPayment` and used by the refund reaper to confirm whether
   * a stuck PENDING refund actually settled at the gateway. `undefined` when the
   * provider cannot report it (caller must not assume zero).
   */
  refundedMinorUnits?: number;
  /** Raw provider response — persisted on `Transaction.raw_response` for audit. */
  raw?: Record<string, any>;
}

export interface GatewayRefundRequest {
  tenantId: string;
  paymentId: string;
  gatewayPaymentId: string;
  /** Partial-refund amount in MAJOR units. */
  amount: number;
  currency: string;
  reason?: string;
}

export interface GatewayRefundResult {
  success: boolean;
  gatewayRefundId?: string;
  failureReason?: string;
  raw?: Record<string, any>;
}

export interface PaymentGatewayProvider {
  /** Stable gateway identifier, stored on `Payment.gateway` (e.g. 'moyasar'). */
  readonly name: string;

  /**
   * Strategy selection. Returns true when this provider should handle the given
   * gateway name. A concrete adapter also returns false when it is not
   * configured (missing credentials), so the factory can fall back to Noop.
   */
  supports(gatewayName?: string): boolean;

  createPayment(request: GatewayCreatePaymentRequest): Promise<GatewayPaymentResult>;
  verifyPayment(gatewayPaymentId: string): Promise<GatewayPaymentResult>;
  refundPayment(request: GatewayRefundRequest): Promise<GatewayRefundResult>;
}

/** DI token for the array of registered gateway providers. */
export const PAYMENT_GATEWAY_PROVIDERS = Symbol('PAYMENT_GATEWAY_PROVIDERS');
