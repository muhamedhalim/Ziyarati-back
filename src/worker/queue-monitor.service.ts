import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';

import { ALL_QUEUES, bullPrefix, DLQ_QUEUES } from '../queue/queue.constants';
import { eventsConnectionOptions } from '../queue/redis.config';
import { QueueService } from '../queue/queue.service';
import { MetricsService } from '../metrics/metrics.service';
import { LOG_EVENT } from '../common/logging/log-events';

/**
 * Centralized queue observability via BullMQ QueueEvents. One listener per queue
 * logs failed / stalled jobs (correlation ids are emitted by the processors
 * themselves on each attempt). Also polls all four DLQ depths on an interval
 * and warns above a threshold — the hook point for alerting. Runs only in the
 * worker process; its connections are closed on shutdown.
 *
 * `completed` is NOT logged by default (Phase 0 correction — see
 * docs/CACHING_QUEUES_AUDIT.md §0.5 / original audit H3): a single large
 * campaign run produces one `completed` line per recipient, which at real
 * volume drowns real errors and adds per-job logging overhead on the hottest
 * path in the system. Set `QUEUE_LOG_COMPLETED=true` to restore it for
 * local debugging.
 */
@Injectable()
export class QueueMonitorService implements OnModuleInit, OnModuleDestroy {
  /** Bounded scan per DLQ per sweep (FND-037) — never an unbounded queue walk. */
  private static readonly DLQ_SWEEP_SCAN_CAP = 500;

  private readonly logger = new Logger('QueueMonitor');
  private readonly events: QueueEvents[] = [];
  private dlqTimer?: NodeJS.Timeout;
  private depthTimer?: NodeJS.Timeout;

  private readonly dlqPollMs = Number(process.env.DLQ_POLL_MS ?? '30000');
  private readonly dlqWarnAt = Number(process.env.DLQ_WARN_THRESHOLD ?? '100');
  private readonly logCompleted = process.env.QUEUE_LOG_COMPLETED === 'true';
  /** Queue-depth gauge poll interval (M14) — deliberately its own timer, not
   *  reusing dlqPollMs, so tuning one doesn't silently retune the other. */
  private readonly depthPollMs = Number(
    process.env.METRICS_QUEUE_DEPTH_POLL_MS ?? '30000',
  );

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const connection = eventsConnectionOptions(this.config); // dedicated events profile
    for (const name of ALL_QUEUES) {
      const qe = new QueueEvents(name, { connection, prefix: bullPrefix() });
      // Counting is unconditional (M14 — docs/CACHING_QUEUES_AUDIT.md): unlike
      // the per-job LOG line (deliberately gated behind QUEUE_LOG_COMPLETED,
      // see H3), incrementing a counter is cheap even at campaign-recipient
      // volume and is the whole point of "count instead of log."
      qe.on('completed', ({ jobId }) => {
        this.metrics.recordJobEvent(name, 'completed');
        if (this.logCompleted)
          this.logger.log(`[${name}] ✓ completed job=${jobId}`);
      });
      // Failure ownership (LOGGING.md): the processor wrapper
      // (common/logging/job-instrumentation.ts) logs each failed attempt
      // ONCE, from the replica that ran it, with attempt/duration/tenant.
      // This listener runs in EVERY worker replica and sees every failure in
      // the cluster, so logging here too duplicated each failure N+1 times.
      // Kept at debug for local diagnosis only.
      qe.on('failed', ({ jobId, failedReason }) => {
        this.metrics.recordJobEvent(name, 'failed');
        this.logger.debug(`[${name}] failed job=${jobId} (QueueEvents): ${failedReason}`);
      });
      // Stalled jobs are only observable here (a stalled job never reached
      // the wrapper's catch), so this remains the owner of that event.
      qe.on('stalled', ({ jobId }) => {
        this.metrics.recordJobEvent(name, 'stalled');
        this.logger.warn({
          event: LOG_EVENT.JOB_STALLED,
          message: `[${name}] ⚠ stalled job=${jobId}`,
          queue: name,
          job_id: jobId,
        });
      });
      qe.on('error', (err) =>
        this.logger.error({
          event: 'queue.events.failed',
          message: `[${name}] queue-events error: ${err?.message}`,
          queue: name,
          error: err,
        }),
      );
      this.events.push(qe);
    }
    this.logger.log(
      `QueueEvents monitoring ${ALL_QUEUES.length} queues (completed-job logging ${this.logCompleted ? 'ON' : 'off'})`,
    );

