import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { NotificationDispatchJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { QueueService } from '../../queue/queue.service';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';
import { InternalNotificationReadService } from '../../modules/notifications/internal/internal-notification-read.service';
import { MetricsService } from '../../metrics/metrics.service';

const REAP_LOCK_KEY = 'lock:notifications-reap';
/**
 * Shorter than the repeatable job's own 1-minute cron interval (see
 * ScheduleRegistrarService) so a crashed holder's lock cannot outlive the
 * next scheduled tick, but enough for a 1000-row scan + bulk enqueue under
 * load (gap-closure — see docs/CACHING_QUEUES_AUDIT.md M9).
 */
const REAP_LOCK_TTL_MS = 45_000;

/**
 * Consumes the `notifications` queue.
 *  - notifications.dispatch : atomic-claim send (NotificationDispatchService).
 *      TRANSIENT failures throw → BullMQ retries; exhausted → reconcile FAILED + DLQ.
 *      PERMANENT failures are recorded in-band (no throw, no retry).
 *  - notifications.reap     : maintenance sweep (reclaim stale PROCESSING +
 *      re-enqueue due-but-unsent rows). Durability / crash recovery.
 *      Lock-guarded: an overlapping reap run doubles the DB scan/enqueue load
 *      exactly when the system is already slow (M9) — not a correctness risk
 *      (the reclaim itself is a conditional `UPDATE`), just wasted work.
 */
@Processor(QUEUE.NOTIFICATIONS, { concurrency: workerConcurrency() })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger('NotificationsProcessor');

  constructor(
    private readonly dispatch: NotificationDispatchService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
    private readonly lock: DistributedLockService,
    private readonly metrics: MetricsService,
    /**
     * Owns retention for the internal in-app inbox — see the reap branch.
     *
     * Appended rather than inserted: this processor is constructed positionally
     * in its spec, so inserting a parameter mid-list silently reassigns every
     * collaborator after it.
     */
    private readonly inApp: InternalNotificationReadService,
  ) {
    super();
  }

  async process(job: Job, token?: string) {
    if (job.name === JOB.NOTIFICATIONS_REAP) {
      const lockToken = await this.lock.acquire(
        REAP_LOCK_KEY,
        REAP_LOCK_TTL_MS,
      );
      if (!lockToken) {
        this.logger.log(
          'notifications reap sweep already in progress elsewhere — skipping this run',
        );
        return { skipped: true };
      }
      try {
        const res = await this.dispatch.reapAndRequeue();

        // Retention for the INTERNAL in-app inbox rides on this existing sweep
        // rather than adding a second schedule: it is already lock-guarded,
        // already runs every minute, and already owns notification retention
        // (`purgedLogs`). Batched, so a large backlog drains over several ticks.
        //
        // Failure here is isolated: an inbox that keeps a few extra days of read
        // history is cosmetic, whereas losing the reclaim/requeue half of this
        // sweep would strand real outbound messages.
        let purgedInApp = 0;
        try {
          purgedInApp = await this.inApp.purgeExpired();
        } catch (err) {
          this.logger.warn(
            `in-app notification retention purge failed (reap otherwise succeeded): ${(err as Error)?.message}`,
          );
        }

        this.logger.log(
          `reap: reclaimed=${res.reclaimed} strandedForReview=${res.strandedForReview} ` +
            `requeued=${res.requeued} purgedLogs=${res.purgedLogs} purgedInApp=${purgedInApp}`,
        );
        // Last-successful-run signal (M9's own deferred half, folded into
        // M14 — see docs/CACHING_QUEUES_AUDIT.md).
        this.metrics.setWorkerHeartbeat('notifications.reap');
        return { ...res, purgedInApp };
      } finally {
        await this.lock.release(REAP_LOCK_KEY, lockToken);
      }
    }

    const data = job.data as NotificationDispatchJob;
    validateJobPayload(job.name, data);
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] dispatch tenant=${data.tenantId} id=${data.notificationId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(
      this.ctx,
      this.authz,
      job.name,
      data,
      async () => {
        const outcome = await this.dispatch.processScheduled(
          data.tenantId,
          data.notificationId,
        );
        if (outcome.status === 'rate_limited') {
          // Defer WITHOUT consuming an attempt (tenant pacing, not a failure).
          await job.moveToDelayed(Date.now() + outcome.retryAfterMs, token);
          throw new DelayedError();
        }
        return outcome;
      },
    );
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
    // `permanent` (UnrecoverableError — payload validation, worker
    // authorization) never retries, so `attemptsMade` never reaches
    // `opts.attempts` and `exhausted` alone would never fire for it: without
    // the `|| permanent` branch such a job fails once and silently vanishes
    // with no DLQ park (§18 test-plan gap, found while writing the "payload
    // validation → DLQ, no retry" test). A permanent failure is just as
    // terminal as an exhausted retry budget, so it gets the same DLQ park.
    if ((exhausted || permanent) && data?.tenantId && data?.notificationId) {
      // Reconcile to terminal FAILED so the sweep stops re-queuing it…
      await this.dispatch
        .markDeadLettered(
          data.tenantId,
          data.notificationId,
          err?.message ?? 'exhausted',
        )
        .catch((e) =>
          this.logger.error(`DLQ reconcile failed: ${(e as Error)?.message}`),
        );
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
        .catch((e) =>
          this.logger.error(`DLQ enqueue failed: ${(e as Error)?.message}`),
        );
    }
  }
}
