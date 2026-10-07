import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThanOrEqual, Repository } from 'typeorm';

import { Refund } from '../../entities/Payments/Refund';
import { Payment } from '../../entities/Payments/Payment';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import type {
  GatewayRefundResult,
  PaymentGatewayProvider,
} from './providers/payment-gateway.provider.interface';
import {
  RefundCompletion,
  RefundCompletionService,
} from './refund-completion.service';
import { refundOutcomeOf } from './refund.service';
import { RECONCILIATION_KIND, REFUND_STATUS } from './payments.constants';
import { ReconciliationExceptionService } from './reconciliation/reconciliation-exception.service';

const toCents = (v: number | string): number => Math.round(Number(v) * 100);

type Outcome = 'succeeded' | 'failed' | 'stillPending' | 'skipped';

/**
 * How long a refund whose provider id we never learned may be RE-SENT. The
 * re-send reuses the per-refund idempotency key, so inside the gateway's own
 * window (Tap: 24 h) it returns the original refund instead of creating a second
 * one. Well inside that window on purpose: past it a re-send would be a NEW
 * refund, so an older stuck refund is left for an operator.
 */
const REFUND_REPLAY_WINDOW_MS = 12 * 60 * 60_000;

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
 * Finalizes refunds left in PENDING — by a crash between RefundService Phase 1
 * (intent persisted) and Phase 3 (finalize), or, with a gateway whose refunds are
 * ASYNCHRONOUS (Tap `PENDING`), simply because the refund was accepted but had
 * not completed when the request returned. The gateway is queried OUTSIDE the DB
 * lock (Phase 1 invariant preserved); the decision is applied under the payment
 * row lock, recomputing our refunded total fresh so it composes safely with
 * concurrent API refunds / webhooks. Idempotent: only acts on rows still in
 * PENDING; terminal states are skipped.
 *
 * Two ways to learn the truth:
 *  - a gateway that can look ONE refund up (`verifyRefund`) is asked about that
 *    refund by its own id — the only source that can say "this refund FAILED";
 *  - a gateway that cannot is asked for the payment's
 *    cumulative refunded total, from which success is inferred; failure is only
 *    ever a positive "explicitly failed" signal, never a guess from age.
 *
 * Whatever the source, a refund the gateway cannot yet confirm stays PENDING and
 * is alerted past the hard threshold — never guessed either way — and the
 * outcome is booked by `RefundCompletionService`, the same code the staff path
 * and the webhook use.
 */
@Injectable()
export class RefundRecoveryService {
  private readonly logger = new Logger('RefundRecoveryService');

  constructor(
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly completion: RefundCompletionService,
    private readonly config: ConfigService,
    @Optional()
    private readonly exceptions?: ReconciliationExceptionService,
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

    const provider = payment.gateway_payment_id
      ? this.gateways.resolve(payment.gateway)
      : undefined;
    if (provider?.verifyRefund) {
      return this.finalizeViaProvider(refund, payment, provider);
    }
    return this.finalizeLegacy(refund, payment, provider);
  }

  // ─────────────────── gateway that can look ONE refund up ────────────────── //

