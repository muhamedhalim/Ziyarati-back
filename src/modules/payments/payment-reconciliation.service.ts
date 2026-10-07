import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  IsNull,
  LessThanOrEqual,
  Not,
  Repository,
} from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, PaymentStatus } from '../../entities/enums';
import { PaymentSucceededEvent } from '../../events/payment.events';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { PaymentsConfig } from './payments.config';
import { RECONCILIATION_KIND, TRANSACTION_TYPE } from './payments.constants';
import { ReconciliationExceptionService } from './reconciliation/reconciliation-exception.service';
import {
  PAYMENT_OUTCOME,
  enqueuePaymentOutcome,
} from './payment-outcome.outbox';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../subscription-billing/payment/payment-provider.interface';
import { InvoiceSettlementService } from '../subscription-billing/invoice-settlement.service';
import {
  InvoiceRefundSweepSummary,
  SubscriptionInvoiceRefundService,
} from '../subscription-billing/subscription-invoice-refund.service';

/**
 * How far back a hosted subscription checkout is still worth re-verifying. Older
 * than this and the clinic is long gone; an unbounded window would re-ask the
 * provider about every abandoned checkout forever.
 */
const CHECKOUT_RECONCILE_WINDOW_MS = 48 * 60 * 60_000;

type Outcome = 'paid' | 'failed' | 'mismatch' | 'stillPending' | 'skipped';

export interface ReconcileSummary {
  scanned: number;
  markedPaid: number;
  markedFailed: number;
  /** Gateway reports paid but amount/currency ≠ ours → NEVER auto-booked. */
  mismatches: number;
  stillPending: number;
  /** Unresolved past the hard threshold → page an operator. */
  alerts: number;
  /**
   * PENDING payments whose gateway id was never stored (the create call reached the
   * gateway, our finalize failed — REL-002) that the gateway turned out to hold:
   * the id is now attached and the payment verified like any other.
   */
  attached: number;
}

type InvoiceOutcome = 'settled' | 'released' | 'stillClaimed' | 'skipped';

export interface SubscriptionReconcileSummary {
  scanned: number;
  settled: number;
  /** Stale claim released for a clean retry on the next renewalBill sweep —
   *  the provider reported 'unknown', which is NEVER treated as evidence of
   *  a failed OR a successful charge, only as "nothing to confirm here". */
  released: number;
  stillClaimed: number;
  /** Platform refunds of subscription invoices still in flight, asked about this run. */
  refunds?: InvoiceRefundSweepSummary;
}

