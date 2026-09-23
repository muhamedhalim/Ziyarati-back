import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import {
  PlatformWaitlistEvaluateJob,
  PlatformFreeAccessNoticeJob,
} from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { MetricsService } from '../../metrics/metrics.service';
import { PlatformMaintenanceService } from '../../modules/platform/platform-maintenance.service';
import { AuthTokenMaintenanceService } from '../../modules/auth/auth-token-maintenance.service';
import { WaitlistService } from '../../modules/waitlist/waitlist.service';
import { WaitlistOfferService } from '../../modules/waitlist/waitlist-offer.service';
import { PatientQueueService } from '../../modules/patient-queue/patient-queue.service';
import { ReportExportService } from '../../modules/report-export/report-export.service';
import { BirthdayGreetingSweepService } from '../../modules/workflow/birthday-greeting.sweep.service';
import { FreeAccessNoticeService } from '../../modules/subscription-billing/free-access-notice.service';

/** See `NotificationsProcessor`'s identical reap lock — same reasoning, own key. */
const WAITLIST_EXPIRY_LOCK_KEY = 'lock:waitlist-expiry';
const WAITLIST_EXPIRY_LOCK_TTL_MS = 45_000;

/** Spec 014 (Clinic Platform Completion) — T174 (US10). Same reasoning, own key. */
const QUEUE_DAY_CLOSE_LOCK_KEY = 'lock:queue-day-close';
const QUEUE_DAY_CLOSE_LOCK_TTL_MS = 45_000;

/** Spec 014 (Clinic Platform Completion) — T183 (US13). Same reasoning, own key. */
const EXPORT_EXPIRY_LOCK_KEY = 'lock:export-expiry';
const EXPORT_EXPIRY_LOCK_TTL_MS = 45_000;

/**
 * Birthday greetings. Same reasoning, own key. Unlike the sweeps above this one
 * walks tenant by tenant and awaits every listener, so the lock is RENEWED
 * before each tenant (see `processBirthdayGreetings`) rather than trusted to
 * outlive the whole run — a duplicate concurrent sweep is what would otherwise
 * be able to race the once-per-occurrence guard.
 */
const BIRTHDAY_GREETINGS_LOCK_KEY = 'lock:birthday-greetings';
const BIRTHDAY_GREETINGS_LOCK_TTL_MS = 60_000;

/**
 * Consumes the `platform` queue — the retention sweeps:
 *  - `platform.logCleanup`        purges aged api_logs / webhook_logs;
 *  - `platform.authTokenCleanup`  purges expired refresh_tokens / password_resets
 *                                 (AUTH-005 — see AuthTokenMaintenanceService).
 *  - `platform.waitlistEvaluate`  matches one freed slot against waiting
 *                                 entries and issues offers (S9, T157/T158).
 *  - `platform.waitlistExpiry`    expires offers past `responds_by` and
 *                                 entries past their window (S9, T156/T158).
 *                                 Lock-guarded + heartbeat, mirroring
 *                                 `NotificationsProcessor`'s `reap` branch —
 *                                 see that processor's docblock and T160's
 *                                 own docblock in `WaitlistOfferService` for
 *                                 why: `DistributedLockService.acquire`
 *                                 returns `null` (never throws) on a Redis
 *                                 error, indistinguishable from ordinary
 *                                 contention, so a silently-stopped sweep and
 *                                 a healthy-but-idle one must stay tellable
 *                                 apart from the logs/metrics alone.
 *  - `platform.queueDayClose`     closes out unresolved queue entries at
 *                                 end of day (S10, T174). SAME lock-guarded
 *                                 + heartbeat shape as `waitlistExpiry`
 *                                 immediately above — see that branch's own
 *                                 docblock for the M5 Redis-failure
 *                                 reasoning, which applies identically here.
 *  - `platform.exportExpiry`      deletes the storage object THEN marks a
 *                                 due `export_jobs` row `EXPIRED` (S13,
 *                                 T183, FR-X010). SAME lock-guarded +
 *                                 heartbeat shape as the two sweeps above.
 *  - `platform.birthdayGreetings` hourly; emits `customer.birthday` for the
 *                                 patients whose birthday it is right now in
 *                                 their clinic's local time, which the
 *                                 workflow engine turns into greetings.
 *                                 Lock-guarded + heartbeat, like the sweeps
 *                                 above, with the lock renewed per tenant.
 *  - `platform.freeAccessNotice`  delivers one free-access lifecycle notice
 *                                 (in-app + email) — the start notice
 *                                 enqueued by `FreeAccessOverrideService.
 *                                 grant`, or an expiry warning enqueued by
 *                                 `FreeAccessNoticeService.sweepExpiring`.
 *                                 Not lock-guarded like the sweeps above: it
 *                                 is a per-event job, not a periodic one, and
 *                                 its own idempotency comes from the unique
 *                                 constraints `FreeAccessNoticeService.
 *                                 deliver` relies on.
 *
 * Branches on the job NAME. It previously ignored it entirely and always ran
 * the log purge, which was harmless while one job existed and would have
 * silently mis-run the wrong sweep the moment a second one was added.
 */
