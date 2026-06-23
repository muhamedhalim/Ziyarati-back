import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { JOB, QUEUE } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

/**
 * Registers the platform's REPEATABLE (cron) jobs on worker startup, using
 * BullMQ's native repeatable jobs — no separate scheduling framework. Each is a
 * global sweep (tenantId null) whose processor fans out per-tenant work.
 * Registration is idempotent (BullMQ dedups by repeat key), so running multiple
 * worker replicas does not create duplicate schedules. Wrapped in try/catch so a
 * transient Redis outage at boot doesn't crash the worker.
 */
@Injectable()
export class ScheduleRegistrarService implements OnApplicationBootstrap {
  private readonly logger = new Logger('ScheduleRegistrar');

  constructor(private readonly queue: QueueService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      // Daily report generation sweep — 00:30 UTC.
      await this.queue.addRepeatable(QUEUE.ANALYTICS, JOB.ANALYTICS_GENERATE_REPORT, { tenantId: null }, '30 0 * * *');
      // Dashboard metric aggregation sweep — hourly.
      await this.queue.addRepeatable(QUEUE.ANALYTICS, JOB.ANALYTICS_AGGREGATE, { tenantId: null }, '0 * * * *');
      // Analytics event retention purge — 03:15 UTC daily.
      await this.queue.addRepeatable(QUEUE.ANALYTICS, JOB.ANALYTICS_CLEANUP, { tenantId: null }, '15 3 * * *');
      // Settlement batching sweep — 01:00 UTC.
      await this.queue.addRepeatable(QUEUE.SETTLEMENTS, JOB.SETTLEMENTS_PROCESS, { tenantId: null }, '0 1 * * *');
      // Subscription renewal/expiry check — 02:00 UTC.
      await this.queue.addRepeatable(QUEUE.SUBSCRIPTIONS, JOB.SUBSCRIPTIONS_RENEWAL_CHECK, { tenantId: null }, '0 2 * * *');
      // Refund recovery / reaper sweep — every 5 minutes (R2).
      await this.queue.addRepeatable(QUEUE.REFUNDS, JOB.REFUNDS_REAP, { tenantId: null }, '*/5 * * * *');
      // Notification durability sweep — every minute (reclaim stale PROCESSING +
      // re-enqueue due-but-unsent rows). Idempotent via deterministic jobId.
      await this.queue.addRepeatable(QUEUE.NOTIFICATIONS, JOB.NOTIFICATIONS_REAP, { tenantId: null }, '* * * * *');
      // Platform log retention purge — 03:30 UTC daily.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_LOG_CLEANUP, { tenantId: null }, '30 3 * * *');
      this.logger.log('Repeatable jobs registered (analytics ×3, settlements, subscriptions, refunds-reaper, notifications-reaper, platform-log-cleanup)');
    } catch (err) {
      this.logger.error(`Could not register repeatable jobs (is Redis reachable?): ${(err as Error)?.message}`);
    }
  }
}
