import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { BaseJobData } from '../../queue/job-data.interface';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { CampaignDispatchService } from '../../modules/campaigns/campaign-dispatch.service';

const LOCK_KEY = 'lock:campaigns-recover-dlq';
/**
 * Comfortably shorter than the repeatable job's own cron interval (5 minutes
 * — see ScheduleRegistrarService) so a lock from a crashed holder can't
 * outlive the next scheduled tick, but long enough to cover a full batch
 * (500 rows, one Redis round-trip each) — mirrors
 * IntegrationRecoveryProcessor's LOCK_TTL_MS reasoning exactly.
 */
const LOCK_TTL_MS = 90_000;

/**
 * Consumes `campaigns.maintenance` (`campaigns.recoverDlq`) — FND-020.
 * Re-attempts the DLQ write for any dead-lettered recipient whose entry was
 * never confirmed in `campaigns.dlq` (a Redis hiccup at the moment of the
 * original enqueue). `CampaignDispatchService.recoverDeadLetters()` already
 * exists and is already unit-tested; this processor is only the missing
 * wiring, not new recovery logic — mirrors IntegrationRecoveryProcessor.
 *
 * Lock-guarded for the same reason: a system-wide sweep with no queue-level
 * `lockDuration` override can be handed to a second worker by BullMQ's own
 * stall detector while the first is still mid-sweep. If the lock is already
 * held, this run is a no-op, not an error.
 */
@Processor(QUEUE.CAMPAIGNS_MAINTENANCE, { concurrency: workerConcurrency() })
export class CampaignDlqRecoveryProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignDlqRecoveryProcessor');

  constructor(
    private readonly lock: DistributedLockService,
    private readonly dispatch: CampaignDispatchService,
  ) {
    super();
  }

  async process(_job: Job<BaseJobData>) {
    const token = await this.lock.acquire(LOCK_KEY, LOCK_TTL_MS);
    if (!token) {
      this.logger.log(
        'campaign DLQ recovery sweep already in progress elsewhere — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const result = await this.dispatch.recoverDeadLetters();
      if (result.attempted > 0) {
        this.logger.log(
          `campaign DLQ recovery sweep: ${result.recovered}/${result.attempted} recovered`,
        );
      }
      return result;
    } finally {
      await this.lock.release(LOCK_KEY, token);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
