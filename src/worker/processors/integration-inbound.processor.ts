import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { IntegrationInboundJobData } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { IntegrationInboundService } from '../../modules/integration-platform/inbound/integration-inbound.service';

/**
 * Consumes `integration.inbound` — applies a verified inbound webhook event
 * through the SHARED write pipeline. The `integration_inbound_events` row is the
 * source of truth: the service handles idempotency (terminal events
 * short-circuit, the shared idempotency service dedupes a redelivered job),
 * attempt counting, and payload cleanup. This processor is transport only.
 *
 * Retry safety: the enqueue uses a deterministic jobId, so a duplicate enqueue
 * collapses; a redelivered job re-enters `process()` which short-circuits if the
 * event already reached a terminal state. Throwing here is deliberate — it lets
 * BullMQ back off and retry until the attempt cap parks the event as `failed`
 * with its reason, so nothing is ever dropped in silence.
 */
@Processor(QUEUE.INTEGRATION_INBOUND, { concurrency: workerConcurrency() })
export class IntegrationInboundProcessor extends WorkerHost {
  private readonly logger = new Logger('IntegrationInboundProcessor');

  constructor(
    private readonly inbound: IntegrationInboundService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
  ) {
    super();
  }

  async process(job: Job<IntegrationInboundJobData>): Promise<void> {
    const data = job.data;
    validateJobPayload(job.name, data);
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] inbound event=${data.inboundEventId} tenant=${data.tenantId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
      this.inbound.process(data.inboundEventId),
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    const data = job?.data as IntegrationInboundJobData | undefined;
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(
      `integration.inbound job=${job?.id} event=${data?.inboundEventId} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
