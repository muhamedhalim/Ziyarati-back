import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { WhatsappWebhookProcessJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WhatsappWebhookService } from '../../modules/whatsapp/whatsapp-webhook.service';

/**
 * Consumes the `whatsapp-webhook` queue — inbound Meta events.
 *
 * The HTTP endpoint now only verifies, persists and enqueues, so ALL real work
 * (AI turns, delivery-status application, media fan-out) happens here. That is
 * what lets ingestion return a fast 200 to Meta while still getting retries and
 * durability: the old inline `void handleInboundValue(...)` had neither — a
 * crash or a slow LLM call silently lost the patient's message.
 *
 * Reuses WhatsappWebhookService.processEvent rather than re-deriving anything:
 * this processor is transport, not logic.
 */
@Processor(QUEUE.WHATSAPP_WEBHOOK, { concurrency: workerConcurrency() })
export class WhatsappWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger('WhatsappWebhookProcessor');

  constructor(
    private readonly webhooks: WhatsappWebhookService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<WhatsappWebhookProcessJob>) {
    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] ${job.name} event=${data.webhookEventId} ` +
        `tenant=${data.tenantId ?? '-'} attempt=${job.attemptsMade + 1}`,
    );
    // Open a tenant context so downstream services (AI bot actor, usage
    // metering) see the same principal/tenant they would on an HTTP request.
    return runInTenantContext(this.ctx, data, () =>
      this.webhooks.processEvent(data.webhookEventId),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // The event row stays `processed = false`, so it can be re-queued from the
    // admin retry endpoint after the cause is fixed — nothing is lost.
    this.logger.error(
      `${job?.name} job=${job?.id} event=${job?.data?.webhookEventId} ` +
        `FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
