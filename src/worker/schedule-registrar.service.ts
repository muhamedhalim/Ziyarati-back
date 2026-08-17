import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JOB, QUEUE } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { AnalyticsGenerateReportJob } from '../queue/job-data.interface';

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

  constructor(
    private readonly queue: QueueService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      // Daily report generation sweep — 00:30 UTC.
      await this.queue.addRepeatable(QUEUE.ANALYTICS, JOB.ANALYTICS_GENERATE_REPORT, { tenantId: null }, '30 0 * * *');
      // Monthly report generation sweep (FND-014 — previously manual-only) —
      // 00:35 UTC on the 1st of each month: offset 5 minutes after the daily
      // tick above so the two sweeps don't contend for the same instant, and
      // scheduled for the 1st so it reports on the month that just completed.
      const monthlyReportTick: AnalyticsGenerateReportJob = { tenantId: null, kind: 'monthly' };
      await this.queue.addRepeatable(QUEUE.ANALYTICS, JOB.ANALYTICS_GENERATE_REPORT, monthlyReportTick, '35 0 1 * *');
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
      // Payment reconciliation sweep — every 10 minutes (webhook-loss recovery).
      await this.queue.addRepeatable(QUEUE.PAYMENTS, JOB.PAYMENTS_RECONCILE, { tenantId: null }, '*/10 * * * *');
      // Notification durability sweep — every minute (reclaim stale PROCESSING +
      // re-enqueue due-but-unsent rows). Idempotent via deterministic jobId.
      await this.queue.addRepeatable(QUEUE.NOTIFICATIONS, JOB.NOTIFICATIONS_REAP, { tenantId: null }, '* * * * *');
      // Platform log retention purge — 03:30 UTC daily.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_LOG_CLEANUP, { tenantId: null }, '30 3 * * *');
      // Scheduled usage-report tick — hourly (runs schedules that are due).
      await this.queue.addRepeatable(QUEUE.USAGE_REPORT, JOB.USAGE_REPORT_TICK, { tenantId: null }, '5 * * * *');
      // Long-term AI memory expiry purge — 04:00 UTC daily.
      await this.queue.addRepeatable(QUEUE.AI, JOB.AI_MEMORY_CLEANUP, { tenantId: null }, '0 4 * * *');
      // AI-008 (FR-029c): attempt-only ai_tool_calls retention purge — 04:30
      // UTC daily, offset from AI_MEMORY_CLEANUP (04:00) and
      // ANALYTICS_CLEANUP (03:15) so the three sweeps do not contend.
      await this.queue.addRepeatable(QUEUE.AI, JOB.AI_TOOL_CALL_RETENTION, { tenantId: null }, '30 4 * * *');
      // AI batch poll sweep — polls live OpenAI batches and processes terminal
      // ones. Cheap no-op when batch is unconfigured. Cadence is env-tunable.
      await this.queue.addRepeatable(
        QUEUE.AI,
        JOB.AI_BATCH_POLL,
        { tenantId: null },
        this.config.get<string>('AI_BATCH_POLL_CRON', '*/5 * * * *'),
      );
      // Integration import/sync/inbound recovery sweep — every 2 minutes
      // (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.8). Lock-
      // guarded in IntegrationRecoveryProcessor so a stalled-job redelivery
      // can't run the sweep twice concurrently.
      await this.queue.addRepeatable(QUEUE.INTEGRATION_MAINTENANCE, JOB.INTEGRATION_RECOVER_STALE, { tenantId: null }, '*/2 * * * *');
      // Campaign dead-letter recovery sweep (FND-020) — every 5 minutes.
      // Lock-guarded in CampaignDlqRecoveryProcessor, mirrors the integration
      // recovery sweep above exactly. A dead-lettered recipient whose DLQ
      // write failed sits for at most DLQ_RECOVERY_GRACE_MS (60s) before the
      // NEXT tick picks it up.
      await this.queue.addRepeatable(QUEUE.CAMPAIGNS_MAINTENANCE, JOB.CAMPAIGNS_RECOVER_DLQ, { tenantId: null }, '*/5 * * * *');
      this.logger.log('Repeatable jobs registered (analytics ×4, settlements, subscriptions, refunds-reaper, notifications-reaper, platform-log-cleanup, usage-report-tick, ai-batch-poll, integration-recover-stale, campaigns-recover-dlq)');
    } catch (err) {
      this.logger.error(`Could not register repeatable jobs (is Redis reachable?): ${(err as Error)?.message}`);
    }
  }
}
