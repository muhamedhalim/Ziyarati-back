import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { PaymentsReconcileJob } from '../../queue/job-data.interface';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { PaymentReconciliationService } from '../../modules/payments/payment-reconciliation.service';
import { MetricsService } from '../../metrics/metrics.service';

const LOCK_KEY = 'lock:payments-reconcile';
/**
 * Shorter than the repeatable job's own 10-minute cron interval (see
 * ScheduleRegistrarService) so a crashed holder's lock cannot outlive the
 * next scheduled tick, but generous for up to 200 stale payments × one
 * gateway HTTP verification call each (gap-closure — see
 * docs/CACHING_QUEUES_AUDIT.md M9).
 */
const LOCK_TTL_MS = 8 * 60 * 1000;

/**
 * Consumes the `payments` queue (`payments.reconcile`) — a platform-level
 * scheduled sweep that re-verifies stale PENDING payments against the gateway
 * (webhook-loss recovery). Correctness is already guaranteed at the DB layer
 * (every decision is applied under the payment row lock with a state
 * re-check), so a double-run cannot corrupt state — but it does mean a
 * duplicate gateway verification call per stale payment (cost + provider
 * rate limits) if this sweep and a stalled-and-redelivered instance of it
 * ever overlap. Lock-guarded to avoid that waste, not for correctness.
 */
@Processor(QUEUE.PAYMENTS, { concurrency: workerConcurrency() })
export class PaymentsProcessor extends WorkerHost {
  private readonly logger = new Logger('PaymentsProcessor');

  constructor(
    private readonly reconciliation: PaymentReconciliationService,
    private readonly lock: DistributedLockService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(_job: Job<PaymentsReconcileJob>) {
    const token = await this.lock.acquire(LOCK_KEY, LOCK_TTL_MS);
    if (!token) {
      this.logger.log(
        'payments reconcile sweep already in progress elsewhere — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const result = await this.reconciliation.reconcileStalePending();
      // Last-successful-run signal (M9's own deferred half, folded into M14 —
      // see docs/CACHING_QUEUES_AUDIT.md).
      this.metrics.setWorkerHeartbeat('payments.reconcile');
      return result;
    } finally {
      await this.lock.release(LOCK_KEY, token);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
