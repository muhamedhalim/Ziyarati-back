import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { EmailSendJob } from '../../queue/job-data.interface';
import { EmailDeliveryService } from '../../modules/email/email-delivery.service';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';

/**
 * Consumes the `email` queue and delivers via {@link EmailDeliveryService}
 * (render → provider → email_logs). Retries + backoff come from the default job
 * options; a per-worker limiter caps the provider send rate. Transient failures
 * re-throw so BullMQ retries; permanent failures are recorded in `email_logs`
 * and thrown as `UnrecoverableError`, so the job ends FAILED (visible to
 * `onFailed` below and QueueMonitor) without further attempts.
 *
 * FND-036: wired to the same `runInTenantContext` + `validateJobPayload` +
 * `WorkerAuthorizationService` trio every sibling processor uses (see
 * `notifications.processor.ts`), so a tenant suspended AFTER a job was
 * enqueued no longer gets that email delivered. `JOB.EMAIL_SEND` already
 * carries a `SYSTEM_OR_TENANT` policy (`job-authorization.constants.ts:92`) —
 * this was simply never consulted before.
 */
@Processor(QUEUE.EMAIL, {
  concurrency: workerConcurrency(),
  limiter: { max: 10, duration: 1000 },
})
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger('EmailProcessor');

  constructor(
    private readonly delivery: EmailDeliveryService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
  ) {
    super();
  }

  async process(job: Job<EmailSendJob>) {
    const data = job.data;
    validateJobPayload(job.name, data);
    return runInTenantContext(this.ctx, this.authz, job.name, data, async () => {
      await this.delivery.deliver(data);
      return { ok: true };
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
