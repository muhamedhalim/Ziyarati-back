import { Injectable, Logger } from '@nestjs/common';

import { AppError, ErrorCode } from '../../common/errors';
import { QueueService } from '../../queue/queue.service';
import { QUEUE, QueueName } from '../../queue/queue.constants';
import { BaseJobData, WhatsappDlqJob } from '../../queue/job-data.interface';

/**
 * Dead-letter queue admin operations for the inbound `whatsapp-webhook` and
 * `whatsapp-media` queues (mirrors `CampaignDlqService`).
 *
 * Simpler than the campaign DLQ on purpose: neither source queue owns any
 * counters to reconcile on replay (an inbound webhook event or a media
 * download has no "queued/failed" tally to give back), so replay here is just
 * "re-enqueue the original job data onto its source queue with a fresh
 * attempt budget."
 */
@Injectable()
export class WhatsappDlqService {
  private readonly logger = new Logger('WhatsappDlqService');

  constructor(private readonly queue: QueueService) {}

  /** Current DLQ depth (waiting + delayed). */
  depth(): Promise<number> {
    return this.queue.dlqDepth(QUEUE.WHATSAPP_DLQ);
  }

  /** List parked DLQ jobs (newest first). */
  async list(limit = 100) {
    const dlq = this.queue.queue(QUEUE.WHATSAPP_DLQ);
    const jobs = await dlq.getJobs(['waiting', 'delayed'], 0, Math.max(0, limit - 1), false);
    return jobs.map((j) => {
      const d = j.data as WhatsappDlqJob;
      return {
        jobId: j.id,
        sourceQueue: d.sourceQueue,
        sourceJobName: d.sourceJobName,
        tenantId: d.tenantId,
        failedReason: d.failedReason,
        attemptsMade: d.attemptsMade,
        diedAt: d.diedAt,
        originalData: d.originalData,
      };
    });
  }

  /** Replay a parked job back onto its source queue with a fresh attempt budget. */
  async replay(jobId: string) {
    const dlq = this.queue.queue(QUEUE.WHATSAPP_DLQ);
    const job = await dlq.getJob(jobId);
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'DLQ job not found' });

    const data = job.data as WhatsappDlqJob;
    const sourceQueue = data.sourceQueue as QueueName;
    if (sourceQueue !== QUEUE.WHATSAPP_WEBHOOK && sourceQueue !== QUEUE.WHATSAPP_MEDIA) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Replay not supported for source queue "${data.sourceQueue}"`,
      });
    }

    // A fresh jobId (Date.now() suffix) is required: BullMQ's default jobId
    // for both source queues is deterministic (`wa-webhook-<id>` /
    // `wa-media-<messageId>-<mediaId>`), and the original job may still exist
    // in BullMQ's retained `failed` set — re-adding under the same id would
    // be a silent no-op rather than a real retry.
    const replayData = {
      ...data.originalData,
      correlationId: data.correlationId,
    } as unknown as BaseJobData;
    await this.queue.publish(
      sourceQueue,
      data.sourceJobName,
      replayData,
      `${data.sourceJobName}-replay-${data.originalJobId ?? job.id}-${Date.now()}`,
    );

    await job.remove().catch(() => undefined);
    this.logger.log(`Replayed DLQ job ${jobId} → ${sourceQueue}`);
    return { replayed: true, jobId };
  }

  /** Discard a parked job without replaying. */
  async discard(jobId: string) {
    const dlq = this.queue.queue(QUEUE.WHATSAPP_DLQ);
    const job = await dlq.getJob(jobId);
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'DLQ job not found' });
    await job.remove();
    return { discarded: true, jobId };
  }
}
