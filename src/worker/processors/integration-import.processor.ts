import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import {
  EXTENDED_LOCK_DURATION_MS,
  QUEUE,
  workerConcurrency,
} from '../../queue/queue.constants';
import { IntegrationImportJobData } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { IntegrationImportJobService } from '../../modules/integration-platform/imports/integration-import-job.service';

/**
 * Consumes `integration.import` — drains a durable import job's staged records
 * through the shared write pipeline. The `integration_import_jobs` row is the
 * source of truth; the service handles idempotency (terminal jobs short-circuit),
 * progress, cancellation, and payload cleanup. This processor is transport only.
 *
 * Recovery: a deterministic jobId collapses duplicate enqueues; a job left
 * `running` by a dead worker is re-processed idempotently (mapping makes each
 * record a no-op on the second pass).
 */
@Processor(QUEUE.INTEGRATION_IMPORT, {
  concurrency: workerConcurrency(),
  lockDuration: EXTENDED_LOCK_DURATION_MS,
})
export class IntegrationImportProcessor extends WorkerHost {
  private readonly logger = new Logger('IntegrationImportProcessor');

  constructor(
    private readonly imports: IntegrationImportJobService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
  ) {
    super();
  }

  async process(job: Job<IntegrationImportJobData>): Promise<void> {
    const data = job.data;
    validateJobPayload(job.name, data);
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] import job=${data.importJobId} tenant=${data.tenantId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
      this.imports.process(data.importJobId),
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    const data = job?.data as IntegrationImportJobData | undefined;
    this.logger.error(
      `integration.import job=${job?.id} import=${data?.importJobId} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
