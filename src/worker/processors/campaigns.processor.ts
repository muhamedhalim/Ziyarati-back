import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';

import {
  dispatchConcurrency,
  dispatchLimiter,
  expoJitterBackoff,
  JOB,
  QUEUE,
  workerConcurrency,
} from '../../queue/queue.constants';
import {
  CampaignFanoutChunkJob,
  CampaignLaunchJob,
  CampaignProcessRecipientJob,
} from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { CampaignFanoutService } from '../../modules/campaigns/campaign-fanout.service';
import { CampaignDispatchService } from '../../modules/campaigns/campaign-dispatch.service';

/** campaigns.launch — kicks off the fan-out for a run (idempotent). */
@Processor(QUEUE.CAMPAIGNS_LAUNCH, { concurrency: workerConcurrency() })
export class CampaignLaunchProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignLaunchProcessor');

  constructor(
    private readonly fanout: CampaignFanoutService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job) {
    const data = job.data as CampaignLaunchJob;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] launch campaign=${data.campaignId} run=${data.runId}`,
    );
    return runInTenantContext(this.ctx, data, () =>
      this.fanout.handleLaunch(data.tenantId, data.campaignId, data.runId, data.correlationId),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`launch job=${job?.id} FAILED: ${err?.message}`);
  }
}

/** campaigns.fanoutChunk — one keyset window → addBulk → next chunk. */
@Processor(QUEUE.CAMPAIGNS_FANOUT, { concurrency: workerConcurrency() })
export class CampaignFanoutProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignFanoutProcessor');

  constructor(
    private readonly fanout: CampaignFanoutService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job) {
    const data = job.data as CampaignFanoutChunkJob;
    return runInTenantContext(this.ctx, data, () =>
      this.fanout.handleChunk(
        data.tenantId,
        data.campaignId,
        data.runId,
        data.cursor,
        data.correlationId,
      ),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`fanoutChunk job=${job?.id} FAILED: ${err?.message}`);
  }
}

/**
 * campaigns.processRecipient — the hot path. Higher concurrency, a GLOBAL
 * provider-protection limiter, and exponential-with-jitter backoff.
 *
 * Retry classification:
 *  - rate-limited        → moveToDelayed (does NOT consume an attempt).
 *  - TransientDispatch.. → thrown → BullMQ retries; on exhaustion → DLQ.
 *  - PermanentDispatch.. (UnrecoverableError) → fails with no retry, no DLQ.
 */
@Processor(QUEUE.CAMPAIGNS_PROCESS, {
  concurrency: dispatchConcurrency(),
  limiter: dispatchLimiter(),
  settings: { backoffStrategy: (attemptsMade: number) => expoJitterBackoff(attemptsMade) },
})
export class CampaignDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignDispatchProcessor');

  constructor(
    private readonly dispatch: CampaignDispatchService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job, token?: string) {
    const data = job.data as CampaignProcessRecipientJob;
    return runInTenantContext(this.ctx, data, async () => {
      const outcome = await this.dispatch.dispatch(
        data.tenantId,
        data.runId,
        data.recipientId,
      );
      if (outcome.status === 'rate_limited' || outcome.status === 'deferred') {
        // Reschedule WITHOUT consuming an attempt:
        //  - rate_limited: tenant pacing/cap throttle.
        //  - deferred: run is PAUSED (DRAINING) — re-check after the pause window.
        await job.moveToDelayed(Date.now() + outcome.retryAfterMs, token);
        throw new DelayedError();
      }
      return outcome;
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    if (err instanceof DelayedError) return; // expected rescheduling, not a failure
    const data = job?.data as CampaignProcessRecipientJob;
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
    const permanent = err instanceof UnrecoverableError;
    this.logger.error(
      `processRecipient job=${job?.id} recipient=${data?.recipientId} FAILED ` +
        `(attempt ${job?.attemptsMade}, permanent=${permanent}): ${err?.message}`,
    );
    if (exhausted && !permanent) {
      // Reconcile the run FIRST: mark the recipient terminally FAILED + advance
      // counters, so the run can complete even though this one is dead-lettered.
      // Without this the run would hang in PROCESSING forever.
      if (data?.runId && data?.recipientId) {
        await this.dispatch
          .markDeadLettered(data.runId, data.recipientId, err?.message ?? 'exhausted')
          .catch((e) =>
            this.logger.error(`DLQ reconcile failed: ${(e as Error)?.message}`),
          );
      }
      // Poison transient failure → park in the DLQ for admin replay.
      await this.queue
        .enqueueCampaignDlq({
          tenantId: data?.tenantId ?? null,
          correlationId: data?.correlationId,
          sourceQueue: QUEUE.CAMPAIGNS_PROCESS,
          sourceJobName: JOB.CAMPAIGNS_PROCESS_RECIPIENT,
          originalJobId: String(job?.id ?? ''),
          originalData: data as unknown as Record<string, unknown>,
          failedReason: err?.message ?? 'unknown',
          attemptsMade: job?.attemptsMade ?? 0,
          diedAt: new Date().toISOString(),
        })
        .catch((e) => this.logger.error(`DLQ enqueue failed: ${(e as Error)?.message}`));
    }
  }
}