  private async finalizeViaProvider(
    refund: Refund,
    payment: Payment,
    provider: PaymentGatewayProvider,
  ): Promise<Outcome> {
    // Phase B: gateway truth, OUTSIDE any lock.
    let result: GatewayRefundResult;
    if (refund.gateway_refund_id) {
      result = await provider.verifyRefund!(refund.gateway_refund_id);
    } else {
      // The create call never told us the gateway's refund id (timeout, 5xx, a
      // crash). Re-sending it with the SAME per-refund idempotency key is safe
      // inside the gateway's window — it returns the original refund, or creates
      // the one that never arrived, never a second — so that is how the id is
      // learned. Past the window it would be a new refund: leave it.
      const ageMs = await this.ageMs(refund.id);
      if (ageMs === undefined || ageMs > REFUND_REPLAY_WINDOW_MS) {
        this.logger.warn(
          `Refund ${refund.id} has no gateway refund id and is past the replay window — left PENDING for manual review`,
        );
        return 'stillPending';
      }
      result = await provider.refundPayment({
        tenantId: await this.tenantIdOf(this.dataSource.manager, payment.id),
        paymentId: payment.id,
        refundId: refund.id,
        gatewayPaymentId: payment.gateway_payment_id!,
        amount: toCents(refund.amount) / 100,
        currency: payment.currency,
        reason: refund.reason ?? undefined,
      });
    }

    // The refund object must be the one we believe it is: against THIS payment's
    // charge, for THIS amount. Anything else is never booked, only surfaced.
    if (
      (result.gatewayPaymentId &&
        result.gatewayPaymentId !== payment.gateway_payment_id) ||
      (result.amountMinorUnits != null &&
        result.amountMinorUnits !== toCents(refund.amount)) ||
      (result.currency &&
        result.currency.toUpperCase() !== payment.currency.toUpperCase())
    ) {
      this.logger.error(
        `Refund ${refund.id}: the gateway's refund object does not match this payment/amount — left PENDING for manual review`,
      );
      await this.exceptions?.raiseQuietly({
        kind: RECONCILIATION_KIND.REFUND_MISMATCH,
        provider: payment.gateway ?? 'unknown',
        objectId: result.gatewayRefundId ?? refund.gateway_refund_id ?? refund.id,
        tenantId: await this.tenantIdOf(this.dataSource.manager, payment.id),
        paymentId: payment.id,
        details: {
          source: 'refund_reaper',
          refundId: refund.id,
          expectedChargeId: payment.gateway_payment_id ?? null,
          reportedChargeId: result.gatewayPaymentId ?? null,
          expectedAmountCents: toCents(refund.amount),
          reportedAmountCents: result.amountMinorUnits ?? null,
          expectedCurrency: payment.currency,
          reportedCurrency: result.currency ?? null,
        },
      });
      return 'stillPending';
    }

    const status = refundOutcomeOf(result);
    if (status === 'pending' || status === 'unknown') {
      // Not decided yet. Remember the id if this is the first time we learn it, so
      // the next pass (and the webhook) can find the refund directly.
      if (result.gatewayRefundId && !refund.gateway_refund_id) {
        await this.refunds
          .createQueryBuilder()
          .update(Refund)
          .set({ gateway_refund_id: result.gatewayRefundId })
          .where('id = :id AND gateway_refund_id IS NULL', { id: refund.id })
          .execute();
      }
      return 'stillPending';
    }

    return this.applyDecision(refund, payment, {
      outcome: status,
      gatewayRefundId: result.gatewayRefundId,
      failureReason: result.failureReason,
      raw: result.raw,
    });
  }

  // ─────────────── gateway that reports a cumulative refunded total ───────── //

  private async finalizeLegacy(
    refund: Refund,
    payment: Payment,
    provider: PaymentGatewayProvider | undefined,
  ): Promise<Outcome> {
    // Phase B: gateway truth, OUTSIDE any lock (only when a gateway charge exists).
    let gatewayRefundedCents: number | undefined;
    let explicitlyFailed = false;
    if (payment.gateway_payment_id && provider) {
      const verify = await provider.verifyPayment(payment.gateway_payment_id);
      explicitlyFailed = verify.refundExplicitlyFailed === true;
      if (verify.refundedMinorUnits == null && !explicitlyFailed) {
        // Provider can't confirm → don't guess; leave for the next run / alert.
        return 'stillPending';
      }
      gatewayRefundedCents = Math.max(
        0,
        Math.min(verify.refundedMinorUnits ?? 0, toCents(payment.amount)),
      );
    }

    return this.applyDecision(
      refund,
      payment,
      { outcome: undefined, legacy: { gatewayRefundedCents, explicitlyFailed } },
    );
  }

