import { EntityManager } from 'typeorm';

import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { JOB, QUEUE } from '../../queue/queue.constants';

/**
 * REL-005 — durable post-payment effects.
 *
 * The payment domain used to announce "this payment is now PAID" with an
 * in-process `EventEmitter2.emit` AFTER the transaction committed. A crash, a
 * deploy or an OOM kill in that gap lost the announcement forever: the money
 * was captured and recorded, but the booking was never confirmed, the add-on was
 * never granted, the billing upgrade was never applied. Nothing re-drove it.
 *
 * {@link enqueuePaymentOutcome} writes an `outbox_jobs` row in the SAME
 * transaction as the state change, so the intent commits or rolls back with it.
 * The worker's outbox relay publishes it to BullMQ and `PaymentOutcomeService`
 * applies the consumers idempotently.
 *
 * The in-process emit is KEPT as the fast path (the booking confirms the moment
 * the webhook lands, not a poll later), and it is what drives the consumers that
 * are not durable by design — notifications, workflows, outbound webhooks.
 * Running both is safe because every durable consumer is idempotent.
 */
export const PAYMENT_OUTCOME = {
  PAID: 'paid',
  FAILED: 'failed',
  /** The payment's refunded state changed (appointment payment-status consumer). */
  REFUNDED: 'refunded',
  /** A refund row reached SUCCEEDED (entitlement-reversal consumer). */
  REFUND_RECORDED: 'refund_recorded',
} as const;

export type PaymentOutcomeKind =
  (typeof PAYMENT_OUTCOME)[keyof typeof PAYMENT_OUTCOME];

export interface PaymentOutcomeInput {
  tenantId: string;
  paymentId: string;
  outcome: PaymentOutcomeKind;
  /** REFUND_RECORDED: the refund that triggered the reversal. */
  refundId?: string;
  /**
   * REFUNDED: the cumulative refunded amount in minor units. It only
   * distinguishes one refunded STATE from the next in the dedupe key (a payment
   * can be partially refunded and later fully refunded); the consumer never
   * reads it back.
   */
  refundedMinor?: number;
}

/**
 * Retry budget for the consumer job. Far more generous than the queue default
 * (5 attempts, ~45 s): an outage of the database or Redis must not exhaust the
 * budget and strand a captured payment. 12 attempts at 5 s exponential backoff
 * spans roughly 5½ hours.
 */
export const PAYMENT_OUTCOME_JOB_OPTS = {
  attempts: 12,
  backoff: { type: 'exponential', delay: 5_000 },
} as const;

/**
 * Deterministic BullMQ jobId / `outbox_jobs.dedupe_key`. Hyphens only — BullMQ
 * rejects a custom id containing ':'.
 *
 * A payment reaches PAID once and FAILED once (PENDING → FAILED only), and each
 * refund reaches SUCCEEDED once, so those keys are naturally unique per event.
 * REFUNDED is keyed by the cumulative amount instead, because the refunded state
 * legitimately changes more than once.
 */
export function paymentOutcomeDedupeKey(input: PaymentOutcomeInput): string {
  const { paymentId, outcome } = input;
  switch (outcome) {
    case PAYMENT_OUTCOME.PAID:
      return `payment-outcome-paid-${paymentId}`;
    case PAYMENT_OUTCOME.FAILED:
      return `payment-outcome-failed-${paymentId}`;
    case PAYMENT_OUTCOME.REFUNDED:
      return `payment-outcome-refunded-${paymentId}-${input.refundedMinor ?? 0}`;
    case PAYMENT_OUTCOME.REFUND_RECORDED:
      return `payment-outcome-refund-${input.refundId ?? paymentId}`;
  }
}

/**
 * Insert the outcome row on the CALLER'S transaction manager — it must be the
 * manager of the transaction that changes the payment, never a fresh
 * connection, or the atomicity this exists for is lost.
 *
 * `ON CONFLICT DO NOTHING`: a duplicate row must be a no-op, not a unique
 * violation. Inside a transaction a violation would abort the whole payment
 * state change over what is only a redundant notification of it.
 */
export async function enqueuePaymentOutcome(
  manager: EntityManager,
  input: PaymentOutcomeInput,
): Promise<void> {
  await manager
    .createQueryBuilder()
    .insert()
    .into(OutboxJob)
    .values({
      queue: QUEUE.PAYMENTS,
      job_name: JOB.PAYMENTS_OUTCOME,
      dedupe_key: paymentOutcomeDedupeKey(input),
      payload: {
        tenantId: input.tenantId,
        paymentId: input.paymentId,
        outcome: input.outcome,
        ...(input.refundId ? { refundId: input.refundId } : {}),
      },
      opts: { ...PAYMENT_OUTCOME_JOB_OPTS },
    })
    .orIgnore()
    .execute();
}
