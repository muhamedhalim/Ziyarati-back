import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Refund } from '../../entities/Payments/Refund';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { PaymentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { MoyasarWebhookVerifier } from './webhooks/moyasar-webhook.verifier';
import { MoyasarWebhookEvent } from './webhooks/moyasar-webhook.types';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { REFUND_STATUS, TRANSACTION_TYPE } from './payments.constants';
import {
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';

type TargetStatus = 'paid' | 'failed' | 'refunded' | 'pending';

export interface WebhookResult {
  accepted: boolean;
  matched?: boolean;
  deduplicated?: boolean;
  status?: PaymentStatus;
}

/**
 * Moyasar webhook orchestration — the platform-side ingestion seam.
 *
 * Flow (per the integration contract):
 *   1. Authenticate via the shared secret (MoyasarWebhookVerifier) — never trust
 *      the body for identity.
 *   2. De-duplicate on the provider event id (idempotent — safe to redeliver).
 *   3. Resolve OUR payment from `gateway_payment_id`; the tenant comes from that
 *      payment row, NEVER from the webhook body (no cross-tenant exposure).
 *   4. Apply the state change inside a locked DB transaction and log the raw
 *      event on `transactions` for audit/debug.
 *
 * Unknown / unmatched events are accepted (200) so the provider does not retry
 * storm; they are logged for investigation.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger('PaymentWebhookService');

  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly verifier: MoyasarWebhookVerifier,
    private readonly transactions: TransactionService,
    private readonly adjustments: SettlementAdjustmentService,
    private readonly emitter: EventEmitter2,
  ) {}

  async handleMoyasar(
    event: MoyasarWebhookEvent,
    headerToken?: string,
  ): Promise<WebhookResult> {
    // 1. Authenticate (header token preferred, body secret_token as fallback).
    const token = headerToken ?? event?.secret_token;
    if (!this.verifier.verify(token)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'Invalid webhook signature',
      });
    }

    const eventId = event?.id;

    // 3. Resolve our payment from the gateway payment id (tenant comes from it).
    const gatewayPaymentId = event?.data?.id;
    if (!gatewayPaymentId) {
      this.logger.warn('Moyasar webhook without data.id — ignored');
      return { accepted: true, matched: false };
    }

    const owner = await this.payments.findOne({
      where: { gateway_payment_id: gatewayPaymentId },
      relations: { tenant: true, customer: true },
    });
    if (!owner || !owner.tenant) {
      this.logger.warn(
        `Moyasar webhook for unknown gateway payment ${gatewayPaymentId}`,
      );
      return { accepted: true, matched: false };
    }

    const tenantId = owner.tenant.id;
    const customerId = owner.customer?.id;
    const target = this.mapEvent(event);

    // Tracks which domain event (and its name) to emit after the transaction commits.
    let pendingEventName: string | null = null;
    let pendingEvent: PaymentSucceededEvent | PaymentRefundedEvent | PaymentFailedEvent | null = null;

    // 4. Apply state idempotently under a row lock.
    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({
        where: { id: owner.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) return { status: owner.status, deduplicated: false };

      // H4: atomic dedup — insert the raw event under the partial UNIQUE index
      // (gateway_transaction_id where type='webhook'). A redelivery loses the
      // insert race and is skipped, so the state change runs at most once.
      if (eventId) {
        const { created } = await this.transactions.recordWebhookOnce(
          tenantId,
          payment.id,
          {
            type: TRANSACTION_TYPE.WEBHOOK,
            amount: Number(payment.amount),
            status: event?.type ?? target,
            gatewayTransactionId: eventId,
            raw: this.sanitizeEvent(event),
          },
          manager,
        );
        if (!created) return { status: payment.status, deduplicated: true };
      } else {
        // No event id to dedup on — still log the raw event for audit.
        await this.transactions.record(
          tenantId,
          payment.id,
          {
            type: TRANSACTION_TYPE.WEBHOOK,
            amount: Number(payment.amount),
            status: event?.type ?? target,
            gatewayTransactionId: eventId,
            raw: this.sanitizeEvent(event),
          },
          manager,
        );
      }

      // H2: refunds are NEVER flipped directly — reconcile against Refund rows.
      if (target === 'refunded') {
        const status = await this.reconcileRefund(
          manager,
          tenantId,
          payment,
          event,
          eventId,
        );
        if (
          status === PaymentStatus.REFUNDED ||
          status === PaymentStatus.PARTIALLY_REFUNDED
        ) {
          pendingEventName = PaymentRefundedEvent.eventName;
          pendingEvent = new PaymentRefundedEvent(
            tenantId,
            payment.id,
            Number(payment.amount),
            payment.currency,
            customerId,
            status === PaymentStatus.PARTIALLY_REFUNDED,
          );
        }
        return { status, deduplicated: false };
      }

      let changed = false;
      if (target === 'paid' && payment.status !== PaymentStatus.PAID) {
        // Anti under/over-payment & tampering: honor a 'paid' event only when the
        // reported captured amount/currency match our payment. A mismatch is NOT
        // flipped to PAID (left for review); we still return 200 so the provider
        // does not retry-storm. No-op when the event omits the figures.
        if (this.capturedMatches(payment, event)) {
          payment.status = PaymentStatus.PAID;
          payment.paid_at = new Date();
          changed = true;
          pendingEventName = PaymentSucceededEvent.eventName;
          pendingEvent = new PaymentSucceededEvent(
            tenantId,
            payment.id,
            Number(payment.amount),
            payment.currency,
            customerId,
          );
        } else {
          this.logger.error(
            `Webhook 'paid' for payment ${payment.id} rejected: captured amount/currency mismatch`,
          );
        }
      } else if (
        target === 'failed' &&
        payment.status === PaymentStatus.PENDING
      ) {
        payment.status = PaymentStatus.FAILED;
        changed = true;
        pendingEventName = PaymentFailedEvent.eventName;
        pendingEvent = new PaymentFailedEvent(tenantId, payment.id, customerId);
      }

      if (changed) await repo.save(payment);
      return { status: payment.status, deduplicated: false };
    });

    // Emit domain events after the transaction commits so listeners see
    // a consistent DB state. Skip when the event was a harmless duplicate.
    if (pendingEventName && pendingEvent && !result.deduplicated) {
      this.emitter.emit(pendingEventName, pendingEvent);
    }

    return {
      accepted: true,
      matched: true,
      status: result.status,
      deduplicated: result.deduplicated,
    };
  }

  /**
   * Reconcile a refund webhook against our Refund ledger (H2). The gateway's
   * cumulative refunded amount is the source of truth; we NEVER flip the payment
   * straight to REFUNDED. If the gateway has refunded more than we have recorded
   * (e.g. a refund issued directly in the Moyasar dashboard), we append a
   * SUCCEEDED Refund row for the delta + a REFUND transaction, then recompute the
   * payment status from the cumulative SUCCEEDED total.
   *
   * In-flight (PENDING) refunds are included in the baseline so an API refund
   * mid-flight (gateway called, not yet finalized) is never double-counted by a
   * webhook that races it. All work runs under the caller's payment row lock.
   */
  private async reconcileRefund(
    manager: EntityManager,
    tenantId: string,
    payment: Payment,
    event: MoyasarWebhookEvent,
    eventId?: string,
  ): Promise<PaymentStatus> {
    const paymentCents = Math.round(Number(payment.amount) * 100);

    // Moyasar reports `refunded` in halalas (== our cents). Absent on a refund
    // event ⇒ treat as full refund. Clamp to [0, paymentCents] so a unit
    // mismatch / gateway anomaly can never over-refund the ledger.
    const reported = event.data?.refunded;
    let gatewayCents =
      reported != null ? Math.round(Number(reported)) : paymentCents;
    gatewayCents = Math.max(0, Math.min(gatewayCents, paymentCents));

    const recordedCents = await this.sumRefundsCents(manager, payment.id, [
      REFUND_STATUS.SUCCEEDED,
      REFUND_STATUS.PENDING,
    ]);
    const deltaCents = gatewayCents - recordedCents;

    if (deltaCents > 0) {
      const reconRefund = await manager.getRepository(Refund).save(
        manager.getRepository(Refund).create({
          tenant: { id: tenantId } as Tenant,
          payment: { id: payment.id } as Payment,
          amount: deltaCents / 100,
          status: REFUND_STATUS.SUCCEEDED,
          reason: 'Gateway-reconciled refund (webhook)',
          gateway_refund_id: eventId ? `recon:${eventId}` : undefined,
        }),
      );
      // R1 clawback: a reconciled refund on an already-settled payment nets out
      // of the next settlement.
      await this.adjustments.recordClawbackIfSettled(
        manager,
        tenantId,
        payment.id,
        payment.settlement_status,
        deltaCents,
        reconRefund.id,
      );
      // Ledger: every financial state change gets its own audit record.
      await this.transactions.record(
        tenantId,
        payment.id,
        {
          type: TRANSACTION_TYPE.REFUND,
          amount: deltaCents / 100,
          status: REFUND_STATUS.SUCCEEDED.toLowerCase(),
          gatewayTransactionId: eventId,
          raw: this.sanitizeEvent(event),
        },
        manager,
      );
    }

    // Recompute payment status from the cumulative SUCCEEDED refunds only.
    const succeededCents = await this.sumRefundsCents(manager, payment.id, [
      REFUND_STATUS.SUCCEEDED,
    ]);
    let newStatus = payment.status;
    if (succeededCents > 0) {
      newStatus =
        succeededCents >= paymentCents
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;
    }
    if (newStatus !== payment.status) {
      payment.status = newStatus;
      await manager.getRepository(Payment).save(payment);
    }
    return newStatus;
  }

  /** Exact SUM (SQL `numeric`) of refunds in the given statuses, in integer cents. */
  private async sumRefundsCents(
    manager: EntityManager,
    paymentId: string,
    statuses: string[],
  ): Promise<number> {
    const row = await manager
      .createQueryBuilder(Refund, 'r')
      .innerJoin('r.payment', 'p')
      .select('COALESCE(SUM(r.amount), 0)', 'sum')
      .where('p.id = :pid', { pid: paymentId })
      .andWhere('r.status IN (:...st)', { st: statuses })
      .getRawOne<{ sum: string }>();
    return Math.round(Number(row?.sum ?? 0) * 100);
  }

  /**
   * Strip the shared webhook secret before the event is persisted to the
   * append-only `transactions` ledger (which is readable via the tenant-facing
   * transactions API). Moyasar echoes `secret_token` in the body; storing it
   * verbatim would leak the platform-wide webhook secret to any tenant with
   * `payments.read`. Tenants must never see it.
   */
  private sanitizeEvent(event: MoyasarWebhookEvent): Record<string, any> {
    const { secret_token: _omit, ...safe } = event as Record<string, any>;
    return safe;
  }

  /**
   * Reconcile the webhook-reported captured amount/currency against our payment
   * before honoring a 'paid' event. Returns true when they match OR the provider
   * did not report them (no false negatives — preserves the existing flow when a
   * gateway omits the figures).
   */
  private capturedMatches(
    payment: Payment,
    event: MoyasarWebhookEvent,
  ): boolean {
    const reportedAmount = event.data?.amount;
    if (reportedAmount != null) {
      const expectedC = Math.round(Number(payment.amount) * 100);
      if (Math.round(Number(reportedAmount)) !== expectedC) return false;
    }
    const reportedCurrency = event.data?.currency;
    if (
      reportedCurrency &&
      reportedCurrency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      return false;
    }
    return true;
  }

  /** Normalize a Moyasar event/status into our target transition. */
  private mapEvent(event: MoyasarWebhookEvent): TargetStatus {
    const type = (event?.type ?? '').toLowerCase();
    if (type.includes('refund')) return 'refunded';
    if (type.includes('paid') || type.includes('captur')) return 'paid';
    if (type.includes('fail') || type.includes('void')) return 'failed';

    const status = (event?.data?.status ?? '').toLowerCase();
    if (status === 'paid' || status === 'captured' || status === 'authorized') {
      return 'paid';
    }
    if (status === 'failed' || status === 'voided') return 'failed';
    if (status === 'refunded') return 'refunded';
    return 'pending';
  }
}
