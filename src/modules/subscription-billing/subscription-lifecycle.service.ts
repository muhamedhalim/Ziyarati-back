import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, LessThanOrEqual, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { User } from '../../entities/Auth&RBAC/User';
import { SubscriptionStatus } from '../../entities/enums';
import { ROLE } from '../../rbac/rbac.constants';
import { EmailService } from '../email/email.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';
import { resolveGraceDays } from './subscription-status';

/** How far ahead of a boundary (expiry, or grace end) the "before" warning fires. */
const WARNING_WINDOW_DAYS = 3;

/**
 * The subscription grace state machine, run by the `subscriptions.renewalCheck`
 * sweep (`SubscriptionsProcessor`, which only schedules and delegates):
 *   ACTIVE/TRIAL --ends_at reached--> PAST_DUE (grace_started_at = now)
 *     --grace duration elapsed--> GRACE_EXPIRED (grace_expired_at = now)
 * with notifications to the tenant and platform operators at the three defined
 * points. Every transition is a conditional UPDATE (CR-08) and is audited.
 * The grace length comes from `resolveGraceDays`, the same source the live
 * effective-status derivation uses.
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger('SubscriptionLifecycleService');

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly email: EmailService,
    private readonly audit: PlatformAdminAuditService,
    private readonly config: ConfigService,
  ) {}

  /** The four sweeps, started in order (their first query is issued synchronously). */
  async runSweeps(): Promise<{
    expiringSoon: number;
    enteredGrace: number;
    graceEndingSoon: number;
    graceExpired: number;
  }> {
    const [expiringSoon, enteredGrace, graceEndingSoon, graceExpired] =
      await Promise.all([
        this.warnExpiringSoon(),
        this.transitionToGrace(),
        this.warnGraceEndingSoon(),
        this.transitionGraceExpired(),
      ]);
    return { expiringSoon, enteredGrace, graceEndingSoon, graceExpired };
  }

  // ── Point 1: "before expiry" — still ACTIVE/TRIAL, ends_at approaching ──

  async warnExpiringSoon(): Promise<number> {
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

  async transitionToGrace(): Promise<number> {
    const now = new Date();
    const due = await this.subscriptions.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
        ends_at: LessThanOrEqual(now),
        deleted_at: IsNull(),
      },
      relations: { tenant: true, plan: true },
    });
    let entered = 0;
    for (const s of due) {
      // CR-08: a conditional UPDATE, not read-then-save(). `save()` rewrites every column that
      // differs from the row read above, so a renewal settled between that read and this write
      // (status ACTIVE, new ends_at) was reverted to PAST_DUE with its paid period rolled back.
      // The predicate re-states why the row was selected; if it no longer holds, nothing is
      // written, audited or sent.
      const res = await this.subscriptions.update(
        {
          id: s.id,
          status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
          ends_at: LessThanOrEqual(now),
          deleted_at: IsNull(),
        },
        { status: SubscriptionStatus.PAST_DUE, grace_started_at: now },
      );
      if (!res.affected) continue;
      entered++;

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
        now.getTime() + resolveGraceDays(this.config) * 86_400_000,
      );
      await this.notify(s, 'entered_grace', {
        endsAt: s.ends_at.toISOString(),
        graceEndsAt: graceEndsAt.toISOString(),
        planName: s.plan?.name,
        idempotencyKey: `subscription:${s.id}:entered-grace:${now.toISOString()}`,
      });
    }
    return entered;
  }

  // ── Point 3: "before grace end" — still PAST_DUE, grace window approaching ──

  async warnGraceEndingSoon(): Promise<number> {
    const now = new Date();
    const graceDays = resolveGraceDays(this.config);
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

  async transitionGraceExpired(): Promise<number> {
    const now = new Date();
    const graceDays = resolveGraceDays(this.config);
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
    let expired = 0;
    for (const s of due) {
      // CR-08: conditional, for the same reason as transitionToGrace - a payment settled while
      // this sweep was running must not be turned back into GRACE_EXPIRED.
      const res = await this.subscriptions.update(
        {
          id: s.id,
          status: SubscriptionStatus.PAST_DUE,
          grace_started_at: LessThanOrEqual(cutoff),
          deleted_at: IsNull(),
        },
        { status: SubscriptionStatus.GRACE_EXPIRED, grace_expired_at: now },
      );
      if (!res.affected) continue;
      expired++;

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
    return expired;
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
          slug: ROLE.SUPER_ADMIN,
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
}