    this.dlqTimer = setInterval(() => {
      void this.reportDlqDepths();
      void this.sweepExpiredDlqJobs();
    }, this.dlqPollMs);
    this.depthTimer = setInterval(
      () => void this.reportQueueDepths(),
      this.depthPollMs,
    );
  }

  /** Refreshes the `bullmq_queue_depth` gauge for every queue (M14). */
  private async reportQueueDepths(): Promise<void> {
    try {
      const counts = await this.queue.queueCounts();
      for (const [name, byState] of Object.entries(counts)) {
        for (const [state, value] of Object.entries(byState)) {
          this.metrics.setQueueDepth(name, state, value);
        }
      }
    } catch (err) {
      this.logger.error(
        `Queue depth metrics poll failed: ${(err as Error)?.message}`,
      );
    }
  }

  /** Polls every DLQ this worker parks jobs into (all four — see `DLQ_QUEUES`). */
  private async reportDlqDepths(): Promise<void> {
    for (const dlq of DLQ_QUEUES) {
      try {
        const depth = await this.queue.dlqDepth(dlq);
        if (depth >= this.dlqWarnAt) {
          this.logger.error({
            event: LOG_EVENT.QUEUE_DLQ_DEPTH_HIGH,
            message: `[${dlq}] depth=${depth} ≥ threshold ${this.dlqWarnAt} — ALERT`,
            queue: dlq,
            depth,
            threshold: this.dlqWarnAt,
          });
        } else if (depth > 0) {
          this.logger.warn(`[${dlq}] depth=${depth}`);
        }
      } catch (err) {
        this.logger.error(
          `DLQ depth poll failed for ${dlq}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  /**
   * FND-037 — actually expires parked DLQ jobs. No Worker ever processes a
   * DLQ queue (see `DLQ_QUEUES`'s own doc comment), so BullMQ's
   * `removeOnComplete`/`removeOnFail` job options never fire for them; this
   * sweep is the only mechanism that can enforce the retention class
   * `dlqExpiresAt` stamps at enqueue time (`queue.constants.ts`). Runs on the
   * same interval as the depth poll — the DLQs are already low-volume/parked
   * data, so a shared cadence needs no separate timer or config key.
   *
   * A job parked BEFORE this fix shipped has no `expiresAt` at all — left
   * alone (its previously-unenforced retention persists), never retroactively
   * swept the moment this code deploys.
   */
  private async sweepExpiredDlqJobs(): Promise<void> {
    const now = Date.now();
    for (const dlq of DLQ_QUEUES) {
      try {
        const queue = this.queue.queue(dlq);
        const jobs = await queue.getJobs(
          ['waiting', 'delayed'],
          0,
          QueueMonitorService.DLQ_SWEEP_SCAN_CAP - 1,
          false,
        );
        let removed = 0;
        for (const job of jobs) {
          const expiresAt = (job.data as { expiresAt?: string } | undefined)?.expiresAt;
          if (!expiresAt) continue;
          if (new Date(expiresAt).getTime() <= now) {
            await job.remove().catch(() => undefined);
            removed += 1;
          }
        }
        if (removed > 0) {
          this.logger.log(`[${dlq}] expired ${removed} retention-window DLQ job(s)`);
        }
      } catch (err) {
        this.logger.error(
          `DLQ expiry sweep failed for ${dlq}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dlqTimer) clearInterval(this.dlqTimer);
    if (this.depthTimer) clearInterval(this.depthTimer);
    await Promise.all(this.events.map((e) => e.close().catch(() => undefined)));
  }
}
