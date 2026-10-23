import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JOB, QUEUE } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import {
  AnalyticsGenerateReportJob,
  PaymentsProviderReconcileJob,
} from '../queue/job-data.interface';

/**
 * Registers the platform's REPEATABLE (cron) jobs on worker startup, using
 * BullMQ's native repeatable jobs — no separate scheduling framework. Each is a
 * global sweep (tenantId null) whose processor fans out per-tenant work.
 * Registration is idempotent (BullMQ dedups by repeat key), so running multiple
 * worker replicas does not create duplicate schedules. A transient Redis outage at boot
 * doesn't crash the worker - and (CR-29) doesn't leave it without schedules either: a failed
 * registration is retried with backoff until it succeeds. Because registration is idempotent a
 * retry that re-registers jobs the first attempt already added is harmless.
 */
@Injectable()
export class ScheduleRegistrarService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('ScheduleRegistrar');
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly queue: QueueService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!(await this.tryRegister())) this.scheduleRetry(1);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** 5 s, 10 s, 20 s, 40 s, then every 60 s - for as long as Redis stays unreachable. */
  private scheduleRetry(attempt: number): void {
    if (this.stopped) return;
    const delayMs = Math.min(5_000 * 2 ** (attempt - 1), 60_000);
    this.retryTimer = setTimeout(() => {
      void (async () => {
        if (this.stopped) return;
        if (!(await this.tryRegister())) this.scheduleRetry(attempt + 1);
        else this.logger.log(`Repeatable jobs registered after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
      })();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private async tryRegister(): Promise<boolean> {
    try {
      await this.registerAll();
      return true;
    } catch (err) {
      this.logger.error(`Could not register repeatable jobs (is Redis reachable?) - will retry: ${(err as Error)?.message}`);
      return false;
    }
  }

  private async registerAll(): Promise<void> {
    {
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
      // Spec 014 (Clinic Platform Completion) S5 — recurring billing sweep,
      // bills subscriptions due for renewal. 02:15 UTC, offset 15 minutes
      // after the renewal/expiry check above so the two never contend for
      // the same instant on the shared `subscriptions` queue.
      await this.queue.addRepeatable(QUEUE.SUBSCRIPTIONS, JOB.SUBSCRIPTIONS_RENEWAL_BILL, { tenantId: null }, '15 2 * * *');
      // Cancels subscriptions that never got paid (PENDING_PAYMENT past its TTL). 02:30 UTC,
      // after the renewal check (02:00) and bill (02:15) on the same queue.
      await this.queue.addRepeatable(QUEUE.SUBSCRIPTIONS, JOB.SUBSCRIPTIONS_PENDING_PAYMENT_EXPIRY, { tenantId: null }, '30 2 * * *');
      // Refund recovery / reaper sweep — every 5 minutes (R2).
      await this.queue.addRepeatable(QUEUE.REFUNDS, JOB.REFUNDS_REAP, { tenantId: null }, '*/5 * * * *');
      // Payment reconciliation sweep — every 10 minutes (webhook-loss recovery).
      await this.queue.addRepeatable(QUEUE.PAYMENTS, JOB.PAYMENTS_RECONCILE, { tenantId: null }, '*/10 * * * *');
      // Provider reconciliation (Tap Phase 5): fees, payouts, discrepancies, from the
      // gateway's own reports. Daily over a 3-day look-back (a late charge or payout is
      // still caught) at 03:00 UTC, and weekly over Tap's whole 30-day window. Does
      // nothing unless PAYMENT_PROVIDER=tap with a key. Read-only toward Tap.
      await this.queue.addRepeatable(QUEUE.PAYMENTS, JOB.PAYMENTS_PROVIDER_RECONCILE, { tenantId: null, lookbackDays: 3 } as PaymentsProviderReconcileJob, '0 3 * * *');
      await this.queue.addRepeatable(QUEUE.PAYMENTS, JOB.PAYMENTS_PROVIDER_RECONCILE, { tenantId: null, lookbackDays: 30 } as PaymentsProviderReconcileJob, '0 4 * * 0');
      // Notification durability sweep — every minute (reclaim stale PROCESSING +
      // re-enqueue due-but-unsent rows). Idempotent via deterministic jobId.
      await this.queue.addRepeatable(QUEUE.NOTIFICATIONS, JOB.NOTIFICATIONS_REAP, { tenantId: null }, '* * * * *');
      // Platform log retention purge — 03:30 UTC daily.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_LOG_CLEANUP, { tenantId: null }, '30 3 * * *');
      // AUTH-005: expired refresh_tokens / password_resets retention purge —
      // 03:45 UTC daily, offset 15 minutes after the log purge above so the two
      // sweeps on this same queue never contend for the same instant.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_AUTH_TOKEN_CLEANUP, { tenantId: null }, '45 3 * * *');
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
      // Integration retention purge — 03:50 UTC daily, offset 5 minutes after
      // the auth-token purge (03:45) and clear of the other daily sweeps.
      // Bounds integration_idempotency_keys / integration_inbound_events /
      // integration_oauth_states, which previously grew without limit (their
      // purge methods existed but nothing scheduled them). Lock-guarded in
      // IntegrationRecoveryProcessor.
      await this.queue.addRepeatable(QUEUE.INTEGRATION_MAINTENANCE, JOB.INTEGRATION_PURGE_EXPIRED, { tenantId: null }, '50 3 * * *');
      // Campaign dead-letter recovery sweep (FND-020) — every 5 minutes.
      // Lock-guarded in CampaignDlqRecoveryProcessor, mirrors the integration
      // recovery sweep above exactly. A dead-lettered recipient whose DLQ
      // write failed sits for at most DLQ_RECOVERY_GRACE_MS (60s) before the
      // NEXT tick picks it up.
      await this.queue.addRepeatable(QUEUE.CAMPAIGNS_MAINTENANCE, JOB.CAMPAIGNS_RECOVER_DLQ, { tenantId: null }, '*/5 * * * *');

      // Spec 014 (Clinic Platform Completion) — S9. Expires waitlist offers
      // past their deadline — every 5 minutes, mirroring the other short-
      // interval recovery sweeps above.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_WAITLIST_EXPIRY, { tenantId: null }, '*/5 * * * *');
      // S10 — closes out the day's patient queue. 23:50 UTC, before midnight
      // so a day's queue is settled before the NEXT day's work begins.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_QUEUE_DAY_CLOSE, { tenantId: null }, '50 23 * * *');
      // S13 — expires stale report-export downloads. 04:45 UTC, offset after
      // AI_TOOL_CALL_RETENTION (04:30) so the two `platform`/`ai`-queue daily
      // sweeps around that hour don't contend.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_EXPORT_EXPIRY, { tenantId: null }, '45 4 * * *');
      // Birthday greetings — hourly at :10 (off the :00/:05 hourly ticks of the
      // analytics/usage-report sweeps). Hourly rather than daily because each
      // clinic is greeted at ITS OWN local 09:00; the sweep no-ops for every
      // tenant not currently in that hour.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_BIRTHDAY_GREETINGS, { tenantId: null }, '10 * * * *');
      // Free-access expiry-warning sweep (plan §7) — hourly at :20, offset
      // from birthday-greetings (:10) and the analytics/usage-report hourly
      // ticks (:00/:05) so none of the platform-queue sweeps contend for the
      // same instant.
      await this.queue.addRepeatable(QUEUE.PLATFORM, JOB.PLATFORM_FREE_ACCESS_EXPIRY_SWEEP, { tenantId: null }, '20 * * * *');

      this.logger.log('Repeatable jobs registered (analytics ×4, settlements, subscriptions ×2, refunds-reaper, notifications-reaper, platform-log-cleanup, usage-report-tick, ai-batch-poll, integration-recover-stale, integration-purge-expired, campaigns-recover-dlq, waitlist-expiry, queue-day-close, export-expiry, birthday-greetings, free-access-expiry-sweep)');
    }
  }
}
