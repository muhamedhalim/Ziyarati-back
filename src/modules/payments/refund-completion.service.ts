import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityManager } from 'typeorm';

import { Refund } from '../../entities/Payments/Refund';
import { Payment } from '../../entities/Payments/Payment';
import { PaymentStatus } from '../../entities/enums';
import { PaymentRefundedEvent } from '../../events/payment.events';
import { RefundRecordedEvent } from '../../events/refund.events';

import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import {
  REFUND_STATUS,
  SETTLEMENT_MODE,
  TRANSACTION_TYPE,
} from './payments.constants';
import {
  PAYMENT_OUTCOME,
  enqueuePaymentOutcome,
} from './payment-outcome.outbox';

const toCents = (v: number | string): number => Math.round(Number(v) * 100);

/** Whose consequences a finished refund triggers once it is committed. */
export interface RefundCompletion {
  status: typeof REFUND_STATUS.SUCCEEDED | typeof REFUND_STATUS.FAILED;
  /** Set when a SUCCEEDED request was turned into FAILED by the completion re-clamp. */
  failureReason?: string;
  /** The payment's status AFTER this completion (unchanged when the refund failed). */
  paymentStatus: PaymentStatus;
  /** Emitted after commit — entitlement reversal. Only for SUCCEEDED. */
  recordedEvent?: RefundRecordedEvent;
  /** Emitted after commit when the caller asked to announce (the webhook path). */
  refundedEvent?: PaymentRefundedEvent;
}

export interface CompleteRefundInput {
  tenantId: string;
  /** The payment row, ALREADY locked `pessimistic_write` by the caller. */
  payment: Payment;
  /** The refund row, freshly read under that same lock. Must be PENDING. */
  refund: Refund;
  outcome: 'succeeded' | 'failed';
  /** The gateway's refund id, persisted for traceability and webhook matching. */
  gatewayRefundId?: string;
  failureReason?: string;
  /** What the REFUND ledger row records as the gateway reference (the charge id). */
  gatewayTransactionId?: string;
  raw?: Record<string, any>;
  /**
   * Also announce `payment.refunded` (notifications / workflows / outbound
   * webhooks). Only the WEBHOOK path does, exactly as the payment webhook always
   * has — staff-initiated and reaper-recovered refunds never fired it, and
   * starting to would message patients from paths that never did (see
   * `refund.events.ts`).
   */
  announce?: { customerId?: string; appointmentId?: string };
}

/**
 * The ONE place a refund becomes SUCCEEDED or FAILED.
 *
 * It used to live three times — `RefundService.create`, the refund reaper and the
 * webhook — and the copies had drifted: the reaper never updated the payment's
 * refunded aggregates, and no path but the webhook told the booking its payment
 * was refunded. With Tap a refund is asynchronous, so all three can be the path
 * that completes it; they must therefore complete it identically.
 *
 * Runs INSIDE the caller's transaction, under the caller's payment row lock. Both
 * the state change and its durable consequences (`payments.outcome` outbox rows)
 * commit together; the in-process events are returned for the caller to emit
 * AFTER the commit via {@link emitAfterCommit}.
 */
