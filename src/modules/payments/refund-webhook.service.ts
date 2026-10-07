import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Refund } from '../../entities/Payments/Refund';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { PaymentStatus } from '../../entities/enums';

import { GatewayRefundEvent } from './webhooks/gateway-webhook.types';
import {
  RefundCompletion,
  RefundCompletionService,
} from './refund-completion.service';
import { TransactionService } from './transaction.service';
import {
  RECONCILIATION_KIND,
  REFUND_STATUS,
  TRANSACTION_TYPE,
  isUuid,
} from './payments.constants';
import {
  RaiseExceptionInput,
  ReconciliationExceptionService,
} from './reconciliation/reconciliation-exception.service';
import type { WebhookResult } from './payment-webhook.service';
import { SubscriptionInvoiceRefundService } from '../subscription-billing/subscription-invoice-refund.service';

const toCents = (v: number | string): number => Math.round(Number(v) * 100);

/** Keep attacker-influenced ids out of logs as anything but a short, plain token. */
const safeId = (v: unknown): string =>
  String(v ?? '')
    .replace(/[^\w:.-]/g, '_')
    .slice(0, 48);

/**
 * Applies an AUTHENTICATED, RE-FETCHED per-refund gateway event (Tap).
 *
 * The payment-event path reconciles a cumulative refunded total
 * (`PaymentWebhookService.reconcileRefund`). A Tap refund is its own object with
 * its own lifecycle (`PENDING` → `REFUNDED` / `DECLINED` …), so it is matched to
 * OUR refund row instead — and the tenant, as everywhere, comes from our rows,
 * never from the body.
 *
 * Matching, most to least certain:
 *  1. `refunds.gateway_refund_id` — set when the create call answered, or by an
 *     earlier event;
 *  2. the `reference.merchant` we sent (our refund id), when Tap echoes it;
 *  3. exactly ONE still-PENDING refund on that payment with no gateway id and the
 *     same amount — the create call's answer was lost, and nothing else could be
 *     meant. Anything ambiguous is NOT guessed.
 * No row at all means the refund was issued OUTSIDE ZiyaraTech (a clinic owner
 * refunding from their own Tap dashboard). A COMPLETED one is booked as a
 * gateway-reconciled refund, so the payment/booking reflect money that really left.
 *
 * Terminal refunds never move: a redelivery or a late event for a refund already
 * SUCCEEDED/FAILED is a no-op.
 */
