import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { BaseJobData } from '../../queue/job-data.interface';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { IntegrationImportJobService } from '../../modules/integration-platform/imports/integration-import-job.service';
import { IntegrationSyncService } from '../../modules/integration-platform/sync/integration-sync.service';
import { IntegrationInboundService } from '../../modules/integration-platform/inbound/integration-inbound.service';
import { MetricsService } from '../../metrics/metrics.service';

const LOCK_KEY = 'lock:integration-recover-stale';
/**
 * Must be comfortably shorter than the repeatable job's own cron interval (2
 * minutes — see ScheduleRegistrarService) so a lock from a crashed holder
 * can't outlive the next scheduled tick, but long enough to cover a full
 * three-service sweep (up to 100 rows each, one network round-trip per row).
 */
const LOCK_TTL_MS = 90_000;

/**
 * Consumes `integration.maintenance` (`integration.recoverStale`) — re-enqueues
 * import/sync/inbound rows left `running`/`processing` by a dead worker
 * (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.8). The three
 * `recoverStale()` methods already exist and are already unit-tested; this
 * processor is only the missing wiring, not new recovery logic.
 *
 * Lock-guarded: this is a system-wide sweep with no queue-level `lockDuration`
 * override, so a sweep that runs long under load can be handed to a SECOND
 * worker by BullMQ's own stall detector while the first is still mid-sweep —
 * a real double-execution path distinct from (and not fixed by) the repeat-key
 * dedup that already prevents duplicate *schedules*. If the lock is already
 * held, this run is a no-op (someone else — very likely the run BullMQ thinks
 * stalled — is already sweeping); it is not an error.
 */
@Processor(QUEUE.INTEGRATION_MAINTENANCE, { concurrency: workerConcurrency() })
export class IntegrationRecoveryProcessor extends WorkerHost {
  private readonly logger = new Logger('IntegrationRecoveryProcessor');

  constructor(
    private readonly lock: DistributedLockService,
    private readonly imports: IntegrationImportJobService,
    private readonly syncs: IntegrationSyncService,
    private readonly inbound: IntegrationInboundService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(_job: Job<BaseJobData>) {
    const token = await this.lock.acquire(LOCK_KEY, LOCK_TTL_MS);
    if (!token) {
      this.logger.log(
        'integration recovery sweep already in progress elsewhere — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const [importsRequeued, syncsRequeued, inboundRequeued] =
        await Promise.all([
          this.imports.recoverStale(),
          this.syncs.recoverStale(),
          this.inbound.recoverStale(),
        ]);
      const summary = { importsRequeued, syncsRequeued, inboundRequeued };
      if (importsRequeued + syncsRequeued + inboundRequeued > 0) {
        this.logger.log(
          `integration recovery sweep requeued: ${JSON.stringify(summary)}`,
        );
      }
      // Last-successful-run signal (M14 — docs/CACHING_QUEUES_AUDIT.md).
      this.metrics.setWorkerHeartbeat('integration.recoverStale');
      return summary;
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
