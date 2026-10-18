import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { SubscriptionPlanChangedEvent } from '../../events/subscription.events';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';

import { AccessControlService } from './access-control.service';

/** Bounds one page of the sweep. Applied rows leave the filter; skipped ones are passed by id. */
const PAGE_SIZE = 200;

/** A subscription whose term can end with a downgrade still scheduled on it. */
const APPLICABLE: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIAL,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.GRACE_EXPIRED,
];

export interface ScheduledDowngradeSummary {
  scanned: number;
  applied: number;
  /** The row changed under us (auto-renew turned back on, already applied, …). */
  skipped: number;
}

/**
 * Applies a downgrade scheduled for the end of the paid term on a subscription
 * that does NOT auto-renew.
 *
 * With auto-renew ON the renewal invoice is priced from `pending_plan` and
 * settling it switches the plan (`InvoiceSettlementService`, RENEWAL). With
 * auto-renew OFF no renewal invoice is ever issued, so nothing applied the
 * downgrade — this does, at `ends_at`, without billing or charging anything:
 *
 *  - `plan := pending_plan`, `pending_plan := NULL`. `starts_at`/`ends_at` (the
 *    paid-through date) and `status` are untouched; the grace state machine runs
 *    exactly as before, now on the lower plan. A later reactivation or renewal is
 *    priced from it.
 *  - Exactly once: ONE conditional UPDATE per row (`pending_plan_id` still the one
 *    read, auto-renew still off, `ends_at` passed). A retried job, an overlapping
 *    sweep or a worker restart finds `pending_plan_id` already NULL and no-ops.
 *  - Auto-renew turned back on wins: the UPDATE requires `auto_renew = false`, so
 *    the renewal bills the downgrade as it always did.
 *
 * Runs on the existing `subscriptions.renewalCheck` sweep (02:00 UTC), BEFORE the
 * ACTIVE → PAST_DUE transition of the same tick.
 */
@Injectable()
export class ScheduledPlanChangeService {
  private readonly logger = new Logger('ScheduledPlanChangeService');

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly access: AccessControlService,
    private readonly audit: PlatformAdminAuditService,
    @Optional() private readonly emitter?: EventEmitter2,
  ) {}

  async applyDueDowngrades(
    now: Date = new Date(),
  ): Promise<ScheduledDowngradeSummary> {
    const summary: ScheduledDowngradeSummary = {
      scanned: 0,
      applied: 0,
      skipped: 0,
    };
    let afterId: string | undefined;
    for (;;) {
      const page = await this.subscriptions.find({
        where: {
          status: In(APPLICABLE),
          auto_renew: false,
          pending_plan: { id: Not(IsNull()) },
          ends_at: LessThanOrEqual(now),
          deleted_at: IsNull(),
          ...(afterId ? { id: MoreThan(afterId) } : {}),
        },
        select: {
          id: true,
          tenant: { id: true },
          plan: { id: true },
          pending_plan: { id: true },
          ends_at: true,
        },
        relations: { tenant: true, plan: true, pending_plan: true },
        order: { id: 'ASC' },
        take: PAGE_SIZE,
      });
      if (page.length === 0) break;

      for (const s of page) {
        summary.scanned += 1;
        const done = await this.applyOne(s, now).catch((err) => {
          this.logger.error(
            `Scheduled downgrade failed on subscription ${s.id}: ${(err as Error).message}`,
          );
          return false;
        });
        if (done) summary.applied += 1;
        else summary.skipped += 1;
      }
      afterId = page[page.length - 1].id;
      if (page.length < PAGE_SIZE) break;
    }

    if (summary.scanned > 0) {
      this.logger.log(
        `scheduledDowngrades: scanned=${summary.scanned} applied=${summary.applied} skipped=${summary.skipped}`,
      );
    }
    return summary;
  }

  /** TRUE when this call applied the downgrade. */
  private async applyOne(s: Subscription, now: Date): Promise<boolean> {
    const toPlanId = s.pending_plan?.id;
    if (!toPlanId) return false;
    const fromPlanId = s.plan?.id;

    const res = await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set({
        plan: () => '"pending_plan_id"',
        pending_plan: null,
      } as never)
      .where('id = :id', { id: s.id })
      .andWhere('pending_plan_id = :toPlanId', { toPlanId })
      .andWhere('auto_renew = false')
      .andWhere('ends_at <= :now', { now })
      .andWhere('deleted_at IS NULL')
      .andWhere('status IN (:...applicable)', { applicable: APPLICABLE })
      .execute();
    if (!res.affected) return false;

    const tenantId = s.tenant?.id;
    if (tenantId) this.access.invalidate(tenantId);
    await this.audit.record({
      action:
        PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_SCHEDULED_DOWNGRADE_APPLIED,
      userId: undefined,
      entityType: 'subscription',
      entityId: s.id,
      tenantId,
      before: { planId: fromPlanId, pendingPlanId: toPlanId },
      after: {
        planId: toPlanId,
        pendingPlanId: null,
        paidThrough: s.ends_at?.toISOString(),
      },
    });
    if (tenantId) {
      this.emitter?.emit(
        SubscriptionPlanChangedEvent.eventName,
        new SubscriptionPlanChangedEvent(tenantId, s.id, toPlanId),
      );
    }
    return true;
  }
}
