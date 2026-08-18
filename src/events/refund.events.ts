/**
 * Refund entitlement-reversal event (Phase 1.6, Pricing Catalog plan §14).
 *
 * `payment.refunded` (payment.events.ts) fires only from the webhook path
 * and its `amount` is the payment TOTAL, not the refund. Growing it to cover
 * admin-initiated and reconciliation-recovered refunds too would newly fire
 * its four existing listeners (appointment status, outbound webhooks,
 * workflows, notifications) for paths that never trigger them today — a
 * behaviour change outside this plan's scope. This is a NEW, narrow event
 * instead, consumed only by Phase 2.3's `ResourceEntitlementListener` (the
 * proportional-revoke reversal, plan §14).
 *
 * Emitted POST-COMMIT from all three refund-completion paths —
 * `RefundService.create`, `RefundRecoveryService.finalizeOne`, and
 * `PaymentWebhookService`'s refund-webhook handling — mirroring
 * `payment-reconciliation.service.ts`'s own "emit after the transaction
 * resolves" pattern. Existing `payment.refunded` listeners are untouched.
 */

export const REFUND_EVENT = { RECORDED: 'refund.recorded' } as const;

export type RefundEventName = (typeof REFUND_EVENT)[keyof typeof REFUND_EVENT];

export class RefundRecordedEvent {
  static readonly eventName = REFUND_EVENT.RECORDED;
  constructor(
    readonly tenantId: string,
    readonly paymentId: string,
    readonly refundId: string,
    /** Σ SUCCEEDED refunds on this payment, in MINOR units (cents), as of this event. */
    readonly refundedCumulativeMinor: number,
    /** The payment's total amount, in MINOR units (cents). */
    readonly paymentTotalMinor: number,
  ) {}
}
