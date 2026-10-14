import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { RefundsReapJob } from '../../queue/job-data.interface';
import { RefundRecoveryService } from '../../modules/payments/refund-recovery.service';
import { FinancialMetricsService } from '../../modules/payments/financial-metrics.service';

/**
 * Consumes the `refunds` queue (`refunds.reap`) — a platform-level scheduled
 * sweep (every few minutes) that finalizes stale PENDING refunds via
 * RefundRecoveryService. Idempotent and safe to run on multiple replicas (each
 * refund is finalized under a payment row lock).
 */
@Processor(QUEUE.REFUNDS, { concurrency: workerConcurrency() })
export class RefundsProcessor extends WorkerHost {
  private readonly logger = new Logger('RefundsProcessor');

  constructor(
    private readonly recovery: RefundRecoveryService,
    private readonly metrics: FinancialMetricsService,
  ) {
    super();
  }

  async process(_job: Job<RefundsReapJob>) {
    const summary = await this.recovery.reapStalePending();
    // Heartbeat doubles as worker-liveness + last-run counters for the metrics endpoint (H4/M5).
    await this.metrics.recordReaperHeartbeat(summary);
    return summary;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
