import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';

import { QUEUE, JOB, workerConcurrency } from '../../queue/queue.constants';
import {
  SubscriptionsRenewalCheckJob,
  SubscriptionsRenewalBillJob,
} from '../../queue/job-data.interface';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { RenewalService } from '../../modules/subscription-billing/renewal.service';
import { PendingPaymentExpiryService } from '../../modules/subscription-billing/pending-payment-expiry.service';
import { ScheduledPlanChangeService } from '../../modules/subscription-billing/scheduled-plan-change.service';
import { MetricsService } from '../../metrics/metrics.service';
import { SubscriptionLifecycleService } from '../../modules/subscription-billing/subscription-lifecycle.service';

const RENEWAL_WINDOW_DAYS = 3;
/** T082 (spec 014, US5) — shorter than the 24h gap between renewalBill's own
 *  cron ticks, generous for a full page's worth of charge attempts. */
const RENEWAL_BILL_LOCK_KEY = 'lock:subscriptions-renewal-bill';
const RENEWAL_BILL_LOCK_TTL_MS = 10 * 60 * 1000;
const PENDING_EXPIRY_LOCK_KEY = 'lock:subscriptions-pending-payment-expiry';
const PENDING_EXPIRY_LOCK_TTL_MS = 10 * 60 * 1000;
/**
 * Page size for the renewal-check sweep (L8 — docs/CACHING_QUEUES_AUDIT.md).
 * Bounds both the DB round-trip size and the peak resident set to one page's
 * worth of rows regardless of how many subscriptions are due at once.
 */
const RENEWAL_CHECK_PAGE_SIZE = 1000;

/**
 * Consumes the `subscriptions` queue (`subscriptions.renewalCheck`) — a global
 * scheduled sweep.
 *
 * FND-031: previously READ-ONLY (detection only — reported what was due, never
 * acted). Now ALSO performs the real grace state machine:
 *   ACTIVE/TRIAL --ends_at reached--> PAST_DUE (grace_started_at = now)
 *     --grace duration elapsed--> GRACE_EXPIRED (grace_expired_at = now)
 * Notifications fire at the three defined points (before expiry, at expiry,
 * before grace end) to both the tenant and platform operators; every
 * transition is audited via the FND-015/T016 seam. NO automatic re-billing
 * is performed anywhere in this file (FR-B007 — deliberately not built).
 *
 * The original due-count return shape (`{due, tenants}`) is preserved
 * unchanged for the existing renewal-window detection — the new behavior is
 * additive, run alongside it.
 */
