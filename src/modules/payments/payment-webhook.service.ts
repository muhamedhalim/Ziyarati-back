import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Refund } from '../../entities/Payments/Refund';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, PaymentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { MoyasarWebhookVerifier } from './webhooks/moyasar-webhook.verifier';
import { MoyasarWebhookEvent } from './webhooks/moyasar-webhook.types';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { REFUND_STATUS, TRANSACTION_TYPE, round2 } from './payments.constants';
import {
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';
import { RefundRecordedEvent } from '../../events/refund.events';
import { verifyTimestamp } from '../integration-platform/inbound/inbound-signature';
import { WEBHOOK_SIGNATURE_SCHEME } from '../integration-platform/integration-platform.constants';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';

type TargetStatus = 'paid' | 'failed' | 'refunded' | 'pending';

/**
 * ZT-H02 — Moyasar webhook replay-freshness tolerance.
 *
 * Sourced from Moyasar's own documentation, not intuition: "If the webhook
 * recipient does not return a 2xx HTTP code we will retry to send the
 * webhook 5 more times and then drop the message," with a published
 * backoff schedule (immediate, +1m, +10m, +30m, +1h, +2h) whose total
 * window is documented as approximately 3 hours 43 minutes
 * (docs.moyasar.com, Webhook Reference, verified 2026-08-12). 4 hours is a
 * safe round buffer above that documented maximum, so a legitimate final
 * retry is never rejected as stale.
 */
const MOYASAR_WEBHOOK_FRESHNESS_TOLERANCE_SECONDS = 4 * 60 * 60; // 14400 — 4 hours

/**
 * Best-effort ISO-8601 → Unix-seconds string, for `verifyTimestamp` (which
 * expects Unix seconds). An unparseable non-empty value is passed through
 * unchanged so `verifyTimestamp`'s own `Number.isFinite` check reports
 * `'malformed'` rather than this helper silently swallowing a bad value.
 */
function toUnixSecondsString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : raw;
}

export interface WebhookResult {
  accepted: boolean;
  matched?: boolean;
  deduplicated?: boolean;
  /** `InvoiceStatus` when this event resolved to a subscription invoice
   *  (T083) rather than a one-time `Payment`. */
  status?: PaymentStatus | InvoiceStatus;
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
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    private readonly dataSource: DataSource,
    private readonly verifier: MoyasarWebhookVerifier,
    private readonly transactions: TransactionService,
    private readonly adjustments: SettlementAdjustmentService,
    private readonly financials: PaymentFinancialsService,
    private readonly audit: PlatformAdminAuditService,
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

    // ZT-H02 — defence-in-depth freshness check against `created_at`.
    // IMPORTANT: unlike Meta's HMAC (which covers the whole raw body, so a
    // tampered timestamp fails signature verification), Moyasar
    // authenticates with a STATIC SHARED TOKEN that does not bind to the
    // body at all — `verifier.verify(token)` above only proves the caller
    // knows the shared secret, not that `created_at` (or anything else in
    // the payload) is untampered. This check is therefore
    // **defence-in-depth against verbatim replay of a captured request
    // only, and is NOT cryptographically equivalent to Meta's HMAC-bound
    // freshness check** — an attacker who can forge a request at all can
    // also forge `created_at`. The partial unique index on
    // `gateway_transaction_id` (H4, below) remains the PRIMARY replay
    // control for this path; this check narrows the window a captured,
    // unmodified request stays replayable, nothing more.
    this.enforceEventFreshness(event);

    const eventId = event?.id;

    // 3. Resolve our payment from the gateway payment id (tenant comes from it).
    const gatewayPaymentId = event?.data?.id;
    if (!gatewayPaymentId) {
      this.logger.warn('Moyasar webhook without data.id — ignored');
      return { accepted: true, matched: false };
    }

    const owner = await this.payments.findOne({
      where: { gateway_payment_id: gatewayPaymentId },
      relations: { tenant: true, customer: true, appointment: true },
    });
    if (!owner || !owner.tenant) {
      // T083 (spec 014, US5) — no ONE-TIME payment matched; a subscription
      // renewal charge is the other thing this same webhook stream can be
      // about. Tried second (rarer today — no real recurring provider is
      // bound yet, see RecurringUnavailableProvider), never a second
      // controller/route.
      const invoiceResult = await this.handleSubscriptionInvoiceEvent(
        event,
        eventId,
        gatewayPaymentId,
      );
      if (invoiceResult) return invoiceResult;

      this.logger.warn(
        `Moyasar webhook for unknown gateway payment ${gatewayPaymentId}`,
      );
      return { accepted: true, matched: false };
    }

