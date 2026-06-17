import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';

import { Refund } from '../../entities/Payments/Refund';
import { Payment } from '../../entities/Payments/Payment';
import { PaymentStatus } from '../../entities/enums';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { REFUND_STATUS, TRANSACTION_TYPE } from './payments.constants';

const toCents = (v: number | string): number => Math.round(Number(v) * 100);

type Outcome = 'succeeded' | 'failed' | 'stillPending' | 'skipped';

export interface ReapSummary {
  scanned: number;
  succeeded: number;
  failed: number;
  stillPending: number;
  /** PENDING refunds older than the hard-fail threshold still unresolved → page on-call. */
  alerts: number;
}

/**
 * R2 — Refund Recovery / Reaper.
 *
 * Finalizes refunds left in PENDING by a crash between RefundService Phase 1
 * (intent persisted) and Phase 3 (finalize). The gateway is queried OUTSIDE the
 * DB lock (Phase 1 invariant preserved); the decision is applied under the
 * payment row lock, recomputing our refunded total fresh so it composes safely
 * with concurrent API refunds / webhook reconciliation. Idempotent: only acts on
 * rows still in PENDING; terminal states are skipped.
 *
 * Crash/edge handling:
 *  - crash after gateway success: the gateway reports the refunded amount →
 *    reaper marks the row SUCCEEDED and advances the payment status.
 *  - webhook arrived first: webhook's reconcile counts PENDING in its baseline
 *    (no double-count) but leaves status unadvanced; the reaper closes it.
 *  - gateway not yet reflecting / unreachable: left PENDING, retried next run;
 *    past the hard threshold it is alerted (and, when the gateway positively
 *    reports it was NOT refunded, marked FAILED).
 */
@Injectable()
export class RefundRecoveryService {
  private readonly logger = new Logger('RefundRecoveryService');

  constructor(
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly transactions: TransactionService,
    private readonly adjustments: SettlementAdjustmentService,
    private readonly config: ConfigService,
  ) {}

  private staleMs(): number {
    return Number(this.config.get<number>('REFUND_REAPER_STALE_MIN', 10)) * 60_000;
  }
  private hardFailMs(): number {
    return Number(this.config.get<number>('REFUND_REAPER_HARDFAIL_MIN', 120)) * 60_000;
  }

  /** Sweep stale PENDING refunds and finalize each idempotently. */
  async reapStalePending(): Promise<ReapSummary> {
    const cutoff = new Date(Date.now() - this.staleMs());
    const candidates = await this.refunds.find({
      where: { status: REFUND_STATUS.PENDING, created_at: LessThanOrEqual(cutoff) },
      relations: { payment: true },
      order: { created_at: 'ASC' },
      take: 200,
    });

    const summary: ReapSummary = {
      scanned: candidates.length,
      succeeded: 0,
      failed: 0,
      stillPending: 0,
      alerts: 0,
    };

    for (const refund of candidates) {
      const outcome = await this.finalizeOne(refund).catch((err) => {
        this.logger.error(`Reaper failed on refund ${refund.id}: ${(err as Error).message}`);
        return 'stillPending' as Outcome;
      });
      if (outcome === 'succeeded') summary.succeeded++;
      else if (outcome === 'failed') summary.failed++;
      else if (outcome === 'stillPending') {
        summary.stillPending++;
        const ageMs = Date.now() - new Date(refund.created_at).getTime();
        if (ageMs >= this.hardFailMs()) summary.alerts++;
      }
    }

    if (summary.alerts > 0) {
      // Hook your pager/metrics here. A refund stuck past the hard threshold
      // means money may have moved at the gateway without our ledger resolving.
      this.logger.error(
        `ALERT: ${summary.alerts} refund(s) stuck PENDING beyond the hard threshold — manual review required`,
      );
    }
    if (summary.scanned > 0) {
      this.logger.warn(
        `reaper: scanned=${summary.scanned} succeeded=${summary.succeeded} failed=${summary.failed} stillPending=${summary.stillPending}`,
      );
    }
    return summary;
  }