@Processor(QUEUE.SUBSCRIPTIONS, { concurrency: workerConcurrency() })
export class SubscriptionsProcessor extends WorkerHost {
  private readonly logger = new Logger('SubscriptionsProcessor');

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly renewal: RenewalService,
    private readonly pendingExpiry: PendingPaymentExpiryService,
    private readonly lock: DistributedLockService,
    private readonly metrics: MetricsService,
    private readonly scheduledChanges: ScheduledPlanChangeService,
  ) {
    super();
  }

  /**
   * T082 (spec 014, US5) — this queue now carries two distinct jobs (T024
   * already registered `subscriptions.renewalBill` alongside the existing
   * `subscriptions.renewalCheck`); before this branch, an already-scheduled
   * `renewalBill` tick silently re-ran the grace-check sweep a second time
   * instead of billing anything.
   */
  async process(
    job: Job<SubscriptionsRenewalCheckJob | SubscriptionsRenewalBillJob>,
  ) {
    if (job.name === JOB.SUBSCRIPTIONS_RENEWAL_BILL) {
      return this.processRenewalBill();
    }
    if (job.name === JOB.SUBSCRIPTIONS_PENDING_PAYMENT_EXPIRY) {
      return this.processPendingPaymentExpiry();
    }
    return this.processRenewalCheck();
  }

  /**
   * Lock-guarded for the SAME reason `PaymentsProcessor` guards its own
   * sweep: correctness does not depend on it (`UQ_sub_invoice_period` plus
   * `BillingService.payInvoice`'s own charge-claim already make a
   * concurrent run a no-op, never a double charge) — this only avoids
   * wasted, duplicate provider calls if a stalled run and its replacement
   * ever overlap.
   */
  private async processRenewalBill() {
    const token = await this.lock.acquire(
      RENEWAL_BILL_LOCK_KEY,
      RENEWAL_BILL_LOCK_TTL_MS,
    );
    if (!token) {
      this.logger.log(
        'renewalBill sweep already in progress elsewhere — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const result = await this.renewal.processDueBills();
      this.metrics.setWorkerHeartbeat('subscriptions.renewalBill');
      return result;
    } finally {
      await this.lock.release(RENEWAL_BILL_LOCK_KEY, token);
    }
  }

  /** Lock-guarded like the bill run: the conditional updates already make an overlap harmless; this only avoids duplicate work. */
  private async processPendingPaymentExpiry() {
    const token = await this.lock.acquire(
      PENDING_EXPIRY_LOCK_KEY,
      PENDING_EXPIRY_LOCK_TTL_MS,
    );
    if (!token) {
      this.logger.log(
        'pendingPaymentExpiry sweep already in progress elsewhere — skipping this run',
      );
      return { skipped: true };
    }
    try {
      const result = await this.pendingExpiry.expireAbandoned();
      this.metrics.setWorkerHeartbeat('subscriptions.pendingPaymentExpiry');
      return result;
    } finally {
      await this.lock.release(PENDING_EXPIRY_LOCK_KEY, token);
    }
  }

  /**
   * Gap-closure (L8 — docs/CACHING_QUEUES_AUDIT.md): pages through in bounded
   * batches instead of one unbounded `find()`, and selects only the columns
   * actually used.
   */
  private async processRenewalCheck() {
    const cutoff = new Date(Date.now() + RENEWAL_WINDOW_DAYS * 86_400_000);
    const byTenant = new Map<string, number>();
    let total = 0;

    for (let offset = 0; ; offset += RENEWAL_CHECK_PAGE_SIZE) {
      const page = await this.subscriptions.find({
        where: {
          status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
          ends_at: LessThanOrEqual(cutoff),
          deleted_at: IsNull(),
        },
        select: { id: true, tenant: { id: true } },
        relations: { tenant: true },
        order: { id: 'ASC' },
        skip: offset,
        take: RENEWAL_CHECK_PAGE_SIZE,
      });
      if (page.length === 0) break;

      total += page.length;
      for (const s of page) {
        const t = s.tenant?.id ?? 'unknown';
        byTenant.set(t, (byTenant.get(t) ?? 0) + 1);
      }
      if (page.length < RENEWAL_CHECK_PAGE_SIZE) break;
    }

    this.logger.log(
      `renewalCheck: ${total} subscription(s) due within ${RENEWAL_WINDOW_DAYS}d across ${byTenant.size} tenant(s)`,
    );

    // A downgrade scheduled for the end of a term that will NOT renew lands at that
    // end, before the same tick moves the subscription to PAST_DUE. (Auto-renewing
    // subscriptions keep getting theirs from the renewal invoice.) Isolated: a
    // failure here must not stop the grace state machine below.
    const downgrades = await this.scheduledChanges
      .applyDueDowngrades()
      .catch((err) => {
        this.logger.error(
          `renewalCheck: scheduled downgrades failed: ${(err as Error)?.message}`,
        );
        return { applied: 0 };
      });

    const { expiringSoon, enteredGrace, graceEndingSoon, graceExpired } =
      await this.lifecycle.runSweeps();

    return {
      due: total,
      tenants: byTenant.size,
      expiringSoonWarned: expiringSoon,
      enteredGrace,
      graceEndingSoonWarned: graceEndingSoon,
      graceExpired,
      downgradesApplied: downgrades.applied,
    };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
