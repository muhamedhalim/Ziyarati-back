import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { EmailSendJob } from '../../queue/job-data.interface';
import { EmailDeliveryService } from '../../modules/email/email-delivery.service';

/**
 * Consumes the `email` queue and delivers via {@link EmailDeliveryService}
 * (render → provider → email_logs). Retries + backoff come from the default job
 * options; a per-worker limiter caps the provider send rate. Transient failures
 * re-throw so BullMQ retries; permanent failures are recorded and swallowed.
 */
@Processor(QUEUE.EMAIL, {
  concurrency: workerConcurrency(),
  limiter: { max: 10, duration: 1000 },
})
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger('EmailProcessor');

  constructor(private readonly delivery: EmailDeliveryService) {
    super();
  }

  async process(job: Job<EmailSendJob>) {
    await this.delivery.deliver(job.data);
    return { ok: true };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
