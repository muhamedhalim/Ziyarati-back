import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Between, In, IsNull, LessThanOrEqual, Repository } from 'typeorm';

import { QUEUE, JOB, workerConcurrency } from '../../queue/queue.constants';
import {
  SubscriptionsRenewalCheckJob,
  SubscriptionsRenewalBillJob,
} from '../../queue/job-data.interface';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { User } from '../../entities/Auth&RBAC/User';
import { SubscriptionStatus } from '../../entities/enums';
import { EmailService } from '../../modules/email/email.service';
import { RenewalService } from '../../modules/subscription-billing/renewal.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../../modules/platform/platform-admin-audit.service';

const RENEWAL_WINDOW_DAYS = 3;
/** T082 (spec 014, US5) — shorter than the 24h gap between renewalBill's own
 *  cron ticks, generous for a full page's worth of charge attempts. */
const RENEWAL_BILL_LOCK_KEY = 'lock:subscriptions-renewal-bill';
const RENEWAL_BILL_LOCK_TTL_MS = 10 * 60 * 1000;
/** How far ahead of a boundary (expiry, or grace end) the "before" warning fires. */
const WARNING_WINDOW_DAYS = 3;
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
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly email: EmailService,
    private readonly audit: PlatformAdminAuditService,
    private readonly config: ConfigService,
    private readonly renewal: RenewalService,
    private readonly lock: DistributedLockService,
    private readonly metrics: MetricsService,
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

    const [expiringSoon, enteredGrace, graceEndingSoon, graceExpired] =
      await Promise.all([
        this.warnExpiringSoon(),
        this.transitionToGrace(),
        this.warnGraceEndingSoon(),
        this.transitionGraceExpired(),
      ]);

    return {
      due: total,
      tenants: byTenant.size,
      expiringSoonWarned: expiringSoon,
      enteredGrace,
      graceEndingSoonWarned: graceEndingSoon,
      graceExpired,
    };
  }

  private graceDurationDays(): number {
    return this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
  }

  // ── Point 1: "before expiry" — still ACTIVE/TRIAL, ends_at approaching ──

  private async warnExpiringSoon(): Promise<number> {
    const now = new Date();
    const windowEnd = new Date(
      now.getTime() + WARNING_WINDOW_DAYS * 86_400_000,
    );
    const due = await this.subscriptions.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
        ends_at: Between(now, windowEnd),
        deleted_at: IsNull(),
      },
      relations: { tenant: true, plan: true },
    });
    for (const s of due) {
      await this.notify(s, 'expiring_soon', {
        endsAt: s.ends_at.toISOString(),
        planName: s.plan?.name,
        // Idempotency key includes ends_at: stable across every sweep run
        // within the warning window (dedupes re-sends), but distinct per
        // billing cycle (a renewal gets a NEW ends_at, so a future cycle's
        // warning still fires).
        idempotencyKey: `subscription:${s.id}:expiring-soon:${s.ends_at.toISOString()}`,
      });
    }
    return due.length;
  }

  // ── Point 2: "at expiry" — the real ACTIVE/TRIAL -> PAST_DUE transition ──

  private async transitionToGrace(): Promise<number> {
    const now = new Date();
    const due = await this.subscriptions.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
        ends_at: LessThanOrEqual(now),
        deleted_at: IsNull(),
      },
      relations: { tenant: true, plan: true },
    });
    for (const s of due) {
      s.status = SubscriptionStatus.PAST_DUE;
      s.grace_started_at = now;
      await this.subscriptions.save(s);

      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_ENTERED_GRACE,
        userId: undefined, // system-initiated — no HTTP caller
        entityType: 'subscription',
        entityId: s.id,
        tenantId: s.tenant?.id,
        before: { status: 'ACTIVE_OR_TRIAL' },
        after: {
          status: SubscriptionStatus.PAST_DUE,
          grace_started_at: now.toISOString(),
        },
      });

      const graceEndsAt = new Date(
        now.getTime() + this.graceDurationDays() * 86_400_000,
      );
      await this.notify(s, 'entered_grace', {
        endsAt: s.ends_at.toISOString(),
        graceEndsAt: graceEndsAt.toISOString(),
        planName: s.plan?.name,
        idempotencyKey: `subscription:${s.id}:entered-grace:${now.toISOString()}`,
      });
    }
    return due.length;
  }

  // ── Point 3: "before grace end" — still PAST_DUE, grace window approaching ──

  private async warnGraceEndingSoon(): Promise<number> {
    const now = new Date();
    const graceDays = this.graceDurationDays();
    // grace_started_at + graceDays is between now and now+WARNING_WINDOW_DAYS
    // <=> grace_started_at is between (now - graceDays) and (now + WARNING_WINDOW_DAYS - graceDays)
    const windowStart = new Date(now.getTime() - graceDays * 86_400_000);
    const windowEnd = new Date(
      now.getTime() + (WARNING_WINDOW_DAYS - graceDays) * 86_400_000,
    );
    const due = await this.subscriptions.find({
      where: {
        status: SubscriptionStatus.PAST_DUE,
        grace_started_at: Between(windowStart, windowEnd),
        deleted_at: IsNull(),
      },
      relations: { tenant: true },
    });
    for (const s of due) {
      const graceEndsAt = new Date(
        s.grace_started_at!.getTime() + graceDays * 86_400_000,
      );
      await this.notify(s, 'grace_ending_soon', {
        graceEndsAt: graceEndsAt.toISOString(),
        idempotencyKey: `subscription:${s.id}:grace-ending-soon:${s.grace_started_at!.toISOString()}`,
      });
    }
    return due.length;
  }

  // ── The PAST_DUE -> GRACE_EXPIRED transition (no separate notification — ──
  // ── the "before grace end" warning above already covers this boundary) ──

  private async transitionGraceExpired(): Promise<number> {
    const now = new Date();
    const graceDays = this.graceDurationDays();
    // A PAST_DUE row whose grace_started_at + graceDays <= now.
    const cutoff = new Date(now.getTime() - graceDays * 86_400_000);
    const due = await this.subscriptions.find({
      where: {
        status: SubscriptionStatus.PAST_DUE,
        grace_started_at: LessThanOrEqual(cutoff),
        deleted_at: IsNull(),
      },
      relations: { tenant: true },
    });
    for (const s of due) {
      s.status = SubscriptionStatus.GRACE_EXPIRED;
      s.grace_expired_at = now;
      await this.subscriptions.save(s);

      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_GRACE_EXPIRED,
        userId: undefined,
        entityType: 'subscription',
        entityId: s.id,
        tenantId: s.tenant?.id,
        before: { status: SubscriptionStatus.PAST_DUE },
        after: {
          status: SubscriptionStatus.GRACE_EXPIRED,
          grace_expired_at: now.toISOString(),
        },
      });
    }
    return due.length;
  }

  // ── Shared: notify BOTH the tenant and platform operators (FR-B007e) ──

  private async notify(
    subscription: Subscription,
    event: 'expiring_soon' | 'entered_grace' | 'grace_ending_soon',
    variables: { idempotencyKey: string } & Record<string, unknown>,
  ): Promise<void> {
    // FR-H014/T156 gap-closure: map recipient -> locale (not just a flat
    // Set<string>) so each recipient's own preference (M-08) reaches the
    // email. `tenant.contact_email` has no linked User row, so it has no
    // locale signal available and falls back to EMAIL_DEFAULT_LOCALE — that
    // is unchanged, pre-existing behavior, not a new gap.
    const recipients = new Map<string, string | undefined>();
    if (subscription.tenant?.contact_email) {
      recipients.set(subscription.tenant.contact_email, undefined);
    }
    const operators = await this.users
      .createQueryBuilder('u')
      .innerJoin('user_roles', 'ur', 'ur."userId" = u.id')
      .innerJoin(
        'roles',
        'r',
        'r.id = ur."roleId" AND r.slug = :slug AND r."tenantId" IS NULL',
        {
          slug: 'super_admin',
        },
      )
      .where('u.is_active = true')
      .select('u.email', 'email')
      .addSelect('u.preferred_locale', 'preferredLocale')
      .getRawMany<{ email: string; preferredLocale: string | null }>();
    for (const o of operators)
      recipients.set(o.email, o.preferredLocale ?? undefined);

    for (const [to, locale] of recipients) {
      this.email.sendSubscriptionNotification({
        to,
        event,
        tenantId: subscription.tenant?.id,
        locale,
        ...variables,
        // Recipient-scoped — the SAME logical event must still dedupe
        // per-recipient, not just per-subscription (two different people
        // must each get their own copy, but never a duplicate of their own).
        idempotencyKey: `${variables.idempotencyKey}:${to}`,
      });
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
