import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';

import { ALL_QUEUES, QUEUE } from '../queue/queue.constants';
import { eventsConnectionOptions } from '../queue/redis.config';
import { QueueService } from '../queue/queue.service';

/**
 * Centralized queue observability via BullMQ QueueEvents. One listener per queue
 * logs completed / failed / stalled jobs (correlation ids are emitted by the
 * processors themselves on each attempt). Also polls the DLQ depth on an
 * interval and warns above a threshold — the hook point for alerting. Runs only
 * in the worker process; its connections are closed on shutdown.
 */
@Injectable()
export class QueueMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QueueMonitor');
  private readonly events: QueueEvents[] = [];
  private dlqTimer?: NodeJS.Timeout;

  private readonly dlqPollMs = Number(process.env.DLQ_POLL_MS ?? '30000');
  private readonly dlqWarnAt = Number(process.env.DLQ_WARN_THRESHOLD ?? '100');

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    const connection = eventsConnectionOptions(this.config); // dedicated events profile
    for (const name of ALL_QUEUES) {
      const qe = new QueueEvents(name, { connection });
      qe.on('completed', ({ jobId }) => this.logger.log(`[${name}] ✓ completed job=${jobId}`));
      qe.on('failed', ({ jobId, failedReason }) =>
        this.logger.error(`[${name}] ✗ failed job=${jobId}: ${failedReason}`),
      );
      qe.on('stalled', ({ jobId }) => this.logger.warn(`[${name}] ⚠ stalled job=${jobId}`));
      qe.on('error', (err) => this.logger.error(`[${name}] queue-events error: ${err?.message}`));
      this.events.push(qe);
    }
    this.logger.log(`QueueEvents monitoring ${ALL_QUEUES.length} queues`);

    this.dlqTimer = setInterval(() => void this.reportDlqDepths(), this.dlqPollMs);
  }

  /**
   * Polls every DLQ this worker parks jobs into. Previously only
   * `campaigns.dlq` was watched, so an exhausted `whatsapp-webhook`/
   * `whatsapp-media` job (see WhatsappWebhookProcessor/WhatsappMediaProcessor)
   * could accumulate there with nothing ever surfacing it above a per-job
   * `failed` log line.
   */
  private async reportDlqDepths(): Promise<void> {
    for (const dlq of [QUEUE.CAMPAIGNS_DLQ, QUEUE.WHATSAPP_DLQ] as const) {
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
