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
  /**
   * @deprecated Client-influenced return URLs are an open redirect; use the
   * server-built `returnUrl`. Only the legacy Moyasar adapter still reads this,
   * and `PaymentService` no longer sets it.
   */
  callbackUrl?: string;
  /** Free-form, client-safe metadata forwarded to the gateway. NEVER secrets. */
  metadata?: Record<string, string>;
  /** Makes the create call safe to retry without double-charging. */
  idempotencyKey?: string;
  /**
   * SERVER-BUILT URL the gateway returns the payer to after a hosted-page/3DS
   * flow. Never client-supplied: a caller-controlled return URL is an open
   * redirect. Gateways that require one (Tap: `redirect.url`) read this field.
   */
  returnUrl?: string;
  /**
   * Provider id of the merchant of record for this charge (Tap Platform: the
   * clinic's `merchant_…`). Undefined = the platform's own account.
   * Adapters without a merchant-routing concept MUST ignore it.
   */
  settlementMerchantId?: string;
  /** Payer identity, for gateways that require one (see `requiresPayerDetails`). */
  customer?: GatewayPayer;
  /**
   * WHO the money is for. `clinic` = a patient paying a clinic (funds must be
   * routed to the clinic's merchant via `settlementMerchantId`); `platform` =
   * a tenant paying ZiyaraTech itself (subscription, add-on). A gateway that can
   * route to a clinic must REFUSE a `clinic` charge that has no routing rather
   * than let patient funds land in the platform account.
   */
  payee?: 'platform' | 'clinic';
  /** Business reference the gateway echoes back (e.g. the appointment id). */
  reference?: { order?: string };
  /**
   * Marketplace split instructions (documented Moyasar `splits`): route part of
   * the charge to a provider-issued recipient (the clinic's sub-merchant).
   * Amounts are in MAJOR units. Only attached when the marketplace feature is
   * contractually enabled AND the clinic has a `provider_recipient_id`;
   * adapters for gateways without split support MUST ignore this field (the
   * internal ledger still records the clinic's net for manual settlement).
   */
  splits?: Array<{
    recipientId: string;
    amount: number;
    reference?: string;
    /** Marks the split as the platform's fee/commission (provider semantics). */
    feeSource?: boolean;
    refundable?: boolean;
  }>;
}

/** Who is paying — only what a gateway needs to create a charge. */
export interface GatewayPayer {
  firstName: string;
  lastName?: string;
  email?: string;
  /** Digits only: country calling code without '+' and the national number. */
  phone?: { countryCode: string; number: string };
}

/** Fee facts a gateway reports for a charge (all optional; major units). */
export interface GatewayFeeInfo {
  gatewayFee?: number;
  paymentMethod?: string;
}

/**
 * Normalized gateway status — the domain never sees provider-specific strings.
 *
 * 'unknown' means the gateway could NOT say (transport error, timeout, 5xx,
 * 429, an unmapped status). It is NOT a failure: callers must leave the payment
 * untouched and let a later verify/webhook/reconcile settle it. Mapping an
 * outage to 'failed' would drop the one-PENDING guard and allow a second
 * charge for money that may already have been captured.
 */
export type GatewayPaymentStatus = 'pending' | 'paid' | 'failed' | 'unknown';

export interface GatewayPaymentResult {
  success: boolean;
  /** Opaque provider payment id, persisted as `Payment.gateway_payment_id`. */
  gatewayPaymentId?: string;
  status: GatewayPaymentStatus;
  /** Hosted payment-page / 3DS redirect, when the provider returns one. */
  redirectUrl?: string;
  failureReason?: string;
  /** Provider response code behind a failure — for logs/audit, never shown to users. */
  failureCode?: string;
  /**
   * Our own correlation id echoed back by the gateway (Tap: `reference.transaction`,
   * set to the Payment id). Lets a webhook find a payment whose gateway id was
   * never persisted (REL-002).
   */
  correlationId?: string;
  /**
   * Fee facts parsed BY THE ADAPTER. When present the domain uses this instead
   * of the legacy Moyasar-shaped `PaymentFinancialsService.extractFromRaw`.
   */
  fees?: GatewayFeeInfo;
  /**
   * Cumulative amount refunded so far, in the smallest unit (e.g. halalas).
   * Returned by `verifyPayment` and used by the refund reaper to confirm whether
   * a stuck PENDING refund actually settled at the gateway. `undefined` when the
   * provider cannot report it (caller must not assume zero).
   */
  refundedMinorUnits?: number;
  /**
   * Set TRUE only when the gateway POSITIVELY reports that the refund was
   * failed/cancelled/voided (not merely "not yet reflected"). The refund reaper
   * uses this as the ONLY trigger to mark a stuck refund FAILED — absent this
   * signal it keeps the refund PENDING and alerts, never guessing failure from a
   * still-zero refunded amount (H1).
   */
  refundExplicitlyFailed?: boolean;
  /**
   * Amount actually captured at the gateway, in the smallest unit (e.g. halalas).
   * Returned by `verifyPayment` so the domain can reconcile the captured amount
   * against our expected `Payment.amount` BEFORE marking PAID — never trust the
   * status alone (anti under/over-payment & amount tampering). `undefined` when
   * the provider cannot report it (caller must NOT assume a match).
   */
  capturedMinorUnits?: number;
  /** ISO currency the gateway captured in; reconciled against `Payment.currency`. */
  capturedCurrency?: string;
  /** Raw provider response — persisted on `Transaction.raw_response` for audit. */
  raw?: Record<string, any>;
}

export interface GatewayRefundRequest {
  tenantId: string;
  paymentId: string;
  /**
   * Our Refund row id. Gateways with an idempotency key (Tap `reference.idempotent`)
   * derive it from this, so a retried call for the same refund can never create a
   * second one. Such gateways REFUSE a refund that arrives without it.
   */
  refundId?: string;
  gatewayPaymentId: string;
  /** Partial-refund amount in MAJOR units. */
  amount: number;
  currency: string;
  reason?: string;
}

export interface GatewayRefundResult {
  /** TRUE only when the refund is COMPLETE at the gateway. */
  success: boolean;
  /**
   * Finer-grained outcome for gateways with asynchronous refunds (Tap
   * `PENDING`). `success` stays false for anything but 'succeeded', so a
   * caller that predates this field never books an unfinished refund as done.
   */
  status?: 'pending' | 'succeeded' | 'failed' | 'unknown';
  gatewayRefundId?: string;
  failureReason?: string;
  raw?: Record<string, any>;
}

export interface PaymentGatewayProvider {
  /** Stable gateway identifier, stored on `Payment.gateway` (e.g. 'moyasar', 'tap'). */
  readonly name: string;

  /**
   * TRUE when the gateway cannot create a charge without payer identity
   * (Tap requires a customer name + email/phone). `PaymentService` only loads
   * payer details for providers that ask, so other gateways pay no extra read.
   */
  readonly requiresPayerDetails?: boolean;

  /**
   * TRUE when the gateway settles a clinic charge DIRECTLY to the clinic's own
   * merchant account (Tap Platform), so ZiyaraTech never holds those funds and
   * has nothing to batch into a payout. `PaymentService` records such a payment
   * as `settlement_mode = PROVIDER`; the internal settlement run only claims
   * INTERNAL payments, so provider-settled money can never be paid out twice.
   */
  readonly settlesDirectlyToPayee?: boolean;

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