@Injectable()
export class RefundWebhookService {
  private readonly logger = new Logger('RefundWebhookService');

  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly completion: RefundCompletionService,
    @Optional()
    private readonly exceptions?: ReconciliationExceptionService,
    @Optional()
    private readonly invoiceRefunds?: SubscriptionInvoiceRefundService,
  ) {}

  async process(event: GatewayRefundEvent): Promise<WebhookResult> {
    const owner = event.gatewayPaymentId
      ? await this.payments.findOne({
          where: { gateway_payment_id: event.gatewayPaymentId },
          relations: { tenant: true, customer: true, appointment: true },
        })
      : null;

    if (
      (!owner || !owner.tenant) &&
      event.gatewayPaymentId &&
      this.invoiceRefunds
    ) {
      // Not a one-off payment: the charge may be one that paid a SUBSCRIPTION invoice
      // (the platform's own revenue), whose refund is the platform's to book.
      const invoice = await this.invoiceRefunds.applyGatewayRefund(
        event.gatewayPaymentId,
        {
          reference: event.gatewayRefundId,
          outcome: event.outcome,
          amountMinorUnits: event.amountMinorUnits,
        },
      );
      if (invoice.matched) {
        if (invoice.anomaly) {
          await this.exceptions?.raiseQuietly({
            kind: RECONCILIATION_KIND.REFUND_MISMATCH,
            provider: event.provider,
            objectId: event.gatewayRefundId,
            tenantId: invoice.tenantId,
            details: {
              source: 'refund_webhook',
              reason: invoice.anomaly,
              subscriptionInvoiceId: invoice.invoiceId,
              gatewayChargeId: event.gatewayPaymentId,
              reportedAmountCents: event.amountMinorUnits ?? null,
            },
          });
        }
        return { accepted: true, matched: true };
      }
    }

    if (!owner || !owner.tenant) {
      this.logger.warn(
        `${event.provider} refund ${safeId(event.gatewayRefundId)} is for an unknown charge — ignored`,
      );
      return { accepted: true, matched: false };
    }

    const tenantId = owner.tenant.id;
    let completion: RefundCompletion | undefined;
    // A refund that is not ours to book: recorded for a human AFTER the transaction.
    let anomaly: RaiseExceptionInput | null = null;
    const flag = (reason: string, extra: Record<string, unknown> = {}) => {
      anomaly = {
        kind: RECONCILIATION_KIND.REFUND_MISMATCH,
        provider: event.provider,
        objectId: event.gatewayRefundId,
        tenantId,
        paymentId: owner.id,
        details: {
          source: 'refund_webhook',
          reason,
          gatewayChargeId: event.gatewayPaymentId ?? null,
          reportedAmountCents: event.amountMinorUnits ?? null,
          reportedCurrency: event.currency ?? null,
          paymentAmountCents: toCents(owner.amount),
          paymentCurrency: owner.currency,
          ...extra,
        },
      };
    };

    const result = await this.dataSource.transaction(async (m) => {
      const payment = await m.getRepository(Payment).findOne({
        where: { id: owner.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) return { status: owner.status, deduplicated: false };

      // Dedupe on the synthetic `{provider}:{refundId}:{STATUS}` key, atomically,
      // IN this transaction: if applying fails and rolls back, so does the dedupe
      // row, and the gateway's retry is processed instead of swallowed.
      const { created } = await this.transactions.recordWebhookOnce(
        tenantId,
        payment.id,
        {
          type: TRANSACTION_TYPE.WEBHOOK,
          amount: (event.amountMinorUnits ?? 0) / 100,
          status: event.eventLabel,
          gatewayTransactionId: event.dedupeKey,
          raw: event.raw,
        },
        m,
      );
      if (!created) return { status: payment.status, deduplicated: true };

      const refundRepo = m.getRepository(Refund);
      let refund = await this.matchRefund(m, payment, event);

      if (refund) {
        // A refund already decided never moves (redelivery, late or reordered event).
        if (refund.status !== REFUND_STATUS.PENDING) {
          return { status: payment.status, deduplicated: false };
        }
        if (!this.sameRefund(payment, refund, event)) {
          flag('DOES_NOT_MATCH_OUR_REFUND', {
            ourRefundId: refund.id,
            ourAmountCents: toCents(refund.amount),
          });
          return { status: payment.status, deduplicated: false };
        }
        if (event.outcome === 'pending' || event.outcome === 'unknown') {
          // Not decided: only remember the gateway's id so the reaper and the next
          // event find this row directly.
          if (!refund.gateway_refund_id) {
            refund.gateway_refund_id = event.gatewayRefundId;
            await refundRepo.save(refund);
          }
          return { status: payment.status, deduplicated: false };
        }
      } else {
        // Not ours. Only a COMPLETED refund changes anything we hold.
        if (event.outcome !== 'succeeded') {
          return { status: payment.status, deduplicated: false };
        }
        refund = await this.adoptExternalRefund(m, tenantId, payment, event);
        if (!refund) {
          flag('EXTERNAL_REFUND_NOT_APPLICABLE', {
            paymentStatus: payment.status,
          });
          return { status: payment.status, deduplicated: false };
        }
      }

      completion = await this.completion.complete(m, {
        tenantId,
        payment,
        refund,
        outcome: event.outcome === 'succeeded' ? 'succeeded' : 'failed',
        gatewayRefundId: event.gatewayRefundId,
        failureReason: event.failureReason,
        gatewayTransactionId: event.gatewayPaymentId,
        raw: event.raw,
        // The webhook path has always announced a refund (notifications, workflows,
        // outbound webhooks); the staff and reaper paths have not.
        announce:
          event.outcome === 'succeeded'
            ? {
                customerId: owner.customer?.id,
                appointmentId: owner.appointment?.id,
              }
            : undefined,
      });
      return { status: payment.status, deduplicated: false };
    });

    // After the COMMIT: the in-process events (their durable twins are in the outbox).
    this.completion.emitAfterCommit(completion);
    if (anomaly && !result.deduplicated) {
      await this.exceptions?.raiseQuietly(anomaly);
    }

    return {
      accepted: true,
      matched: true,
      status: result.status as PaymentStatus,
      deduplicated: result.deduplicated,
    };
  }

  /** Find OUR refund row for the gateway's refund (see the class comment for the order). */
  private async matchRefund(
    m: EntityManager,
    payment: Payment,
    event: GatewayRefundEvent,
  ): Promise<Refund | null> {
    const repo = m.getRepository(Refund);

    const byGatewayId = await repo.findOne({
      where: {
        gateway_refund_id: event.gatewayRefundId,
        payment: { id: payment.id },
      },
    });
    if (byGatewayId) return byGatewayId;

    if (isUuid(event.correlationId)) {
      const byReference = await repo.findOne({
        where: {
          id: event.correlationId,
          payment: { id: payment.id },
          status: REFUND_STATUS.PENDING,
          gateway_refund_id: IsNull(),
        },
      });
      if (byReference) return byReference;
    }

    if (event.amountMinorUnits != null) {
      const candidates = await repo.find({
        where: {
          payment: { id: payment.id },
          status: REFUND_STATUS.PENDING,
          gateway_refund_id: IsNull(),
        },
      });
      const sameAmount = candidates.filter(
        (r) => toCents(r.amount) === event.amountMinorUnits,
      );
      // Two identical pending refunds cannot be told apart: never guess.
      if (sameAmount.length === 1) return sameAmount[0];
    }
    return null;
  }

  /** The event must describe THIS refund: same amount and currency, or it is never booked. */
  private sameRefund(
    payment: Payment,
    refund: Refund,
    event: GatewayRefundEvent,
  ): boolean {
    if (
      event.amountMinorUnits != null &&
      event.amountMinorUnits !== toCents(refund.amount)
    ) {
      this.logger.error(
        `${event.provider} refund ${safeId(event.gatewayRefundId)}: amount does not match our refund ${refund.id} — not applied`,
      );
      return false;
    }
    if (
      event.currency &&
      event.currency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      this.logger.error(
        `${event.provider} refund ${safeId(event.gatewayRefundId)}: currency does not match payment ${payment.id} — not applied`,
      );
      return false;
    }
    return true;
  }

  /**
   * A refund the gateway completed that we never initiated. It is admitted only
   * if it fits what is still refundable; otherwise it is left alone and surfaced
   * (the money has moved, but booking it would put our ledger past the payment).
   */
  private async adoptExternalRefund(
    m: EntityManager,
    tenantId: string,
    payment: Payment,
    event: GatewayRefundEvent,
  ): Promise<Refund | null> {
    const amountC = event.amountMinorUnits;
    if (amountC == null || amountC <= 0) return null;
    if (
      event.currency &&
      event.currency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      this.logger.error(
        `${event.provider} external refund ${safeId(event.gatewayRefundId)}: currency mismatch — not applied`,
      );
      return null;
    }
    if (
      payment.status !== PaymentStatus.PAID &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      this.logger.error(
        `${event.provider} external refund ${safeId(event.gatewayRefundId)} for payment ${payment.id} in status ${payment.status} — not applied`,
      );
      return null;
    }
    const row = await m
      .createQueryBuilder(Refund, 'r')
      .innerJoin('r.payment', 'p')
      .select('COALESCE(SUM(r.amount), 0)', 'sum')
      .where('p.id = :pid', { pid: payment.id })
      .andWhere('r.status IN (:...st)', {
        st: [REFUND_STATUS.PENDING, REFUND_STATUS.SUCCEEDED],
      })
      .getRawOne<{ sum: string }>();
    if (toCents(row?.sum ?? 0) + amountC > toCents(payment.amount)) {
      this.logger.error(
        `${event.provider} external refund ${safeId(event.gatewayRefundId)} would exceed payment ${payment.id} — not applied`,
      );
      return null;
    }
    const repo = m.getRepository(Refund);
    return repo.save(
      repo.create({
        tenant: { id: tenantId } as Tenant,
        payment: { id: payment.id } as Payment,
        amount: amountC / 100,
        status: REFUND_STATUS.PENDING,
        reason: 'Gateway-reconciled refund (webhook)',
        gateway_refund_id: event.gatewayRefundId,
      }),
    );
  }
}