  private async finalizeOne(refund: Refund): Promise<Outcome> {
    if (refund.status !== REFUND_STATUS.PENDING) return 'skipped';
    const payment = refund.payment;
    if (!payment) return 'skipped';

    // Phase B: gateway truth, OUTSIDE any lock (only when a gateway charge exists).
    let gatewayRefundedCents: number | undefined;
    if (payment.gateway_payment_id) {
      const verify = await this.gateways
        .resolve(payment.gateway)
        .verifyPayment(payment.gateway_payment_id);
      if (verify.refundedMinorUnits == null) {
        // Provider can't confirm → don't guess; leave for the next run / alert.
        return 'stillPending';
      }
      gatewayRefundedCents = Math.max(
        0,
        Math.min(verify.refundedMinorUnits, toCents(payment.amount)),
      );
    }

    // Phase C: decide + apply under the payment row lock.
    return this.dataSource.transaction(async (m) => {
      const locked = await m.getRepository(Payment).findOne({
        where: { id: payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      const fresh = await m.getRepository(Refund).findOneBy({ id: refund.id });
      if (!locked || !fresh || fresh.status !== REFUND_STATUS.PENDING) return 'skipped';

      const thisCents = toCents(fresh.amount);
      const succeededCents = await this.sumSucceededCents(m, payment.id);
      const ageMs = Date.now() - new Date(fresh.created_at).getTime();
      const tenantId = await this.tenantIdOf(m, payment.id);

      let succeed: boolean;
      if (!payment.gateway_payment_id) {
        succeed = true; // internal refund, no external dependency
      } else {
        const headroom = (gatewayRefundedCents ?? 0) - succeededCents;
        if (headroom >= thisCents) {
          succeed = true; // gateway confirms enough refunded to cover this row
        } else if (ageMs >= this.hardFailMs()) {
          succeed = false; // gateway says NOT refunded, and it's old → fail it
        } else {
          return 'stillPending'; // gateway may still catch up; retry next run
        }
      }

      if (succeed) {
        fresh.status = REFUND_STATUS.SUCCEEDED;
        if (!fresh.gateway_refund_id) fresh.gateway_refund_id = `reaper:${fresh.id}`;
        await m.getRepository(Refund).save(fresh);

        await this.transactions.record(
          tenantId,
          payment.id,
          {
            type: TRANSACTION_TYPE.REFUND,
            amount: thisCents / 100,
            status: REFUND_STATUS.SUCCEEDED.toLowerCase(),
            gatewayTransactionId: payment.gateway_payment_id,
          },
          m,
        );

        await this.adjustments.recordClawbackIfSettled(
          m,
          tenantId,
          payment.id,
          locked.settlement_status,
          thisCents,
          fresh.id,
        );

        const newSucceeded = await this.sumSucceededCents(m, payment.id);
        locked.status =
          newSucceeded >= toCents(locked.amount)
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED;
        await m.getRepository(Payment).save(locked);
        return 'succeeded';
      }

      // Failed: record the terminal outcome; payment status untouched.
      fresh.status = REFUND_STATUS.FAILED;
      await m.getRepository(Refund).save(fresh);
      await this.transactions.record(
        tenantId,
        payment.id,
        {
          type: TRANSACTION_TYPE.REFUND,
          amount: thisCents / 100,
          status: REFUND_STATUS.FAILED.toLowerCase(),
          gatewayTransactionId: payment.gateway_payment_id,
        },
        m,
      );
      return 'failed';
    });
  }

  private async sumSucceededCents(m: import('typeorm').EntityManager, paymentId: string): Promise<number> {
    const row = await m.query(
      `SELECT COALESCE(SUM(amount),0) AS sum FROM refunds WHERE "paymentId" = $1 AND status = 'SUCCEEDED'`,
      [paymentId],
    );
    return toCents(row[0]?.sum ?? 0);
  }

  private async tenantIdOf(m: import('typeorm').EntityManager, paymentId: string): Promise<string> {
    const row = await m.query(`SELECT "tenantId" AS t FROM payments WHERE id = $1`, [paymentId]);
    return row[0]?.t as string;
  }
}