/**
 * Payment reconciliation sweep — webhooks are never the only truth.
 *
 * Recovers PENDING payments whose webhook was lost (network, outage, worker
 * crash) by re-verifying them against the gateway:
 *  - gateway paid + captured amount/currency MATCH → book PAID (financials
 *    frozen, VERIFY ledger row, PaymentSucceededEvent — so the booking
 *    confirms exactly as it would from the webhook);
 *  - gateway positively failed/voided → mark FAILED;
 *  - gateway paid but figures MISMATCH (under/over-payment, tampering) → left
 *    PENDING and counted as a mismatch for MANUAL REVIEW — a discrepancy is
 *    surfaced, never silently resolved;
 *  - gateway unknown/unreachable → left PENDING for the next run; past the
 *    hard threshold it is alerted.
 *
 * Concurrency: the gateway is queried OUTSIDE any lock; the decision is
 * applied under the payment row lock and re-checked (a webhook landing between
 * the two phases wins — the sweep then no-ops). Idempotent and safe on
 * multiple replicas, mirroring RefundRecoveryService.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger('PaymentReconciliationService');

  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly transactions: TransactionService,
    private readonly financials: PaymentFinancialsService,
    private readonly config: PaymentsConfig,
    private readonly emitter: EventEmitter2,
    @Inject(PAYMENT_PROVIDER)
    private readonly subscriptionProvider: PaymentProvider,
    private readonly settlement: InvoiceSettlementService,
    @Optional()
    private readonly exceptions?: ReconciliationExceptionService,
    @Optional()
    private readonly invoiceRefunds?: SubscriptionInvoiceRefundService,
  ) {}

  /** Sweep stale PENDING payments and reconcile each against the gateway. */
  async reconcileStalePending(): Promise<ReconcileSummary> {
    const cutoff = new Date(
      Date.now() - this.config.reconStaleMinutes * 60_000,
    );
    const candidates = await this.payments.find({
      where: {
        status: PaymentStatus.PENDING,
        gateway_payment_id: Not(IsNull()),
        created_at: LessThanOrEqual(cutoff),
      },
      relations: { tenant: true, customer: true, appointment: true },
      order: { created_at: 'ASC' },
      take: 200,
    });

    const summary: ReconcileSummary = {
      scanned: candidates.length,
      markedPaid: 0,
      markedFailed: 0,
      mismatches: 0,
      stillPending: 0,
      alerts: 0,
      attached: 0,
    };

    // REL-002: payments the gateway may hold but we have no id for. Looked up by
    // OUR reference; once the id is attached they join the ordinary sweep below.
    const recovered = await this.recoverUnattached().catch((err) => {
      this.logger.error(
        `Unattached-payment recovery failed: ${(err as Error).message}`,
      );
      return [] as Payment[];
    });
    summary.attached = recovered.length;
    candidates.push(...recovered);
    summary.scanned = candidates.length;

    for (const payment of candidates) {
      const outcome = await this.reconcileOne(payment).catch((err) => {
        this.logger.error(
          `Reconciliation failed on payment ${payment.id}: ${(err as Error).message}`,
        );
        return 'stillPending' as Outcome;
      });
      if (outcome === 'paid') summary.markedPaid++;
      else if (outcome === 'failed') summary.markedFailed++;
      else if (outcome === 'mismatch') summary.mismatches++;
      else if (outcome === 'stillPending') summary.stillPending++;

      if (outcome === 'mismatch' || outcome === 'stillPending') {
        const ageMs = Date.now() - new Date(payment.created_at).getTime();
        if (ageMs >= this.config.reconHardAlertMinutes * 60_000)
          summary.alerts++;
      }
    }

    if (summary.mismatches > 0) {
      this.logger.error(
        `ALERT: ${summary.mismatches} payment(s) captured at the gateway with a DIFFERENT amount/currency — manual review required`,
      );
    }
    if (summary.alerts > 0) {
      this.logger.error(
        `ALERT: ${summary.alerts} payment(s) stuck PENDING beyond the hard threshold — manual review required`,
      );
    }
    if (summary.scanned > 0) {
      this.logger.warn(
        `recon: scanned=${summary.scanned} paid=${summary.markedPaid} failed=${summary.markedFailed} mismatch=${summary.mismatches} stillPending=${summary.stillPending}`,
      );
    }
    return summary;
  }

  /** A captured amount / currency that is not ours to book: recorded for a human, not just logged. */
  private async raiseMismatch(
    payment: Payment,
    reportedAmountCents: number | undefined,
    reportedCurrency: string | undefined,
    expectedCents: number,
  ): Promise<void> {
    await this.exceptions?.raiseQuietly({
      kind: RECONCILIATION_KIND.AMOUNT_MISMATCH,
      provider: payment.gateway ?? 'unknown',
      objectId: payment.gateway_payment_id ?? payment.id,
      tenantId: payment.tenant?.id,
      paymentId: payment.id,
      details: {
        source: 'reconciliation_sweep',
        expectedAmountCents: expectedCents,
        expectedCurrency: payment.currency,
        reportedAmountCents: reportedAmountCents ?? null,
        reportedCurrency: reportedCurrency ?? null,
        paymentStatus: payment.status,
      },
    });
  }

  /**
   * REL-002 backstop. A PENDING payment with NO gateway id is one whose create call
   * may have succeeded at the gateway while our finalize transaction failed. Its
   * webhook (matched by the reference we sent) normally recovers it; if THAT is lost
   * too, the payer may have paid with nothing here to show it.
   *
   * Ask the gateway for a payment carrying OUR id. Only a positive answer acts: the
   * gateway's id is attached (conditionally, only while still unset and PENDING) and
   * the payment is handed to the ordinary verify-and-book path. "Nothing found" and
   * "could not tell" both leave the row alone — silence is never evidence that
   * nothing was charged.
   */
  private async recoverUnattached(): Promise<Payment[]> {
    const cutoff = new Date(
      Date.now() - this.config.reconStaleMinutes * 60_000,
    );
    const stuck = await this.payments.find({
      where: {
        status: PaymentStatus.PENDING,
        gateway_payment_id: IsNull(),
        gateway: Not(IsNull()),
        created_at: LessThanOrEqual(cutoff),
      },
      relations: { tenant: true, customer: true, appointment: true },
      order: { created_at: 'ASC' },
      take: 100,
    });

    const attached: Payment[] = [];
    for (const payment of stuck) {
      const provider = this.gateways.resolve(payment.gateway);
      if (!provider.findPaymentByReference) continue;
      const found = await provider
        .findPaymentByReference(payment.id)
        .catch(() => null);
      if (!found || found.status !== 'found' || !found.result.gatewayPaymentId)
        continue;

      let affected = 0;
      try {
        const res = await this.dataSource.query(
          `UPDATE payments SET gateway_payment_id = $2
            WHERE id = $1 AND gateway_payment_id IS NULL AND status = 'PENDING'`,
          [payment.id, found.result.gatewayPaymentId],
        );
        affected =
          Array.isArray(res) && typeof res[1] === 'number' ? res[1] : 0;
      } catch (err) {
        // The unique index on gateway_payment_id: another row already holds this charge.
        this.logger.error(
          `Payment ${payment.id}: the gateway's charge is already attached elsewhere (${(err as Error).message}) — left for review`,
        );
        continue;
      }
      if (affected > 0) {
        payment.gateway_payment_id = found.result.gatewayPaymentId;
        attached.push(payment);
        this.logger.warn(
          `Payment ${payment.id} had no gateway id; the gateway holds charge ${found.result.gatewayPaymentId} for it — attached`,
        );
      }
    }
    return attached;
  }

  private async reconcileOne(payment: Payment): Promise<Outcome> {
    if (!payment.gateway_payment_id || !payment.tenant) return 'skipped';
    const tenantId = payment.tenant.id;

    // Phase A: gateway truth, OUTSIDE any lock.
    const verify = await this.gateways
      .resolve(payment.gateway)
      .verifyPayment(payment.gateway_payment_id);

    // 'unknown' = the gateway could not say (outage, 5xx, 429, unmapped status).
    // It must NEVER fall through to the FAILED branch below: marking a payment
    // failed drops the one-PENDING guard and allows a second charge.
    if (verify.status === 'pending' || verify.status === 'unknown') {
      return 'stillPending';
    }

    // Amount/currency reconciliation BEFORE booking paid (anti under/over-payment).
    if (verify.status === 'paid') {
      const expectedC = Math.round(Number(payment.amount) * 100);
      if (
        verify.capturedMinorUnits != null &&
        verify.capturedMinorUnits !== expectedC
      ) {
        this.logger.error(
          `Payment ${payment.id}: gateway captured ${verify.capturedMinorUnits} ≠ expected ${expectedC} minor units — left PENDING for manual review`,
        );
        await this.raiseMismatch(
          payment,
          verify.capturedMinorUnits,
          verify.capturedCurrency,
          expectedC,
        );
        return 'mismatch';
      }
      if (
        verify.capturedCurrency &&
        verify.capturedCurrency.toUpperCase() !== payment.currency.toUpperCase()
      ) {
        this.logger.error(
          `Payment ${payment.id}: gateway currency ${verify.capturedCurrency} ≠ expected ${payment.currency} — left PENDING for manual review`,
        );
        await this.raiseMismatch(
          payment,
          verify.capturedMinorUnits,
          verify.capturedCurrency,
          expectedC,
        );
        return 'mismatch';
      }
    }

    // Phase B: decide + apply under the payment row lock, re-checking state.
    const applied = await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Payment);
      const locked = await repo.findOne({
        where: { id: payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      // A webhook/confirm may have resolved it between phases — never regress.
      if (!locked || locked.status !== PaymentStatus.PENDING)
        return 'skipped' as Outcome;

      await this.transactions.record(
        tenantId,
        locked.id,
        {
          type: TRANSACTION_TYPE.VERIFY,
          amount: Number(locked.amount),
          status: `recon:${verify.status}`,
          gatewayTransactionId: payment.gateway_payment_id,
          raw: verify.raw,
        },
        m,
      );

      if (verify.status === 'paid') {
        locked.status = PaymentStatus.PAID;
        locked.paid_at = new Date();
        this.financials.applyOnPaid(
          locked,
          verify.fees,
        );
        await repo.save(locked);
        // REL-005: THIS is the path that recovers a lost webhook — and it runs in
        // the WORKER process, where the in-process event below reaches only the
        // listeners that process happens to load. The durable outcome is what
        // guarantees the booking / add-on / upgrade is applied either way.
        await enqueuePaymentOutcome(m, {
          tenantId,
          paymentId: locked.id,
          outcome: PAYMENT_OUTCOME.PAID,
        });
        return 'paid' as Outcome;
      }
      locked.status = PaymentStatus.FAILED;
      locked.failure_reason =
        verify.failureReason ?? 'Gateway reported failure (reconciliation)';
      await repo.save(locked);
      await enqueuePaymentOutcome(m, {
        tenantId,
        paymentId: locked.id,
        outcome: PAYMENT_OUTCOME.FAILED,
      });
      return 'failed' as Outcome;
    });

    // Emit the SAME domain event the webhook path emits, after the commit —
    // recovered payments confirm their booking / notify exactly once.
    if (applied === 'paid') {
      this.emitter.emit(
        PaymentSucceededEvent.eventName,
        new PaymentSucceededEvent(
          tenantId,
          payment.id,
          Number(payment.amount),
          payment.currency,
          payment.customer?.id,
          payment.appointment?.id,
        ),
      );
    }
    return applied;
  }

  /**
   * Spec 014 (Clinic Platform Completion) — T084 (US5, FR-B016). The
   * subscription-invoice half of the SAME reconciliation sweep: recovers a
   * "lost confirmation" — a charge attempt whose synchronous `payInvoice`
   * response never landed (e.g. a worker crash between the provider call
   * and recording the outcome), leaving `charge_started_at` set with no
   * final state. This is a DIFFERENT financial stream from `Payment`
   * (deliberately — see `subscription-billing.module.ts`), so it is its own
   * scan/apply pass, through the SAME `PAYMENT_PROVIDER` binding
   * `BillingService` uses — never a duplicated provider call site.
   *
   * Tap migration: it also recovers a HOSTED CHECKOUT whose webhook AND return
   * page were both missed (the clinic paid, then closed the tab and the webhook
   * never arrived): an OPEN invoice whose checkout charge was opened between 48h
   * ago and the stale threshold is verified by its charge id, and settled through
   * the same single settle path the webhook uses.
   *
   * `verifyCharge()` returning 'unknown' is NEVER treated as "paid" or "failed" —
   * only as license to release a stale merchant-initiated claim so
   * `RenewalService`'s own next sweep can retry cleanly (the retry reuses the
   * same provider idempotency key, so a charge that DID reach the provider is
   * returned, not duplicated). An unreachable provider never closes a hosted
   * checkout.
   */
  async reconcileStaleSubscriptionInvoices(): Promise<SubscriptionReconcileSummary> {
    const cutoff = new Date(
      Date.now() - this.config.reconStaleMinutes * 60_000,
    );
    const checkoutFloor = new Date(Date.now() - CHECKOUT_RECONCILE_WINDOW_MS);
    const candidates = await this.invoices.find({
      where: [
        {
          charge_started_at: LessThanOrEqual(cutoff),
          status: Not(InvoiceStatus.VOID),
        },
        {
          status: InvoiceStatus.OPEN,
          checkout_charge_id: Not(IsNull()),
          checkout_started_at: Between(checkoutFloor, cutoff),
        },
      ],
      order: { charge_started_at: 'ASC' },
      take: 200,
    });

    const summary: SubscriptionReconcileSummary = {
      scanned: candidates.length,
      settled: 0,
      released: 0,
      stillClaimed: 0,
    };

    for (const invoice of candidates) {
      // PAID/REFUNDED invoices can still carry a (harmless, stale)
      // charge_started_at from before they were finalized — never reopen a
      // terminal invoice by "reconciling" it.
      if (
        invoice.status === InvoiceStatus.PAID ||
        invoice.status === InvoiceStatus.REFUNDED
      ) {
        continue;
      }
      const outcome = await this.reconcileOneInvoice(invoice).catch((err) => {
        this.logger.error(
          `Subscription-invoice reconciliation failed on ${invoice.id}: ${(err as Error).message}`,
        );
        return 'stillClaimed' as InvoiceOutcome;
      });
      if (outcome === 'settled') summary.settled++;
      else if (outcome === 'released') summary.released++;
      else if (outcome === 'stillClaimed') summary.stillClaimed++;
    }

    // The platform's own refunds that the provider has not completed (Tap refunds are
    // asynchronous): asked about by id, or re-sent under the same idempotency key.
    summary.refunds = await this.invoiceRefunds
      ?.sweepInFlight()
      .catch((err) => {
        this.logger.error(
          `Invoice refund sweep failed: ${(err as Error).message}`,
        );
        return undefined;
      });

    if (summary.scanned > 0) {
      this.logger.warn(
        `recon(subscriptions): scanned=${summary.scanned} settled=${summary.settled} ` +
          `released=${summary.released} stillClaimed=${summary.stillClaimed}`,
      );
    }
    return summary;
  }

  private async reconcileOneInvoice(
    invoice: SubscriptionInvoice,
  ): Promise<InvoiceOutcome> {
    // Phase A: provider truth, OUTSIDE any lock. The charge id (hosted checkout,
    // or a pending merchant-initiated charge) is what lets a real provider look
    // the charge up; without one it can only answer 'unknown'.
    const reference =
      invoice.checkout_charge_id ?? invoice.provider_reference ?? undefined;
    const verify = await this.subscriptionProvider.verifyCharge(
      invoice.id,
      reference,
    );

    if (verify.status === 'pending') return 'stillClaimed';

    // Phase B (paid): the ONE settle path — it locks the invoice itself, re-checks
    // its state (a webhook or the clinic's return may have won in between), checks
    // amount/currency, and advances the subscription in the same transaction.
    if (verify.status === 'paid') {
      const settled = await this.settlement.settleInvoicePaid(invoice.id, {
        source: 'reconciliation',
        provider: this.subscriptionProvider.name,
        reference: verify.reference ?? reference ?? invoice.id,
        capturedMinorUnits: verify.capturedMinorUnits,
        capturedCurrency: verify.capturedCurrency,
        savedPaymentMethod: verify.savedPaymentMethod,
      });
      if (settled.outcome === 'rejected') {
        // Amount/currency mismatch, or the invoice can no longer take it: left
        // claimed for manual review — a discrepancy is surfaced, never resolved.
        return 'stillClaimed';
      }
      return settled.outcome === 'already_paid' ? 'skipped' : 'settled';
    }

    // Phase B (failed / unknown): applied under the invoice row lock, re-checking
    // state first (never regress a terminal invoice).
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(SubscriptionInvoice);
      const locked = await repo.findOne({
        where: { id: invoice.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !locked ||
        locked.status === InvoiceStatus.PAID ||
        locked.status === InvoiceStatus.VOID ||
        locked.status === InvoiceStatus.REFUNDED
      ) {
        return 'skipped' as InvoiceOutcome;
      }
      const claimed = !!locked.charge_started_at;

      if (verify.status === 'failed') {
        locked.failure_reason =
          verify.failureReason ?? 'Provider reported failure (reconciliation)';
        locked.charge_started_at = null; // release the claim for a future retry
        if (reference && locked.checkout_charge_id === reference) {
          locked.checkout_started_at = null; // the hosted checkout is dead
        }
        await repo.save(locked);
        return 'released' as InvoiceOutcome;
      }

      // 'unknown' — no evidence either way. Release a stale merchant-initiated
      // claim so the next renewalBill sweep retries cleanly; never marked paid or
      // failed on a guess. A hosted checkout is left alone: the provider may
      // simply be unreachable, and the clinic can still be paying.
      if (!claimed) return 'stillClaimed' as InvoiceOutcome;
      locked.charge_started_at = null;
      await repo.save(locked);
      return 'released' as InvoiceOutcome;
    });
  }
}
