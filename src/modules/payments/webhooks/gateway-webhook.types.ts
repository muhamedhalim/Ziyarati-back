import type { SavedPaymentMethodInfo } from '../../subscription-billing/payment/payment-provider.interface';
import type { GatewayFeeInfo } from '../providers/payment-gateway.provider.interface';

/** What a gateway event asks the domain to do to a payment. */
export type GatewayWebhookTarget = 'paid' | 'failed' | 'refunded' | 'pending';

/**
 * Provider-NEUTRAL webhook event.
 *
 * Each gateway's verifier/handler authenticates its own wire format and then
 * reduces it to this shape; `PaymentWebhookService.process()` — dedupe, tenant
 * resolution, locking, amount checks, state changes, domain events — only ever
 * sees this. It is deliberately free of any provider status string or field
 * name, which is what keeps a future provider swap out of the payment domain.
 *
 * Tenant is NEVER carried here: it is resolved from our own Payment row.
 */
export interface GatewayWebhookEvent {
  /** Gateway name as stored on `Payment.gateway` ('tap', …). */
  provider: string;
  /** Gateway id of the PAYMENT the event is about (`Payment.gateway_payment_id`). */
  gatewayPaymentId: string;
  /**
   * Idempotency key for THIS delivery: the provider's event id when it has one,
   * else a synthetic stable key (Tap has no event id → `tap:{chargeId}:{status}`).
   * Redelivery of the same key is a harmless no-op.
   */
  dedupeKey?: string;
  target: GatewayWebhookTarget;
  /** Free-form label stored on the ledger row (`transactions.status`). */
  eventLabel: string;
  /** Captured amount in the domain's cents (×100), when the gateway reports it. */
  capturedMinorUnits?: number;
  capturedCurrency?: string;
  /**
   * CUMULATIVE amount refunded so far, in cents. Absent on a
   * refund event ⇒ treated as a full refund. Per-refund gateways (Tap) do not
   * use this path until their refund handling lands.
   */
  refundedMinorUnits?: number;
  /** Safe, short reason stored on a FAILED payment. */
  failureReason?: string;
  /** Adapter-parsed fee facts; when absent no gateway fee is recorded. */
  fees?: GatewayFeeInfo;
  /**
   * Our own id echoed by the gateway (a Payment id for one-off payments, a
   * subscription invoice id for subscription charges). Fallback match when the
   * gateway id was never persisted (REL-002).
   */
  correlationId?: string;
  /** Set when the event is about a subscription invoice rather than a one-off payment. */
  subscriptionInvoiceId?: string;
  /**
   * The card a subscription checkout saved (gateway ids + display facts, no card
   * data), present only on a PAID subscription-invoice event that saved one.
   */
  savedPaymentMethod?: SavedPaymentMethodInfo;
  /** Sanitised payload persisted on the append-only ledger. NEVER contains secrets. */
  raw: Record<string, any>;
}

/**
 * Provider-NEUTRAL refund event, for gateways whose refunds are PER-REFUND
 * objects with their own lifecycle (Tap). A cumulative refunded total reported on the PAYMENT event uses
 * `GatewayWebhookEvent` instead.
 *
 * Built from a refund the handler has RE-FETCHED from the gateway, never from
 * the posted body alone. Tenant is NEVER carried: it comes from our own rows.
 */
export interface GatewayRefundEvent {
  provider: string;
  /** The gateway's refund id (`Refund.gateway_refund_id`). */
  gatewayRefundId: string;
  /** The gateway id of the PAYMENT this refund is against (`Payment.gateway_payment_id`). */
  gatewayPaymentId?: string;
  outcome: 'succeeded' | 'failed' | 'pending' | 'unknown';
  /** This refund's amount, in the domain's cents. */
  amountMinorUnits?: number;
  currency?: string;
  /** Synthetic stable key: `tap:{refundId}:{STATUS}`. Redelivery is a no-op. */
  dedupeKey: string;
  eventLabel: string;
  /** Our Refund id, when the gateway echoes the `reference.merchant` we sent. */
  correlationId?: string;
  failureReason?: string;
  /** Sanitised payload persisted on the append-only ledger. NEVER contains secrets. */
  raw: Record<string, any>;
}
