import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { WhatsappMediaDownloadJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WhatsappMediaService } from '../../modules/whatsapp/meta/whatsapp-media.service';

/**
 * Consumes the `whatsapp-media` queue — inbound media downloads.
 *
 * Isolated from the webhook queue on purpose: a 16 MB video download is slow
 * and failure-prone (Meta's media URLs expire within minutes), and sharing a
 * queue would let one large file stall every patient's message processing.
 *
 * Retries are BullMQ's exponential backoff. Because the job carries the media
 * ID rather than a resolved URL, a retry minutes or hours later re-resolves a
 * fresh URL and still succeeds.
 */
@Processor(QUEUE.WHATSAPP_MEDIA, { concurrency: workerConcurrency() })
export class WhatsappMediaProcessor extends WorkerHost {
  private readonly logger = new Logger('WhatsappMediaProcessor');

  constructor(
    private readonly media: WhatsappMediaService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<WhatsappMediaDownloadJob>) {
    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] ${job.name} tenant=${data.tenantId} ` +
        `type=${data.mediaType} message=${data.messageId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, data, () => this.media.downloadAndAttach(data));
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // Media is an enrichment: a permanent failure leaves the message itself
    // intact in the timeline, just without its attachment.
    this.logger.error(
      `${job?.name} job=${job?.id} media=${job?.data?.mediaId} ` +
        `FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
