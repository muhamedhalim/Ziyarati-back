import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { PaymentStatus } from '../../entities/enums';
import { PaymentSucceededEvent } from '../../events/payment.events';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { PaymentsConfig } from './payments.config';
import { TRANSACTION_TYPE } from './payments.constants';

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
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly transactions: TransactionService,
    private readonly financials: PaymentFinancialsService,
    private readonly config: PaymentsConfig,
    private readonly emitter: EventEmitter2,
  ) {}

  /** Sweep stale PENDING payments and reconcile each against the gateway. */
  async reconcileStalePending(): Promise<ReconcileSummary> {
    const cutoff = new Date(Date.now() - this.config.reconStaleMinutes * 60_000);
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
    };

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
        if (ageMs >= this.config.reconHardAlertMinutes * 60_000) summary.alerts++;
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

  private async reconcileOne(payment: Payment): Promise<Outcome> {
    if (!payment.gateway_payment_id || !payment.tenant) return 'skipped';
    const tenantId = payment.tenant.id;

    // Phase A: gateway truth, OUTSIDE any lock.
    const verify = await this.gateways
      .resolve(payment.gateway)
      .verifyPayment(payment.gateway_payment_id);

    if (verify.status === 'pending') return 'stillPending';

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
        return 'mismatch';
      }
      if (
        verify.capturedCurrency &&
        verify.capturedCurrency.toUpperCase() !== payment.currency.toUpperCase()
      ) {
        this.logger.error(
          `Payment ${payment.id}: gateway currency ${verify.capturedCurrency} ≠ expected ${payment.currency} — left PENDING for manual review`,
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
      if (!locked || locked.status !== PaymentStatus.PENDING) return 'skipped' as Outcome;

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
        this.financials.applyOnPaid(locked, this.financials.extractFromRaw(verify.raw));
        await repo.save(locked);
        return 'paid' as Outcome;
      }
      locked.status = PaymentStatus.FAILED;
      locked.failure_reason = verify.failureReason ?? 'Gateway reported failure (reconciliation)';
      await repo.save(locked);
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
}
