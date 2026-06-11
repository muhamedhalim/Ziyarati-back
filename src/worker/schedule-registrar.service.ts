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
      // Settlement batching sweep — 01:00 UTC.
      await this.queue.addRepeatable(QUEUE.SETTLEMENTS, JOB.SETTLEMENTS_PROCESS, { tenantId: null }, '0 1 * * *');
      // Subscription renewal/expiry check — 02:00 UTC.
      await this.queue.addRepeatable(QUEUE.SUBSCRIPTIONS, JOB.SUBSCRIPTIONS_RENEWAL_CHECK, { tenantId: null }, '0 2 * * *');
      this.logger.log('Repeatable jobs registered (analytics ×2, settlements, subscriptions)');
    } catch (err) {
      this.logger.error(`Could not register repeatable jobs (is Redis reachable?): ${(err as Error)?.message}`);
    }
  }
}
