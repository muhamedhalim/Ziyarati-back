import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Refund } from '../../entities/Payments/Refund';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, PaymentStatus } from '../../entities/enums';

import { GatewayWebhookEvent } from './webhooks/gateway-webhook.types';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { InvoiceSettlementService } from '../subscription-billing/invoice-settlement.service';
import {
  REFUND_STATUS,
  RECONCILIATION_KIND,
  TRANSACTION_TYPE,
  isUuid,
  round2,
} from './payments.constants';
import {
  RaiseExceptionInput,
  ReconciliationExceptionService,
} from './reconciliation/reconciliation-exception.service';
import {
  PAYMENT_OUTCOME,
  enqueuePaymentOutcome,
} from './payment-outcome.outbox';
import {
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';
import { RefundRecordedEvent } from '../../events/refund.events';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';

export interface WebhookResult {
  accepted: boolean;
  matched?: boolean;
  deduplicated?: boolean;
  /** `InvoiceStatus` when this event resolved to a subscription invoice
   *  (T083) rather than a one-time `Payment`. */
  status?: PaymentStatus | InvoiceStatus;
}

/**
 * Gateway webhook orchestration — the platform-side ingestion seam.
 *
 * Two layers:
 *   - an ADAPTER per gateway (`TapWebhookHandler` for Tap)
 *     authenticates the gateway's own wire format and reduces it to a neutral
 *     `GatewayWebhookEvent`;
 *   - `process()` — provider-neutral — does everything after authentication.
 *
 * Flow (per the integration contract):
 *   1. Authenticate (adapter) — never trust the body for identity.
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
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionService,
    private readonly adjustments: SettlementAdjustmentService,
    private readonly financials: PaymentFinancialsService,
    private readonly audit: PlatformAdminAuditService,
    private readonly emitter: EventEmitter2,
    private readonly settlement: InvoiceSettlementService,
    // Optional: recording a discrepancy is bookkeeping, never a reason for a
    // webhook to fail (and a unit under test that does not care need not supply it).
    @Optional()
    private readonly exceptions?: ReconciliationExceptionService,
  ) {}

  /**
   * Provider-neutral processing of an ALREADY AUTHENTICATED gateway event:
   * resolve the payment (tenant comes from OUR row), dedupe, apply the state
   * change under a row lock, then emit domain events after commit.
   */
  async process(event: GatewayWebhookEvent): Promise<WebhookResult> {
    const eventId = event.dedupeKey;
    const gatewayPaymentId = event.gatewayPaymentId;
    const target = event.target;

    // 3. Resolve our payment from the gateway payment id (tenant comes from it).
    let owner = await this.payments.findOne({
      where: { gateway_payment_id: gatewayPaymentId },
      relations: { tenant: true, customer: true, appointment: true },
    });

    // REL-002: the gateway create succeeded but our finalize transaction failed,
    // so the gateway id was never persisted. The gateway echoed OUR payment id
    // back (Tap `reference.transaction`), so match on that — scoped to the same
    // provider, and never onto a payment that already holds a DIFFERENT charge.
    let viaCorrelation = false;
    if (!owner && isUuid(event.correlationId)) {
      const byCorrelation = await this.payments.findOne({
        where: { id: event.correlationId, gateway: event.provider },
        relations: { tenant: true, customer: true, appointment: true },
      });
      if (
        byCorrelation &&
        (!byCorrelation.gateway_payment_id ||
          byCorrelation.gateway_payment_id === gatewayPaymentId)
      ) {
        owner = byCorrelation;
        viaCorrelation = true;
      }
    }

    if (!owner || !owner.tenant) {
      // T083 (spec 014, US5) — no ONE-TIME payment matched; a subscription
      // renewal charge is the other thing this same webhook stream can be
      // about. Tried second, never a second controller/route.
      const invoiceResult = await this.handleSubscriptionInvoiceEvent(event);
      if (invoiceResult) return invoiceResult;

      this.logger.warn(
        `${event.provider} webhook for unknown gateway payment ${gatewayPaymentId}`,
      );
      return { accepted: true, matched: false };
    }

    const tenantId = owner.tenant.id;
    const customerId = owner.customer?.id;
    const appointmentId = owner.appointment?.id;

    // Tracks which domain event (and its name) to emit after the transaction commits.
    let pendingEventName: string | null = null;
    let pendingEvent:
      | PaymentSucceededEvent
      | PaymentRefundedEvent
      | PaymentFailedEvent
      | null = null;
    // Phase 1.6 (plan §14) — a SEPARATE slot: a refund webhook that reconciles
    // a genuinely new gateway-side refund fires this ALONGSIDE
    // PaymentRefundedEvent above (two different events, two different
    // consumer sets), so it cannot share the single pendingEvent slot.
    let pendingRefundRecordedEvent: RefundRecordedEvent | null = null;
    // A captured amount that is not ours to book: recorded for a human AFTER the
    // transaction (it writes to its own table, on its own connection).
    let mismatch: RaiseExceptionInput | null = null;

    // 4. Apply state idempotently under a row lock.
    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({
        where: { id: owner.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) return { status: owner.status, deduplicated: false };

      // REL-002: persist the gateway id the create call never got to save, so the
      // reconciliation sweep (which only scans rows that HAVE one) can see it
      // too. Correlation matches only — a normal match already holds the id.
      if (viaCorrelation) {
        if (!payment.gateway_payment_id) {
          payment.gateway_payment_id = gatewayPaymentId;
          await repo.save(payment);
        } else if (payment.gateway_payment_id !== gatewayPaymentId) {
          // The "no different charge" check above ran BEFORE this lock; if another
          // charge was attached in between, this event is about the wrong charge.
          // Booking it could mark a payment PAID off a capture that is not its own.
          this.logger.error(
            `${event.provider} event for charge ${gatewayPaymentId} matched payment ${payment.id} by correlation, but it now holds a different charge — ignored`,
          );
          return { status: payment.status, deduplicated: false };
        }
      }

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
            status: event.eventLabel,
            gatewayTransactionId: eventId,
            raw: event.raw,
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
            status: event.eventLabel,
            gatewayTransactionId: eventId,
            raw: event.raw,
          },
          manager,
        );
      }

      // H2: refunds are NEVER flipped directly — reconcile against Refund rows.
      if (target === 'refunded') {
        const { status, recordedEvent } = await this.reconcileRefund(
          manager,
          tenantId,
          payment,
          event,
        );
        // REL-005: the durable twin of the two in-process events emitted below,
        // written in THIS transaction so a crash after the commit cannot lose them.
        if (
          status === PaymentStatus.REFUNDED ||
          status === PaymentStatus.PARTIALLY_REFUNDED
        ) {
          await enqueuePaymentOutcome(manager, {
            tenantId,
            paymentId: payment.id,
            outcome: PAYMENT_OUTCOME.REFUNDED,
            refundedMinor: Math.round(Number(payment.refunded_amount) * 100),
          });
        }
        if (recordedEvent) {
          await enqueuePaymentOutcome(manager, {
            tenantId,
            paymentId: payment.id,
            outcome: PAYMENT_OUTCOME.REFUND_RECORDED,
            refundId: recordedEvent.refundId,
          });
        }
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
            appointmentId,
          );
        }
        pendingRefundRecordedEvent = recordedEvent ?? null;
        return { status, deduplicated: false };
      }

      let changed = false;
      // Only a PENDING or FAILED payment may become PAID. FAILED on purpose: a
      // late success after a failed attempt is real captured money. REFUNDED and
      // PARTIALLY_REFUNDED are excluded — they WERE paid, and a late or replayed
      // 'paid' event must not move them backwards (it used to flip refunded money
      // back to PAID and re-fire the succeeded event).
      if (
        target === 'paid' &&
        (payment.status === PaymentStatus.PENDING ||
          payment.status === PaymentStatus.FAILED)
      ) {
        // Anti under/over-payment & tampering: honor a 'paid' event only when the
        // reported captured amount/currency match our payment. A mismatch is NOT
        // flipped to PAID (left for review); we still return 200 so the provider
        // does not retry-storm. No-op when the event omits the figures.
        if (this.capturedMatches(payment, event)) {
          payment.status = PaymentStatus.PAID;
          payment.paid_at = new Date();
          // Freeze the fee breakdown from the gateway-reported figures.
          this.financials.applyOnPaid(
            payment,
            event.fees,
          );
          changed = true;
          pendingEventName = PaymentSucceededEvent.eventName;
          pendingEvent = new PaymentSucceededEvent(
            tenantId,
            payment.id,
            Number(payment.amount),
            payment.currency,
            customerId,
            appointmentId,
          );
        } else {
          this.logger.error(
            `Webhook 'paid' for payment ${payment.id} rejected: captured amount/currency mismatch`,
          );
          mismatch = {
            kind: RECONCILIATION_KIND.AMOUNT_MISMATCH,
            provider: event.provider,
            objectId: gatewayPaymentId,
            tenantId,
            paymentId: payment.id,
            details: {
              source: 'webhook',
              expectedAmountCents: Math.round(Number(payment.amount) * 100),
              expectedCurrency: payment.currency,
              reportedAmountCents: event.capturedMinorUnits ?? null,
              reportedCurrency: event.capturedCurrency ?? null,
              paymentStatus: payment.status,
            },
          };
        }
      } else if (
        target === 'failed' &&
        payment.status === PaymentStatus.PENDING
      ) {
        payment.status = PaymentStatus.FAILED;
        payment.failure_reason =
          event.failureReason ?? 'Gateway reported failure';
        changed = true;
        pendingEventName = PaymentFailedEvent.eventName;
        pendingEvent = new PaymentFailedEvent(
          tenantId,
          payment.id,
          customerId,
          appointmentId,
        );
      }

      if (changed) {
        await repo.save(payment);
        // REL-005: only a real PENDING→PAID / PENDING→FAILED flip reaches here.
        // The consequences (booking confirmed, add-on granted, upgrade applied)
        // commit with it; the in-process event below is just the fast path.
        await enqueuePaymentOutcome(manager, {
          tenantId,
          paymentId: payment.id,
          outcome:
            payment.status === PaymentStatus.PAID
              ? PAYMENT_OUTCOME.PAID
              : PAYMENT_OUTCOME.FAILED,
        });
      }
      return { status: payment.status, deduplicated: false };
    });

    // Emit domain events after the transaction commits so listeners see
    // a consistent DB state. Skip when the event was a harmless duplicate.
    if (pendingEventName && pendingEvent && !result.deduplicated) {
      this.emitter.emit(pendingEventName, pendingEvent);
    }
    if (pendingRefundRecordedEvent && !result.deduplicated) {
      this.emitter.emit(
        RefundRecordedEvent.eventName,
        pendingRefundRecordedEvent,
      );
    }
    if (mismatch && !result.deduplicated) {
      await this.exceptions?.raiseQuietly(mismatch);
    }

    return {
      accepted: true,
      matched: true,
      status: result.status,
      deduplicated: result.deduplicated,
    };
  }

  /**
   * Spec 014 (Clinic Platform Completion) — T083 (US5, FR-B013-FR-B016).
   * The subscription-invoice half of the SAME webhook stream — reached only
   * once no one-time `Payment` matched. Correlates via the metadata
   * `BillingService.payInvoice` already attaches to every charge
   * (`{ subscriptionInvoiceId }`), so a confirmation that never made it back
   * through the synchronous `payInvoice` response ("lost confirmation",
   * FR-B016) can still settle the invoice later. Falls back to
   * `provider_reference` for a later/duplicate event on an already-settled
   * charge.
   *
   * Out-of-order safe: a terminal invoice (PAID/VOID/REFUNDED) never moves
   * backward — a late 'failed' after an earlier 'paid' is recorded as a
   * no-op dedup, not a regression (FR-B015). Never touches `retry_count`/
   * `next_retry_at` — that schedule belongs to `RenewalService`'s own
   * synchronous decline path; a webhook 'failed' is additional evidence,
   * not a second place that invents a retry cadence.
   *
   * Returns `null` (not a `WebhookResult`) when nothing correlates, so the
   * caller falls through to the SAME "unknown, accepted, logged" outcome
   * the one-time-payment path already uses for an unmatched event.
   */
  private async handleSubscriptionInvoiceEvent(
    event: GatewayWebhookEvent,
  ): Promise<WebhookResult | null> {
    const eventId = event.dedupeKey;
    const gatewayPaymentId = event.gatewayPaymentId;
    const correlatedId = event.subscriptionInvoiceId;

    const owner = correlatedId
      ? await this.invoices.findOne({ where: { id: correlatedId } })
      : await this.invoices.findOne({
          where: { provider_reference: gatewayPaymentId },
        });
    if (!owner) return null;

    const target = event.target;
    if (target !== 'paid' && target !== 'failed') {
      // Refunds/unknowns on subscription revenue: accepted and logged, but
      // not acted on here — subscription refunds go through the
      // `PaymentProvider.refund()` abstraction, never this webhook path.
      return { accepted: true, matched: true };
    }

    if (target === 'paid') {
      // The ONE settle path: marks the invoice PAID and moves the subscription in
      // a single transaction (and checks amount/currency, replays and duplicate
      // captures itself). Transient failures propagate so the gateway retries.
      const settled = await this.settlement.settleInvoicePaid(owner.id, {
        source: 'webhook',
        provider: event.provider,
        reference: gatewayPaymentId,
        webhookEventId: eventId ?? null,
        capturedMinorUnits: event.capturedMinorUnits,
        capturedCurrency: event.capturedCurrency,
        savedPaymentMethod: event.savedPaymentMethod,
      });
      return {
        accepted: true,
        matched: true,
        status: settled.invoice?.status ?? owner.status,
        deduplicated:
          settled.outcome === 'already_paid' || settled.outcome === 'rejected',
      };
    }

    // 'failed': evidence only. It never invents a retry cadence (that belongs to
    // RenewalService's own synchronous decline path) and never moves a terminal
    // invoice backward (FR-B015).
    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SubscriptionInvoice);
      const locked = await repo.findOne({
        where: { id: owner.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) return { status: owner.status, deduplicated: false };

      if (eventId && locked.webhook_event_id === eventId) {
        return { status: locked.status, deduplicated: true };
      }

      if (
        locked.status === InvoiceStatus.PAID ||
        locked.status === InvoiceStatus.VOID ||
        locked.status === InvoiceStatus.REFUNDED
      ) {
        if (eventId) {
          locked.webhook_event_id = eventId;
          await repo.save(locked);
        }
        return { status: locked.status, deduplicated: true };
      }

      locked.failure_reason = event.failureReason ?? 'Gateway reported failure';
      if (gatewayPaymentId && locked.checkout_charge_id === gatewayPaymentId) {
        // The hosted checkout is dead: the clinic may open another at once.
        locked.checkout_started_at = null;
      }
      if (eventId) locked.webhook_event_id = eventId;
      await repo.save(locked);
      return { status: locked.status, deduplicated: false };
    });

    if (!result.deduplicated) {
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_DECLINED,
        userId: undefined,
        entityType: 'subscription_invoice',
        entityId: owner.id,
        tenantId: owner.tenant_id,
        after: { source: 'webhook', status: result.status },
      });
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
   * (e.g. a refund issued directly in the gateway dashboard), we append a
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
    event: GatewayWebhookEvent,
  ): Promise<{ status: PaymentStatus; recordedEvent?: RefundRecordedEvent }> {
    const eventId = event.dedupeKey;
    const paymentCents = Math.round(Number(payment.amount) * 100);

    // The provider reports the cumulative refunded total in minor units (== our
    // cents). Absent on a refund
    // event ⇒ treat as full refund. Clamp to [0, paymentCents] so a unit
    // mismatch / gateway anomaly can never over-refund the ledger.
    const reported = event.refundedMinorUnits;
    let gatewayCents = reported != null ? reported : paymentCents;
    gatewayCents = Math.max(0, Math.min(gatewayCents, paymentCents));

    const recordedCents = await this.sumRefundsCents(manager, payment.id, [
      REFUND_STATUS.SUCCEEDED,
      REFUND_STATUS.PENDING,
    ]);
    const deltaCents = gatewayCents - recordedCents;

    // Phase 1.6 (plan §14) — the id of the SUCCEEDED refund row this webhook
    // itself created, if any. Only a genuinely NEW reconciled refund gets a
    // RefundRecordedEvent; a redelivery where deltaCents <= 0 recorded
    // nothing new and must not re-fire the entitlement reversal.
    let newRefundId: string | undefined;

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
      newRefundId = reconRefund.id;
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
          raw: event.raw,
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
    // Denormalise refund aggregates onto the payment ledger row for fast
    // admin filtering (the authoritative source remains the refunds table).
    if (newStatus !== payment.status || deltaCents > 0) {
      payment.status = newStatus;
      payment.refunded_amount = round2(succeededCents / 100);
      payment.refund_status =
        newStatus === PaymentStatus.REFUNDED
          ? 'FULL'
          : succeededCents > 0
            ? 'PARTIAL'
            : payment.refund_status;
      payment.refunded_at = new Date();
      await manager.getRepository(Payment).save(payment);
    }

    const recordedEvent = newRefundId
      ? new RefundRecordedEvent(
          tenantId,
          payment.id,
          newRefundId,
          succeededCents,
          paymentCents,
        )
      : undefined;
    return { status: newStatus, recordedEvent };
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
   * Reconcile the webhook-reported captured amount/currency against our payment
   * before honoring a 'paid' event. Returns true when they match OR the provider
   * did not report them (no false negatives — preserves the existing flow when a
   * gateway omits the figures).
   */
  private capturedMatches(
    payment: Payment,
    event: GatewayWebhookEvent,
  ): boolean {
    const reportedAmount = event.capturedMinorUnits;
    if (reportedAmount != null) {
      const expectedC = Math.round(Number(payment.amount) * 100);
      if (reportedAmount !== expectedC) return false;
    }
    const reportedCurrency = event.capturedCurrency;
    if (
      reportedCurrency &&
      reportedCurrency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      return false;
    }
    return true;
  }
}
