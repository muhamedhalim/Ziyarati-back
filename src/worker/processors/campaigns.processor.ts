import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import {
  CampaignLaunchJob,
  CampaignProcessRecipientJob,
} from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { CampaignExecutionService } from '../../modules/campaigns/campaign-execution.service';

/**
 * Consumes the `campaigns` queue.
 *  - `campaigns.launch`: fan-out — load the campaign's QUEUED recipients and
 *    enqueue one `campaigns.processRecipient` job per recipient (scalable; each
 *    recipient is retried independently).
 *  - `campaigns.processRecipient`: reuse CampaignExecutionService.dispatchRecipient
 *    (resolves the channel provider + updates recipient status). Deterministic
 *    job id per recipient makes redelivery idempotent.
 */
@Processor(QUEUE.CAMPAIGNS, { concurrency: workerConcurrency() })
export class CampaignsProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignsProcessor');

  constructor(
    private readonly exec: CampaignExecutionService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === JOB.CAMPAIGNS_LAUNCH) {
      const data = job.data as CampaignLaunchJob;
      this.logger.log(`[cid=${data.correlationId ?? '-'}] launch campaign=${data.campaignId} tenant=${data.tenantId}`);
      return runInTenantContext(this.ctx, data, async () => {
        const recipientIds = await this.exec.queuedRecipientIds(data.tenantId, data.campaignId);
        for (const recipientId of recipientIds) {
          await this.queue.enqueueCampaignRecipient({
            tenantId: data.tenantId,
            recipientId,
            correlationId: data.correlationId,
            actorId: data.actorId,
          });
        }
        this.logger.log(`campaign=${data.campaignId} fanned out ${recipientIds.length} recipient job(s)`);
        return { fannedOut: recipientIds.length };
      });
    }

    const data = job.data as CampaignProcessRecipientJob;
    this.logger.log(`[cid=${data.correlationId ?? '-'}] processRecipient recipient=${data.recipientId} tenant=${data.tenantId} attempt=${job.attemptsMade + 1}`);
    return runInTenantContext(this.ctx, data, () =>
      this.exec.dispatchRecipient(data.tenantId, data.recipientId),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
