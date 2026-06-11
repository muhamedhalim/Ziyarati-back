import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';

import { ALL_QUEUES } from '../queue/queue.constants';
import { redisConnectionOptions } from '../queue/redis.config';

/**
 * Centralized queue monitoring via BullMQ QueueEvents. One listener per queue
 * logs completed / failed / stalled jobs (correlation ids are emitted by the
 * processors themselves on each attempt). Runs only in the worker process. Its
 * connections are closed on shutdown.
 */
@Injectable()
export class QueueMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QueueMonitor');
  private readonly events: QueueEvents[] = [];

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const connection = redisConnectionOptions(this.config);
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
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.events.map((e) => e.close().catch(() => undefined)));
  }
}
