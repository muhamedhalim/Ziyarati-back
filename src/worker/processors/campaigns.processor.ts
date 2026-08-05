import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';

import {
  dispatchConcurrency,
  dispatchLimiter,
  EXTENDED_LOCK_DURATION_MS,
  expoJitterBackoff,
  QUEUE,
  workerConcurrency,
} from '../../queue/queue.constants';
import {
  CampaignFanoutChunkJob,
  CampaignLaunchJob,
  CampaignProcessRecipientJob,
} from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { QueueService } from '../../queue/queue.service';
import { CampaignDlqJob } from '../../queue/job-data.interface';
import { CampaignFanoutService } from '../../modules/campaigns/campaign-fanout.service';
import { CampaignDispatchService } from '../../modules/campaigns/campaign-dispatch.service';

/** campaigns.launch — kicks off the fan-out for a run (idempotent). */
@Processor(QUEUE.CAMPAIGNS_LAUNCH, { concurrency: workerConcurrency() })
export class CampaignLaunchProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignLaunchProcessor');

  constructor(
    private readonly fanout: CampaignFanoutService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
    private readonly queue: QueueService,
  ) {
    super();
  }

  async process(job: Job) {
    const data = job.data as CampaignLaunchJob;
    validateJobPayload(job.name, data);
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] launch campaign=${data.campaignId} run=${data.runId}`,
    );
    return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
      this.fanout.handleLaunch(
        data.tenantId,
        data.campaignId,
        data.runId,
        data.correlationId,
      ),
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    this.logger.error(`launch job=${job?.id} FAILED: ${err?.message}`);
    await parkExhaustedOrPermanent(this.queue, QUEUE.CAMPAIGNS_LAUNCH, job, err, this.logger);
  }
}

/** campaigns.fanoutChunk — one keyset window → addBulk → next chunk. */
@Processor(QUEUE.CAMPAIGNS_FANOUT, { concurrency: workerConcurrency() })
export class CampaignFanoutProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignFanoutProcessor');

  constructor(
    private readonly fanout: CampaignFanoutService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
    private readonly queue: QueueService,
  ) {
    super();
  }

  async process(job: Job) {
    const data = job.data as CampaignFanoutChunkJob;
    validateJobPayload(job.name, data);
    return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
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
  async onFailed(job: Job, err: Error) {
    this.logger.error(`fanoutChunk job=${job?.id} FAILED: ${err?.message}`);
    await parkExhaustedOrPermanent(this.queue, QUEUE.CAMPAIGNS_FANOUT, job, err, this.logger);
  }
}

/**
 * FND-038 — shared exhausted/permanent → CAMPAIGNS_DLQ park, reusing the
 * exact pattern `WhatsappProcessor.onFailed` (Wave 2, FND-022) established:
 * exhausted transient retries OR an `UnrecoverableError` (which never
 * retries, so `attemptsMade` never reaches `opts.attempts`) both park.
 * `CampaignDispatchProcessor` (the third processor in this file, CAMPAIGNS_PROCESS
 * queue) already dead-letters correctly via `markDeadLettered` (Wave 3,
 * FND-020) — that call is per-recipient reconciliation-DB-row-specific and
 * does not apply to a launch/fanout-chunk job, which has no such row.
 */
async function parkExhaustedOrPermanent(
  queue: QueueService,
  sourceQueue: string,
  job: Job,
  err: Error,
  logger: Logger,
): Promise<void> {
  const data = job?.data as { tenantId?: string | null; correlationId?: string } | undefined;
  if (!data) return;
  const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
  const permanent = err instanceof UnrecoverableError;
  if (!exhausted && !permanent) return;

  await queue
    .enqueueCampaignDlq({
      tenantId: data.tenantId ?? null,
      correlationId: data.correlationId,
      sourceQueue,
      sourceJobName: job.name,
      originalJobId: String(job?.id ?? ''),
      originalData: data as unknown as Record<string, unknown>,
      failedReason: err?.message ?? 'unknown',
      attemptsMade: job?.attemptsMade ?? 0,
      diedAt: new Date().toISOString(),
    } satisfies CampaignDlqJob)
    .catch((e) => logger.error(`DLQ enqueue failed: ${(e as Error)?.message}`));
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
  lockDuration: EXTENDED_LOCK_DURATION_MS,
  settings: {
    backoffStrategy: (attemptsMade: number) => expoJitterBackoff(attemptsMade),
  },
})
export class CampaignDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger('CampaignDispatchProcessor');

  constructor(
    private readonly dispatch: CampaignDispatchService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
  ) {
    super();
  }

  async process(job: Job, token?: string) {
    const data = job.data as CampaignProcessRecipientJob;
    validateJobPayload(job.name, data);
    return runInTenantContext(
      this.ctx,
      this.authz,
      job.name,
      data,
      async () => {
        const outcome = await this.dispatch.dispatch(
          data.tenantId,
          data.runId,
          data.recipientId,
        );
        if (
          outcome.status === 'rate_limited' ||
          outcome.status === 'deferred'
        ) {
          // Reschedule WITHOUT consuming an attempt:
          //  - rate_limited: tenant pacing/cap throttle.
          //  - deferred: run is PAUSED (DRAINING) — re-check after the pause window.
          await job.moveToDelayed(Date.now() + outcome.retryAfterMs, token);
          throw new DelayedError();
        }
        return outcome;
      },
    );
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
      // Reconcile the run FIRST (recipient → terminal FAILED, run counters
      // advanced — so the run can complete even though this one is
      // dead-lettered), THEN attempt the DLQ write itself — both folded into
      // one call (FND-020) so a failed DLQ write is recorded as such
      // (`dlq_recorded_at` stays null) rather than merely logged-and-lost;
      // `CampaignDispatchService.recoverDeadLetters()`'s periodic sweep picks
      // up anything that doesn't land here.
      if (data?.runId && data?.recipientId) {
        await this.dispatch
          .markDeadLettered(
            data.runId,
            data.recipientId,
            err?.message ?? 'exhausted',
            {
              tenantId: data?.tenantId ?? null,
              correlationId: data?.correlationId,
              attemptsMade: job?.attemptsMade ?? 0,
            },
          )
          .catch((e) =>
            this.logger.error(`DLQ reconcile failed: ${(e as Error)?.message}`),
          );
      }
    }
  }
}
