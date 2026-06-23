import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { OutboxJob } from '../entities/Campaigns/OutboxJob';
import { OutboxStatus } from '../entities/enums';
import { QueueService } from '../queue/queue.service';
import { QueueName } from '../queue/queue.constants';

/**
 * Transactional-outbox RELAY (worker-only).
 *
 * Polls PENDING `outbox_jobs` rows (locked `FOR UPDATE SKIP LOCKED`, so many
 * worker replicas can relay concurrently without double-publishing) and pushes
 * each to BullMQ via QueueService, using the row's `dedupe_key` as the jobId so
 * the at-least-once publish is idempotent. On success the row is marked
 * PUBLISHED; on repeated failure it is parked as FAILED for inspection.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  private readonly intervalMs = Number(process.env.OUTBOX_POLL_MS ?? '1000');
  private readonly batchSize = Number(process.env.OUTBOX_BATCH ?? '100');
  private readonly maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? '10');

  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: QueueService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.logger.log(`Outbox relay started (every ${this.intervalMs}ms, batch ${this.batchSize})`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.drainBatch();
    } catch (err) {
      this.logger.error(`relay tick error: ${(err as Error)?.message}`);
    } finally {
      this.running = false;
    }
  }

  private async drainBatch(): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      const rows = await mgr
        .createQueryBuilder(OutboxJob, 'o')
        .where('o.status = :s', { s: OutboxStatus.PENDING })
        .orderBy('o.created_at', 'ASC')
        .limit(this.batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked') // FOR UPDATE SKIP LOCKED — safe across replicas
        .getMany();

      for (const row of rows) {
        try {
          await this.queue.publish(
            row.queue as QueueName,
            row.job_name,
            { ...(row.payload as Record<string, unknown>), tenantId: (row.payload as { tenantId?: string }).tenantId ?? null },
            row.dedupe_key,
          );
          row.status = OutboxStatus.PUBLISHED;
          row.published_at = new Date();
          row.last_error = null;
        } catch (err) {
          row.publish_attempts += 1;
          row.last_error = (err as Error)?.message ?? 'publish error';
          if (row.publish_attempts >= this.maxAttempts) {
            row.status = OutboxStatus.FAILED;
            this.logger.error(`outbox row ${row.id} permanently FAILED: ${row.last_error}`);
          }
        }
        await mgr.save(row);
      }
    });
  }
}