@Injectable()
export class RefundCompletionService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly adjustments: SettlementAdjustmentService,
    private readonly emitter: EventEmitter2,
  ) {}

  async complete(
    m: EntityManager,
    input: CompleteRefundInput,
  ): Promise<RefundCompletion> {
    const { tenantId, payment, refund } = input;
    const amountC = toCents(refund.amount);
    const paymentC = toCents(payment.amount);

    let outcome = input.outcome;
    let failureReason = input.failureReason;

    if (outcome === 'succeeded') {
      // FND-026 / T018: re-clamp before a refund becomes irrevocably SUCCEEDED.
      // Admission already reserved the room, so this never fires in the ordinary
      // path; it is the last guard against booking past the payment amount.
      const succeededC = await this.sumSucceededCents(m, payment.id);
      if (succeededC + amountC > paymentC) {
        outcome = 'failed';
        failureReason =
          failureReason ??
          'Refund would exceed the remaining refundable balance at completion';
      }
    }

    refund.status =
      outcome === 'succeeded' ? REFUND_STATUS.SUCCEEDED : REFUND_STATUS.FAILED;
    if (input.gatewayRefundId && !refund.gateway_refund_id) {
      refund.gateway_refund_id = input.gatewayRefundId;
    }
    await m.getRepository(Refund).save(refund);

    await this.transactions.record(
      tenantId,
      payment.id,
      {
        type: TRANSACTION_TYPE.REFUND,
        amount: amountC / 100,
        status: refund.status.toLowerCase(),
        gatewayTransactionId: input.gatewayTransactionId,
        raw: input.raw,
      },
      m,
    );

    if (outcome !== 'succeeded') {
      // A failed refund releases the capacity it had reserved (admission counts
      // PENDING + SUCCEEDED only) and leaves the payment untouched.
      return {
        status: REFUND_STATUS.FAILED,
        failureReason,
        paymentStatus: payment.status,
      };
    }

    // R1 clawback — only for money ZiyaraTech itself holds. A provider-settled
    // payment (Tap Platform) is refunded from the CLINIC'S own wallet by the
    // gateway; an internal "clawback" would later be netted off a settlement the
    // clinic never receives from us, and could even mint a negative batch.
    if (payment.settlement_mode === SETTLEMENT_MODE.INTERNAL) {
      await this.adjustments.recordClawbackIfSettled(
        m,
        tenantId,
        payment.id,
        payment.settlement_status,
        amountC,
        refund.id,
      );
    }

    const refundedC = await this.sumSucceededCents(m, payment.id);
    const fullyRefunded = refundedC >= paymentC;
    payment.status = fullyRefunded
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIALLY_REFUNDED;
    // Denormalised aggregates for the dashboards (the refunds table stays the truth).
    payment.refunded_amount = refundedC / 100;
    payment.refund_status = fullyRefunded ? 'FULL' : 'PARTIAL';
    payment.refunded_at = new Date();
    await m.getRepository(Payment).save(payment);

    // REL-005: both consequences commit WITH the refund. REFUND_RECORDED reverses
    // an add-on's entitlement; REFUNDED tells the booking its payment is refunded
    // (staff and reaper refunds never did — the booking kept showing PAID).
    await enqueuePaymentOutcome(m, {
      tenantId,
      paymentId: payment.id,
      outcome: PAYMENT_OUTCOME.REFUND_RECORDED,
      refundId: refund.id,
    });
    await enqueuePaymentOutcome(m, {
      tenantId,
      paymentId: payment.id,
      outcome: PAYMENT_OUTCOME.REFUNDED,
      refundedMinor: refundedC,
    });

    return {
      status: REFUND_STATUS.SUCCEEDED,
      paymentStatus: payment.status,
      recordedEvent: new RefundRecordedEvent(
        tenantId,
        payment.id,
        refund.id,
        refundedC,
        paymentC,
      ),
      refundedEvent: input.announce
        ? new PaymentRefundedEvent(
            tenantId,
            payment.id,
            Number(payment.amount),
            payment.currency,
            input.announce.customerId,
            !fullyRefunded,
            input.announce.appointmentId,
          )
        : undefined,
    };
  }

  /** Emit the in-process events of a COMMITTED completion (the durable twins are already queued). */
  emitAfterCommit(completion: RefundCompletion | undefined): void {
    if (!completion) return;
    if (completion.recordedEvent) {
      this.emitter.emit(
        RefundRecordedEvent.eventName,
        completion.recordedEvent,
      );
    }
    if (completion.refundedEvent) {
      this.emitter.emit(
        PaymentRefundedEvent.eventName,
        completion.refundedEvent,
      );
    }
  }

  /** Exact SUM (SQL `numeric`) of SUCCEEDED refunds for a payment, in integer cents. */
  private async sumSucceededCents(
    m: EntityManager,
    paymentId: string,
  ): Promise<number> {
    const row = await m
      .createQueryBuilder(Refund, 'r')
      .innerJoin('r.payment', 'p')
      .select('COALESCE(SUM(r.amount), 0)', 'sum')
      .where('p.id = :pid', { pid: paymentId })
      .andWhere('r.status = :s', { s: REFUND_STATUS.SUCCEEDED })
      .getRawOne<{ sum: string }>();
    return toCents(row?.sum ?? 0);
  }
}