@Processor(QUEUE.PLATFORM, { concurrency: workerConcurrency() })
export class PlatformProcessor extends WorkerHost {
  private readonly logger = new Logger('PlatformProcessor');

  constructor(
    private readonly maintenance: PlatformMaintenanceService,
    private readonly authTokens: AuthTokenMaintenanceService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
    private readonly lock: DistributedLockService,
    private readonly metrics: MetricsService,
    private readonly waitlistEntries: WaitlistService,
    private readonly waitlistOffers: WaitlistOfferService,
    private readonly patientQueue: PatientQueueService,
    private readonly reportExport: ReportExportService,
    private readonly birthdayGreetings: BirthdayGreetingSweepService,
    private readonly freeAccessNotice: FreeAccessNoticeService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case JOB.PLATFORM_AUTH_TOKEN_CLEANUP:
        return this.authTokens.purgeExpiredTokens();
      case JOB.PLATFORM_WAITLIST_EVALUATE:
        return this.processWaitlistEvaluate(job);
      case JOB.PLATFORM_WAITLIST_EXPIRY:
        return this.processWaitlistExpiry();
      case JOB.PLATFORM_QUEUE_DAY_CLOSE:
        return this.processQueueDayClose();
      case JOB.PLATFORM_EXPORT_EXPIRY:
        return this.processExportExpiry();
      case JOB.PLATFORM_BIRTHDAY_GREETINGS:
        return this.processBirthdayGreetings();
      case JOB.PLATFORM_FREE_ACCESS_NOTICE:
        return this.processFreeAccessNotice(job);
      case JOB.PLATFORM_LOG_CLEANUP:
      default:
        // Default preserves the pre-existing behaviour for any job enqueued
        // onto this queue without a recognised name.
        return this.maintenance.purgeOldLogs();
    }
  }

  /**
   * SYSTEM tier, no per-invocation tenant identity in the payload (see
   * `PlatformFreeAccessNoticeJob`'s own docblock) — `FreeAccessNoticeService.
   * deliver()` re-reads the override/tenant fresh from the database itself,
   * so there is no `runInTenantContext`/`validateJobPayload` wrapper here,
   * matching every other SYSTEM-tier branch in this processor (e.g.
   * `PLATFORM_AUTH_TOKEN_CLEANUP` above). A thrown error here (a failed
   * in-app emit) propagates to BullMQ's ordinary attempts/backoff.
   */
  private processFreeAccessNotice(job: Job) {
    const data = job.data as PlatformFreeAccessNoticeJob;
    return this.freeAccessNotice.deliver({
      overrideId: data.overrideId,
      kind: data.kind,
      endsAt: data.endsAt,
    });
  }

  private processWaitlistEvaluate(job: Job) {
    const data = job.data as PlatformWaitlistEvaluateJob;
    validateJobPayload(job.name, data);
    return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
      this.waitlistOffers.evaluateFreedSlot(
        data.tenantId,
        data.appointmentId,
        data.freedStartAt &&
          data.freedEndAt &&
          data.freedBranchId &&
          data.freedStaffId
          ? {
              startAt: new Date(data.freedStartAt),
              endAt: new Date(data.freedEndAt),
              branchId: data.freedBranchId,
              staffId: data.freedStaffId,
            }
          : undefined,
      ),
    );
  }

  /**
   * M5 (Redis-failure behaviour) — a lock-unavailable run logs a VISIBLE
   * skip line and returns WITHOUT calling `metrics.setWorkerHeartbeat`, so
   * "sweep is healthy but nothing to do" (heartbeat advances every tick,
   * even a no-op one — see the COMPLETED branch below) stays observably
   * different from "sweep silently stopped running" (heartbeat stalls).
   */
  private async processWaitlistExpiry() {
    const lockToken = await this.lock.acquire(
      WAITLIST_EXPIRY_LOCK_KEY,
      WAITLIST_EXPIRY_LOCK_TTL_MS,
    );
    if (!lockToken) {
      this.logger.log(
        'waitlist expiry sweep already in progress elsewhere (or the lock is unavailable) — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const expiredOffers = await this.waitlistOffers.expireDueOffers();
      const expiredEntries = await this.waitlistEntries.expireDueEntries();
      this.logger.log(
        `waitlist expiry: expiredOffers=${expiredOffers} expiredEntries=${expiredEntries}`,
      );
      // COMPLETED run — always heartbeats, even when both counts are zero
      // (a healthy, idle sweep), so a stalled heartbeat can only mean the
      // sweep itself stopped running, never "there was nothing to expire".
      this.metrics.setWorkerHeartbeat('platform.waitlistExpiry');
      return { expiredOffers, expiredEntries };
    } finally {
      await this.lock.release(WAITLIST_EXPIRY_LOCK_KEY, lockToken);
    }
  }

  /**
   * FR-Q016/T174 — same M5 shape as `processWaitlistExpiry` immediately
   * above: a lock-unavailable run logs a VISIBLE skip line and returns
   * WITHOUT heartbeating; a COMPLETED run (even a no-op, zero-closed one)
   * always heartbeats, so a stalled heartbeat can only mean the sweep
   * itself stopped running.
   */
  private async processQueueDayClose() {
    const lockToken = await this.lock.acquire(
      QUEUE_DAY_CLOSE_LOCK_KEY,
      QUEUE_DAY_CLOSE_LOCK_TTL_MS,
    );
    if (!lockToken) {
      this.logger.log(
        'queue day-close sweep already in progress elsewhere (or the lock is unavailable) — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const { closed } = await this.patientQueue.closeUnresolvedEntries();
      this.logger.log(`queue day-close: closed=${closed}`);
      this.metrics.setWorkerHeartbeat('platform.queueDayClose');
      return { closed };
    } finally {
      await this.lock.release(QUEUE_DAY_CLOSE_LOCK_KEY, lockToken);
    }
  }

  /**
   * FR-X010/T183 — same M5 shape as the two sweeps above: a lock-unavailable
   * run logs a VISIBLE skip line and returns WITHOUT heartbeating; a
   * COMPLETED run (even a no-op, zero-expired one) always heartbeats, so a
   * stalled heartbeat can only mean the sweep itself stopped running — a
   * prolonged outage here would otherwise leave export files past their
   * retention window with no visible signal (FR-X010's own failure mode).
   */
  private async processExportExpiry() {
    const lockToken = await this.lock.acquire(
      EXPORT_EXPIRY_LOCK_KEY,
      EXPORT_EXPIRY_LOCK_TTL_MS,
    );
    if (!lockToken) {
      this.logger.log(
        'export expiry sweep already in progress elsewhere (or the lock is unavailable) — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const { expired } = await this.reportExport.expireDueExports();
      this.logger.log(`export expiry: expired=${expired}`);
      this.metrics.setWorkerHeartbeat('platform.exportExpiry');
      return { expired };
    } finally {
      await this.lock.release(EXPORT_EXPIRY_LOCK_KEY, lockToken);
    }
  }

  /**
   * Same M5 shape as the sweeps above: a lock-unavailable run logs a VISIBLE
   * skip line and returns WITHOUT heartbeating; a COMPLETED run — even one
   * where no clinic was in its greeting hour — always heartbeats, so a stalled
   * heartbeat can only mean the sweep itself stopped running.
   */
  private async processBirthdayGreetings() {
    const lockToken = await this.lock.acquire(
      BIRTHDAY_GREETINGS_LOCK_KEY,
      BIRTHDAY_GREETINGS_LOCK_TTL_MS,
    );
    if (!lockToken) {
      this.logger.log(
        'birthday greetings sweep already in progress elsewhere (or the lock is unavailable) — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const result = await this.birthdayGreetings.sweep(new Date(), {
        keepAlive: () =>
          this.lock.renew(
            BIRTHDAY_GREETINGS_LOCK_KEY,
            lockToken,
            BIRTHDAY_GREETINGS_LOCK_TTL_MS,
          ),
      });
      this.logger.log(
        `birthday greetings: tenants=${result.tenants} processed=${result.processed} emitted=${result.emitted}`,
      );
      this.metrics.setWorkerHeartbeat('platform.birthdayGreetings');
      return result;
    } finally {
      await this.lock.release(BIRTHDAY_GREETINGS_LOCK_KEY, lockToken);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED: ${err?.message}`);
  }
}