    const tenantId = owner.tenant.id;
    const customerId = owner.customer?.id;
    const appointmentId = owner.appointment?.id;
    const target = this.mapEvent(event);

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
        const { status, recordedEvent } = await this.reconcileRefund(
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
            appointmentId,
          );
        }
        pendingRefundRecordedEvent = recordedEvent ?? null;
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
          // Freeze the fee breakdown from the gateway-reported figures.
          this.financials.applyOnPaid(
            payment,
            this.financials.extractFromRaw(
              event as unknown as Record<string, unknown>,
            ),
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
        }
      } else if (
        target === 'failed' &&
        payment.status === PaymentStatus.PENDING
      ) {
        payment.status = PaymentStatus.FAILED;
        payment.failure_reason =
          event.data?.source?.message ??
          event.data?.status ??
          'Gateway reported failure';
        changed = true;
        pendingEventName = PaymentFailedEvent.eventName;
        pendingEvent = new PaymentFailedEvent(
          tenantId,
          payment.id,
          customerId,
          appointmentId,
        );
      }

      if (changed) await repo.save(payment);
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
    event: MoyasarWebhookEvent,
    eventId: string | undefined,
    gatewayPaymentId: string,
  ): Promise<WebhookResult | null> {
    const metadataInvoiceId = (
      event.data as Record<string, unknown> | undefined
    )?.metadata as Record<string, unknown> | undefined;
    const correlatedId = metadataInvoiceId?.subscriptionInvoiceId as
      | string
      | undefined;

    const owner = correlatedId
      ? await this.invoices.findOne({ where: { id: correlatedId } })
      : await this.invoices.findOne({
          where: { provider_reference: gatewayPaymentId },
        });
    if (!owner) return null;

    const target = this.mapEvent(event);
    if (target !== 'paid' && target !== 'failed') {
      // Refunds/unknowns on subscription revenue: accepted and logged, but
      // not acted on here — subscription refunds go through the
      // `PaymentProvider.refund()` abstraction (`RecurringUnavailableProvider`
      // today), never this webhook path.
      return { accepted: true, matched: true };
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SubscriptionInvoice);
      const locked = await repo.findOne({
        where: { id: owner.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked)
        return { status: owner.status, deduplicated: false, settled: false };

      if (eventId && locked.webhook_event_id === eventId) {
        return { status: locked.status, deduplicated: true, settled: false };
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
        return { status: locked.status, deduplicated: true, settled: false };
      }

      let settled = false;
      if (target === 'paid') {
        if (this.subscriptionAmountMatches(locked, event)) {
          locked.status = InvoiceStatus.PAID;
          locked.paid_at = new Date();
          locked.provider_reference = gatewayPaymentId;
          locked.failure_reason = null;
          locked.failure_class = null;
          settled = true;
        } else {
          this.logger.error(
            `Webhook 'paid' for subscription invoice ${locked.id} rejected: captured amount/currency mismatch`,
          );
        }
      } else {
        locked.failure_reason =
          event.data?.source?.message ??
          event.data?.status ??
          'Gateway reported failure';
      }
      if (eventId) locked.webhook_event_id = eventId;
      await repo.save(locked);
      return { status: locked.status, deduplicated: false, settled };
    });

    if (!result.deduplicated) {
      await this.audit.record({
        action: result.settled
          ? PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_SETTLED
          : PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_DECLINED,
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

  /** Same anti-tampering reasoning as `capturedMatches`, for a subscription
   *  invoice's plain `amount`/`currency` columns. */
  private subscriptionAmountMatches(
    invoice: SubscriptionInvoice,
    event: MoyasarWebhookEvent,
  ): boolean {
    const reportedAmount = event.data?.amount;
    if (reportedAmount != null) {
      const expectedC = Math.round(Number(invoice.amount) * 100);
      if (Math.round(Number(reportedAmount)) !== expectedC) return false;
    }
    const reportedCurrency = event.data?.currency;
    if (
      reportedCurrency &&
      reportedCurrency.toUpperCase() !== invoice.currency.toUpperCase()
    ) {
      return false;
    }
    return true;
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
  ): Promise<{ status: PaymentStatus; recordedEvent?: RefundRecordedEvent }> {
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

  /**
   * ZT-H02 — refuses a payload whose `created_at` falls outside
   * `MOYASAR_WEBHOOK_FRESHNESS_TOLERANCE_SECONDS`. Every `TimestampVerdict`
   * is handled explicitly; none falls through unhandled (FR-050). Reuses
   * `verifyTimestamp` from the integration platform's inbound-signature
   * module (Constitution V) — `HMAC_SHA256_TIMESTAMPED` selects the branch
   * that performs the comparison; see the code comment at the call site for
   * why this check is defence-in-depth only, not a cryptographic guarantee.
   */
  private enforceEventFreshness(event: MoyasarWebhookEvent): void {
    const presented = toUnixSecondsString(event?.created_at);
    const verdict = verifyTimestamp(
      WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED,
      presented,
      MOYASAR_WEBHOOK_FRESHNESS_TOLERANCE_SECONDS,
    );
    switch (verdict) {
      case 'ok':
        return;
      case 'stale':
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message:
            'Webhook event timestamp is outside the accepted freshness window',
        });
      case 'future':
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message: 'Webhook event timestamp is in the future',
        });
      case 'malformed':
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message: 'Webhook event timestamp is malformed',
        });
      case 'missing':
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message: 'Webhook event carries no verifiable timestamp',
        });
    }
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
