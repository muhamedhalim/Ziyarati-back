import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { NotificationDispatchJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';

/**
 * Consumes the `notifications` queue.
 *  - notifications.dispatch : atomic-claim send (NotificationDispatchService).
 *      TRANSIENT failures throw → BullMQ retries; exhausted → reconcile FAILED + DLQ.
 *      PERMANENT failures are recorded in-band (no throw, no retry).
 *  - notifications.reap     : maintenance sweep (reclaim stale PROCESSING +
 *      re-enqueue due-but-unsent rows). Durability / crash recovery.
 */
@Processor(QUEUE.NOTIFICATIONS, { concurrency: workerConcurrency() })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger('NotificationsProcessor');

  constructor(
    private readonly dispatch: NotificationDispatchService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job, token?: string) {
    if (job.name === JOB.NOTIFICATIONS_REAP) {
      const res = await this.dispatch.reapAndRequeue();
      this.logger.log(`reap: reclaimed=${res.reclaimed} requeued=${res.requeued} purgedLogs=${res.purgedLogs}`);
      return res;
    }

    const data = job.data as NotificationDispatchJob;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] dispatch tenant=${data.tenantId} id=${data.notificationId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, data, async () => {
      const outcome = await this.dispatch.processScheduled(data.tenantId, data.notificationId);
      if (outcome.status === 'rate_limited') {
        // Defer WITHOUT consuming an attempt (tenant pacing, not a failure).
        await job.moveToDelayed(Date.now() + outcome.retryAfterMs, token);
        throw new DelayedError();
      }
      return outcome;
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    if (err instanceof DelayedError) return; // expected rate-limit reschedule
    if (job?.name !== JOB.NOTIFICATIONS_DISPATCH) {
      this.logger.error(`${job?.name} job=${job?.id} FAILED: ${err?.message}`);
      return;
    }
    const data = job?.data as NotificationDispatchJob;
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
    const permanent = err instanceof UnrecoverableError;
    this.logger.error(
      `dispatch job=${job?.id} id=${data?.notificationId} FAILED (attempt ${job?.attemptsMade}, permanent=${permanent}): ${err?.message}`,
    );
    if (exhausted && !permanent && data?.tenantId && data?.notificationId) {
      // Reconcile to terminal FAILED so the sweep stops re-queuing it…
      await this.dispatch
        .markDeadLettered(data.tenantId, data.notificationId, err?.message ?? 'exhausted')
        .catch((e) => this.logger.error(`DLQ reconcile failed: ${(e as Error)?.message}`));
      // …then park the envelope for inspection/replay.
      await this.queue
        .enqueueNotificationDlq({
          tenantId: data.tenantId,
          correlationId: data.correlationId,
          notificationId: data.notificationId,
          sourceQueue: QUEUE.NOTIFICATIONS,
          sourceJobName: JOB.NOTIFICATIONS_DISPATCH,
          originalJobId: String(job?.id ?? ''),
          failedReason: err?.message ?? 'unknown',
          attemptsMade: job?.attemptsMade ?? 0,
          diedAt: new Date().toISOString(),
        })
        .catch((e) => this.logger.error(`DLQ enqueue failed: ${(e as Error)?.message}`));
    }
  }
}
