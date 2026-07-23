import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { IntegrationSyncJobData } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { IntegrationSyncService } from '../../modules/integration-platform/sync/integration-sync.service';

/**
 * Consumes `integration.sync` — runs one synchronization pass (pull bounded pages
 * from the provider adapter, write via the shared pipeline, advance the cursor).
 * The `integration_sync_jobs` row is the source of truth; the service handles
 * idempotency, cursor progression, cancellation and resume. A mid-run failure
 * re-throws so BullMQ retries — the last successful cursor is the resume point.
 */
@Processor(QUEUE.INTEGRATION_SYNC, { concurrency: workerConcurrency() })
export class IntegrationSyncProcessor extends WorkerHost {
  private readonly logger = new Logger('IntegrationSyncProcessor');

  constructor(
    private readonly sync: IntegrationSyncService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<IntegrationSyncJobData>): Promise<void> {
    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] sync job=${data.syncJobId} tenant=${data.tenantId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, data, () => this.sync.process(data.syncJobId));
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    const data = job?.data as IntegrationSyncJobData | undefined;
    this.logger.error(`integration.sync job=${job?.id} sync=${data?.syncJobId} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
