/**
 * Payment domain events.
 *
 * Emitted by PaymentWebhookService after the gateway webhook confirms a
 * payment state change. The emitter has already validated the webhook
 * signature, de-duplicated the event, and persisted the state change before
 * emitting — so consumers can trust the payload without re-checking.
 *
 * `customerId` is optional because not every payment is linked to a CRM
 * Customer (e.g. ad-hoc payments without a customer record).
 */

export const PAYMENT_EVENT = {
  SUCCEEDED: 'payment.succeeded',
  REFUNDED: 'payment.refunded',
  FAILED: 'payment.failed',
} as const;

export type PaymentEventName =
  (typeof PAYMENT_EVENT)[keyof typeof PAYMENT_EVENT];

export class PaymentSucceededEvent {
  static readonly eventName = PAYMENT_EVENT.SUCCEEDED;
  constructor(
    readonly tenantId: string,
    readonly paymentId: string,
    readonly amount: number,
    readonly currency: string,
    readonly customerId: string | undefined,
    /** The booking this payment settles — drives appointment confirmation. */
    readonly appointmentId?: string,
  ) {}
}

export class PaymentRefundedEvent {
  static readonly eventName = PAYMENT_EVENT.REFUNDED;
  constructor(
    readonly tenantId: string,
    readonly paymentId: string,
    readonly amount: number,
    readonly currency: string,
    readonly customerId: string | undefined,
    /** True when the refund is partial (PARTIALLY_REFUNDED status). */
    readonly isPartial: boolean,
    /** The booking this payment settles — drives appointment payment status. */
    readonly appointmentId?: string,
  ) {}
}

export class PaymentFailedEvent {
  static readonly eventName = PAYMENT_EVENT.FAILED;
  constructor(
    readonly tenantId: string,
    readonly paymentId: string,
    readonly customerId: string | undefined,
    readonly appointmentId?: string,
  ) {}
}