  // ───────────────────────────── apply under the lock ─────────────────────── //

  private async applyDecision(
    refund: Refund,
    payment: Payment,
    decision: {
      /** Decided by the gateway (provider path). Undefined = infer under the lock (legacy path). */
      outcome: 'succeeded' | 'failed' | undefined;
      gatewayRefundId?: string;
      failureReason?: string;
      raw?: Record<string, any>;
      legacy?: { gatewayRefundedCents?: number; explicitlyFailed: boolean };
    },
  ): Promise<Outcome> {
    let completion: RefundCompletion | undefined;
    const outcome = await this.dataSource.transaction(async (m) => {
      const locked = await m.getRepository(Payment).findOne({
        where: { id: payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      const fresh = await m.getRepository(Refund).findOneBy({ id: refund.id });
      if (!locked || !fresh || fresh.status !== REFUND_STATUS.PENDING) return 'skipped';

      const tenantId = await this.tenantIdOf(m, payment.id);
      let outcome = decision.outcome;

      if (outcome === undefined) {
        // Legacy inference, under the lock so it composes with concurrent refunds.
        const thisCents = toCents(fresh.amount);
        const succeededCents = await this.sumSucceededCents(m, payment.id);
        const { gatewayRefundedCents, explicitlyFailed } = decision.legacy!;
        if (!payment.gateway_payment_id) {
          outcome = 'succeeded'; // internal refund, no external dependency
        } else if ((gatewayRefundedCents ?? 0) - succeededCents >= thisCents) {
          outcome = 'succeeded'; // gateway confirms enough refunded to cover this row
        } else if (explicitlyFailed) {
          // H1: ONLY fail on a positive gateway "failed/cancelled" signal —
          // never infer failure from a still-zero refunded amount + age.
          outcome = 'failed';
        } else {
          // Unknown/not-yet-reflected → keep PENDING; the sweep alerts past the
          // hard threshold so an operator (not the system) resolves it.
          return 'stillPending';
        }
      }

      completion = await this.completion.complete(m, {
        tenantId,
        payment: locked,
        refund: fresh,
        outcome,
        // Legacy gateways report no per-refund id; mark the row as reaper-settled.
        gatewayRefundId:
          decision.gatewayRefundId ??
          (decision.legacy ? `reaper:${fresh.id}` : undefined),
        failureReason: decision.failureReason,
        gatewayTransactionId: payment.gateway_payment_id ?? undefined,
        raw: decision.raw,
      });
      // The completion re-clamp can turn a succeeded request into FAILED.
      return completion.status === REFUND_STATUS.SUCCEEDED ? 'succeeded' : 'failed';
    });

    this.completion.emitAfterCommit(completion);
    return outcome;
  }

  /** Age of a refund row as the DATABASE sees it — immune to the tz-less `created_at` skew in node. */
  private async ageMs(refundId: string): Promise<number | undefined> {
    const rows = await this.dataSource.query(
      `SELECT EXTRACT(EPOCH FROM (now() - created_at)) * 1000 AS age FROM refunds WHERE id = $1`,
      [refundId],
    );
    const age = Number(rows?.[0]?.age);
    return Number.isFinite(age) ? age : undefined;
  }

  private async sumSucceededCents(m: EntityManager, paymentId: string): Promise<number> {
    const row = await m.query(
      `SELECT COALESCE(SUM(amount),0) AS sum FROM refunds WHERE "paymentId" = $1 AND status = 'SUCCEEDED'`,
      [paymentId],
    );
    return toCents(row[0]?.sum ?? 0);
  }

  private async tenantIdOf(m: EntityManager, paymentId: string): Promise<string> {
    const row = await m.query(`SELECT "tenantId" AS t FROM payments WHERE id = $1`, [paymentId]);
    return row[0]?.t as string;
  }
}
