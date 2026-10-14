import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import {
  PaymentsOutcomeJob,
  PaymentsProviderReconcileJob,
  PaymentsReconcileJob,
} from '../../queue/job-data.interface';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { PaymentReconciliationService } from '../../modules/payments/payment-reconciliation.service';
import { ProviderReconciliationService } from '../../modules/payments/reconciliation/provider-reconciliation.service';
import { PROVIDER_RECONCILIATION } from '../../modules/payments/payments.constants';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentOutcomeService } from '../payment-outcome.service';

const LOCK_KEY = 'lock:payments-reconcile';
const PROVIDER_LOCK_KEY = 'lock:payments-provider-reconcile';
/**
 * A provider reconciliation downloads one report per merchant (every clinic with a
 * Tap merchant) and one per payout. The lock must outlive a long run but not the
 * next scheduled tick (daily 03:00, weekly 04:00 Sunday), and a crashed holder's
 * lock must not block the next day's run.
 */
const PROVIDER_LOCK_TTL_MS = 50 * 60 * 1000;
/**
 * Shorter than the repeatable job's own 10-minute cron interval (see
 * ScheduleRegistrarService) so a crashed holder's lock cannot outlive the
 * next scheduled tick, but generous for up to 200 stale payments × one
 * gateway HTTP verification call each (gap-closure — see
 * docs/CACHING_QUEUES_AUDIT.md M9).
 */
const LOCK_TTL_MS = 8 * 60 * 1000;

/**
 * Consumes the `payments` queue. Three job names share it:
 *
 *  - `payments.outcome` (REL-005) — the durable consequences of one payment
 *    state change, written to the outbox in the same transaction as the change.
 *    Per-payment, idempotent, no lock needed (every consumer row-locks its own
 *    target); see `PaymentOutcomeService`.
 *  - `payments.reconcile` — a platform-level scheduled sweep that re-verifies
 *    stale PENDING payments against the gateway (webhook-loss recovery).
 *    Correctness is already guaranteed at the DB layer (every decision is
 *    applied under the payment row lock with a state re-check), so a
 *    double-run cannot corrupt state — but it does mean a duplicate gateway
 *    verification call per stale payment (cost + provider rate limits) if this
 *    sweep and a stalled-and-redelivered instance of it ever overlap.
 *    Lock-guarded to avoid that waste, not for correctness.
 *
 *  - `payments.providerReconcile` (Tap Phase 5) — the daily / weekly comparison of
 *    our records with the gateway's own reports: fees, payouts, discrepancies.
 *    Read-only toward the gateway; lock-guarded so two replicas do not download the
 *    same reports twice (correctness is in the DB: every write is conditional).
 *
 * Dispatch is by job NAME. It used to be implicit — the single job type on this
 * queue ran the sweep unconditionally — which is exactly why a second job type
 * must never be added without the explicit branch below.
 */
@Processor(QUEUE.PAYMENTS, { concurrency: workerConcurrency() })
export class PaymentsProcessor extends WorkerHost {
  private readonly logger = new Logger('PaymentsProcessor');

  constructor(
    private readonly reconciliation: PaymentReconciliationService,
    private readonly providerReconciliation: ProviderReconciliationService,
    private readonly outcome: PaymentOutcomeService,
    private readonly lock: DistributedLockService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(
    job: Job<
      PaymentsReconcileJob | PaymentsOutcomeJob | PaymentsProviderReconcileJob
    >,
  ) {
    if (job.name === JOB.PAYMENTS_OUTCOME) {
      const data = job.data as PaymentsOutcomeJob;
      validateJobPayload(job.name, data);
      this.logger.log(
        `payments.outcome ${data.outcome} payment=${data.paymentId} tenant=${data.tenantId} attempt=${job.attemptsMade + 1}`,
      );
      // No worker heartbeat here, deliberately: this job is event-driven, so a
      // quiet hour with no payments would look like a dead worker.
      return this.outcome.process(data);
    }

    if (job.name === JOB.PAYMENTS_PROVIDER_RECONCILE) {
      return this.runProviderReconcile(
        job.data as PaymentsProviderReconcileJob,
      );
    }

    const token = await this.lock.acquire(LOCK_KEY, LOCK_TTL_MS);
    if (!token) {
      this.logger.log(
        'payments reconcile sweep already in progress elsewhere — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const result = await this.reconciliation.reconcileStalePending();
      // T084 (spec 014, US5) — the SAME sweep, extended to cover
      // subscription invoices too (a separate financial stream, its own
      // scan/apply pass, but one lock/one heartbeat/one job — not a second
      // sweep to schedule).
      const subscriptionResult =
        await this.reconciliation.reconcileStaleSubscriptionInvoices();
      // Last-successful-run signal (M9's own deferred half, folded into M14 —
      // see docs/CACHING_QUEUES_AUDIT.md).
      this.metrics.setWorkerHeartbeat('payments.reconcile');
      return { ...result, subscriptions: subscriptionResult };
    } finally {
      await this.lock.release(LOCK_KEY, token);
    }
  }

  private async runProviderReconcile(data: PaymentsProviderReconcileJob) {
    if (!this.providerReconciliation.enabled) {
      return { skipped: 'tap_not_active' };
    }
    const token = await this.lock.acquire(
      PROVIDER_LOCK_KEY,
      PROVIDER_LOCK_TTL_MS,
    );
    if (!token) {
      this.logger.log(
        'provider reconciliation already running elsewhere — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const result = await this.providerReconciliation.run({
        lookbackDays:
          Number(data?.lookbackDays) ||
          PROVIDER_RECONCILIATION.DAILY_LOOKBACK_DAYS,
      });
      this.metrics.setWorkerHeartbeat('payments.providerReconcile');
      return result;
    } finally {
      await this.lock.release(PROVIDER_LOCK_KEY, token);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
    // A payments.outcome that has used its whole retry budget (or was rejected as
    // unrecoverable) leaves a CAPTURED payment whose booking / add-on / upgrade
    // was never applied. The outbox row is already PUBLISHED, so nothing else
    // will re-drive it — say so loudly, with the id an operator needs.
    if (
      job?.name === JOB.PAYMENTS_OUTCOME &&
      (err instanceof UnrecoverableError ||
        job.attemptsMade >= (job.opts?.attempts ?? 1))
    ) {
      this.logger.error(
        `ALERT: payments.outcome job=${job.id} is EXHAUSTED — payment ${(job.data as PaymentsOutcomeJob)?.paymentId} may have an unapplied booking/entitlement; re-drive manually`,
      );
    }
  }
}
