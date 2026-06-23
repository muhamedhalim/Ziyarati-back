import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { RecipientProcessing } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { QueueService } from '../../queue/queue.service';
import { QUEUE } from '../../queue/queue.constants';
import { CampaignDlqJob, CampaignProcessRecipientJob } from '../../queue/job-data.interface';

/**
 * Dead-Letter Queue admin operations. The DLQ is never auto-processed; these
 * methods back the admin endpoints for inspecting and replaying parked jobs.
 */
@Injectable()
export class CampaignDlqService {
  private readonly logger = new Logger('CampaignDlqService');

  constructor(
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
    private readonly queue: QueueService,
  ) {}

  /** Current DLQ depth (waiting + delayed). */
  depth(): Promise<number> {
    return this.queue.dlqDepth();
  }

  /** List parked DLQ jobs (newest first). */
  async list(limit = 100) {
    const dlq = this.queue.queue(QUEUE.CAMPAIGNS_DLQ);
    const jobs = await dlq.getJobs(['waiting', 'delayed'], 0, Math.max(0, limit - 1), false);
    return jobs.map((j) => {
      const d = j.data as CampaignDlqJob;
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

  /**
   * Replay a parked job back onto its source queue with a fresh attempt budget.
   * For recipient jobs the recipient is reset to PENDING so the claim guard lets
   * the new job through.
   */
  async replay(jobId: string) {
    const dlq = this.queue.queue(QUEUE.CAMPAIGNS_DLQ);
    const job = await dlq.getJob(jobId);
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'DLQ job not found' });

    const data = job.data as CampaignDlqJob;
    if (data.sourceQueue === QUEUE.CAMPAIGNS_PROCESS) {
      const orig = data.originalData as unknown as CampaignProcessRecipientJob;
      await this.recipients.update(
        { id: orig.recipientId },
        { processing: RecipientProcessing.PENDING, failure_class: null, failure_reason: null },
      );
      await this.queue.enqueueCampaignRecipient({
        tenantId: orig.tenantId,
        campaignId: orig.campaignId,
        runId: orig.runId,
        recipientId: orig.recipientId,
        correlationId: data.correlationId,
      });
    } else {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Replay not supported for source queue "${data.sourceQueue}"`,
      });
    }

    await job.remove().catch(() => undefined);
    this.logger.log(`Replayed DLQ job ${jobId} → ${data.sourceQueue}`);
    return { replayed: true, jobId };
  }

  /** Discard a parked job without replaying. */
  async discard(jobId: string) {
    const dlq = this.queue.queue(QUEUE.CAMPAIGNS_DLQ);
    const job = await dlq.getJob(jobId);
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'DLQ job not found' });
    await job.remove();
    return { discarded: true, jobId };
  }
}
