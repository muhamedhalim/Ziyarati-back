import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';

import { ALL_QUEUES, QUEUE } from '../queue/queue.constants';
import { eventsConnectionOptions } from '../queue/redis.config';
import { QueueService } from '../queue/queue.service';

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
  private readonly logger = new Logger('QueueMonitor');
  private readonly events: QueueEvents[] = [];
  private dlqTimer?: NodeJS.Timeout;

  private readonly dlqPollMs = Number(process.env.DLQ_POLL_MS ?? '30000');
  private readonly dlqWarnAt = Number(process.env.DLQ_WARN_THRESHOLD ?? '100');
  private readonly logCompleted = process.env.QUEUE_LOG_COMPLETED === 'true';

  /**
   * All four dead-letter parks in the system (verified against
   * `queue.constants.ts` — the original audit overcounted this at "6").
   * Previously only two were polled; an exhausted `notifications.dispatch` or
   * `webhooks.deliver` job could accumulate in its DLQ with nothing surfacing it.
   */
  private static readonly ALL_DLQS = [
    QUEUE.NOTIFICATIONS_DLQ,
    QUEUE.WHATSAPP_DLQ,
    QUEUE.CAMPAIGNS_DLQ,
    QUEUE.WEBHOOKS_DLQ,
  ] as const;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    const connection = eventsConnectionOptions(this.config); // dedicated events profile
    for (const name of ALL_QUEUES) {
      const qe = new QueueEvents(name, { connection });
      if (this.logCompleted) {
        qe.on('completed', ({ jobId }) => this.logger.log(`[${name}] ✓ completed job=${jobId}`));
      }
      qe.on('failed', ({ jobId, failedReason }) =>
        this.logger.error(`[${name}] ✗ failed job=${jobId}: ${failedReason}`),
      );
      qe.on('stalled', ({ jobId }) => this.logger.warn(`[${name}] ⚠ stalled job=${jobId}`));
      qe.on('error', (err) => this.logger.error(`[${name}] queue-events error: ${err?.message}`));
      this.events.push(qe);
    }
    this.logger.log(
      `QueueEvents monitoring ${ALL_QUEUES.length} queues (completed-job logging ${this.logCompleted ? 'ON' : 'off'})`,
    );

    this.dlqTimer = setInterval(() => void this.reportDlqDepths(), this.dlqPollMs);
  }

  /** Polls every DLQ this worker parks jobs into (all four — see ALL_DLQS). */
  private async reportDlqDepths(): Promise<void> {
    for (const dlq of QueueMonitorService.ALL_DLQS) {
      try {
        const depth = await this.queue.dlqDepth(dlq);
        if (depth >= this.dlqWarnAt) {
          this.logger.error(`[${dlq}] depth=${depth} ≥ threshold ${this.dlqWarnAt} — ALERT`);
        } else if (depth > 0) {
          this.logger.warn(`[${dlq}] depth=${depth}`);
        }
      } catch (err) {
        this.logger.error(`DLQ depth poll failed for ${dlq}: ${(err as Error)?.message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dlqTimer) clearInterval(this.dlqTimer);
    await Promise.all(this.events.map((e) => e.close().catch(() => undefined)));
  }
}
