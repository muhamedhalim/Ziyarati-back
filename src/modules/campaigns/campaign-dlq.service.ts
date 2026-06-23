import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignExecution, RecipientProcessing } from '../../entities/enums';
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
    private readonly dataSource: DataSource,
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
   *
   * Because the dead-letter reconcile counted the recipient as FAILED (so the run
   * could complete), replay must REVERSE that accounting in the same transaction:
   * reset the recipient to PENDING, give back one `failed`→`queued`, and reopen a
   * COMPLETED run to PROCESSING so the re-enqueued send can actually run and the
   * run can re-complete. All guarded by affected-rows so a double replay is a no-op.
   */
  async replay(jobId: string) {
    const dlq = this.queue.queue(QUEUE.CAMPAIGNS_DLQ);
    const job = await dlq.getJob(jobId);
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'DLQ job not found' });

    const data = job.data as CampaignDlqJob;
    if (data.sourceQueue !== QUEUE.CAMPAIGNS_PROCESS) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Replay not supported for source queue "${data.sourceQueue}"`,
      });
    }

    const orig = data.originalData as unknown as CampaignProcessRecipientJob;
    await this.dataSource.transaction(async (mgr) => {
      const res = await mgr.update(
        CampaignRecipient,
        { id: orig.recipientId, processing: RecipientProcessing.FAILED },
        { processing: RecipientProcessing.PENDING, failure_class: null, failure_reason: null },
      );
      if ((res.affected ?? 0) > 0) {
        // Give the slot back to the run's queue.
        await mgr
          .createQueryBuilder()
          .update(CampaignRun)
          .set({ failed: () => 'GREATEST(failed - 1, 0)', queued: () => 'queued + 1' })
          .where('id = :runId', { runId: orig.runId })
          .execute();
        // Reopen a finished run so the replayed send can proceed.
        await mgr
          .createQueryBuilder()
          .update(CampaignRun)
          .set({ execution: CampaignExecution.PROCESSING, finished_at: () => 'NULL' })
          .where('id = :runId', { runId: orig.runId })
          .andWhere('execution = :done', { done: CampaignExecution.COMPLETED })
          .execute();
      }
    });

    await this.queue.enqueueCampaignRecipient({
      tenantId: orig.tenantId,
      campaignId: orig.campaignId,
      runId: orig.runId,
      recipientId: orig.recipientId,
      correlationId: data.correlationId,
    });

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
