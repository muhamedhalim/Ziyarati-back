import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { BillingCycle, SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { BillingService } from './billing.service';
import { AccessControlService } from './access-control.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import {
  SubscriptionActivatedEvent,
  SubscriptionCancelledEvent,
  SubscriptionPlanChangedEvent,
  SubscriptionReactivatedEvent,
  SubscriptionTrialStartedEvent,
} from '../../events/subscription.events';

/**
 * Effective (computed) status. FND-031: previously this bolted on a separate
 * 'EXPIRED' string for "ACTIVE/TRIAL past ends_at" — that WAS the silent-lapse
 * bug (a tenant past its end date became unusable forever, with no grace, no
 * notice, no path back). It now live-derives straight into the real
 * PAST_DUE/GRACE_EXPIRED enum values the state machine defines, so a
 * subscription whose column hasn't been swept yet by the background
 * transition job (`subscriptions.processor.ts`) is still treated exactly as
 * if it had been — never a race between "what the column says" and
 * "what's actually true".
 */
export type EffectiveStatus = SubscriptionStatus;

/**
 * FND-031/T086 — the three access states named in the finding/spec, additive
 * to (never replacing or translating) the underlying `status` enum (LG-10).
 */
export type AccessState = 'active' | 'expired-in-grace' | 'grace-expired' | 'terminal';

export interface SubscriptionView {
  subscription: Subscription;
  effectiveStatus: EffectiveStatus;
  isUsable: boolean;
  /** Additive — FND-031/T086. Never derived by the client from `status` (LG-10: machine values are never translated). */
  accessState: AccessState;
  /** Additive — FND-031/T086. Null unless currently in `expired-in-grace` (PAST_DUE). */
  graceEndsAt: Date | null;
}

/**
 * Subscription lifecycle.
 *
 * Tenant isolation: `subscriptions` is tenant-scoped via the `tenant` relation,
 * so every query filters `where: { tenant: { id: tenantId } }`. The tenant is
 * always taken from the authenticated principal.
 *
 * Note on states: the enum is TRIAL | ACTIVE | PAST_DUE | CANCELLED | SUSPENDED.
 * There is no persisted EXPIRED — "expired" is DERIVED when an otherwise-active
 * subscription's `ends_at` is in the past (see `getEffectiveStatus`).
 */
@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionPlan)
    private readonly plans: Repository<SubscriptionPlan>,
    private readonly billing: BillingService,
    private readonly access: AccessControlService,
    private readonly platformSettings: SystemSettingService,
    private readonly emitter: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  // ───────────────────────────── Plans ───────────────────────────────────── //

  /** Active plans available to subscribe to (global catalogue, not tenant-scoped). */
  listPlans(): Promise<SubscriptionPlan[]> {
    return this.plans.find({
      where: { is_active: true },
      order: { price: 'ASC' },
    });
  }

  async getPlan(id: string): Promise<SubscriptionPlan> {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Plan not found' });
    }
    return plan;
  }

  // ─────────────────────────── Subscription ──────────────────────────────── //

  async create(
    tenantId: string,
    dto: CreateSubscriptionDto,
  ): Promise<SubscriptionView> {
    const plan = await this.getActivePlan(dto.planId);

    const existing = await this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
    });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This tenant already has an active subscription',
      });
    }

    const startsAt = new Date();
    let endsAt: Date;
    let status: SubscriptionStatus;

    if (dto.startTrial) {
      const trialDays = await this.platformSettings.getTyped<number>(SettingKey.TRIAL_DURATION_DAYS);
      endsAt = new Date(startsAt.getTime() + trialDays * 86_400_000);
      status = SubscriptionStatus.TRIAL;
    } else {
      endsAt = this.computeEnds(startsAt, plan.billing_cycle);
      status = SubscriptionStatus.ACTIVE;
    }

    const subscription = await this.subscriptions.save(
      this.subscriptions.create({
        tenant: { id: tenantId } as Tenant,
        plan: { id: plan.id } as SubscriptionPlan,
        status,
        starts_at: startsAt,
        ends_at: endsAt,
        auto_renew: dto.autoRenew ?? true,
      }),
    );

    // Issue the first invoice for paid (non-trial) subscriptions.
    if (status !== SubscriptionStatus.TRIAL) {
      await this.billing.generateInvoice(tenantId, subscription.id, Number(plan.price));
    }

    const view = await this.view(await this.loadWithPlan(tenantId, subscription.id));

    if (status === SubscriptionStatus.TRIAL) {
      this.emitter.emit(
        SubscriptionTrialStartedEvent.eventName,
        new SubscriptionTrialStartedEvent(tenantId, subscription.id, plan.id, endsAt),
      );
    } else {
      this.emitter.emit(
        SubscriptionActivatedEvent.eventName,
        new SubscriptionActivatedEvent(tenantId, subscription.id, plan.id),
      );
    }

    return view;
  }

  /** The tenant's current subscription (most recent, non-deleted) + computed status. */
  async getCurrent(tenantId: string): Promise<SubscriptionView> {
    const subscription = await this.subscriptions.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      relations: { plan: true },
      order: { created_at: 'DESC' },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No subscription found for this tenant',
      });
    }
    return this.view(subscription);
  }

  async changePlan(
    tenantId: string,
    dto: ChangePlanDto,
  ): Promise<SubscriptionView> {
    const current = await this.getActiveSubscription(tenantId);
    if (current.plan.id === dto.planId) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'The subscription is already on this plan',
      });
    }
    const newPlan = await this.getActivePlan(dto.planId);

    current.plan = { id: newPlan.id } as SubscriptionPlan;
    current.status = SubscriptionStatus.ACTIVE;
    await this.subscriptions.save(current);

    // Proration is abstracted: issue an invoice for the new plan price.
    await this.billing.generateInvoice(tenantId, current.id, Number(newPlan.price));

    const view = await this.view(await this.loadWithPlan(tenantId, current.id));
    this.emitter.emit(
      SubscriptionPlanChangedEvent.eventName,
      new SubscriptionPlanChangedEvent(tenantId, current.id, newPlan.id),
    );
    return view;
  }

  async cancel(
    tenantId: string,
    dto: CancelSubscriptionDto,
  ): Promise<SubscriptionView> {
    const current = await this.getActiveSubscription(tenantId);

    current.auto_renew = false;
    if (!dto.cancelAtPeriodEnd) {
      // Immediate cancellation.
      current.status = SubscriptionStatus.CANCELLED;
    }
    // If cancelAtPeriodEnd: keep status/access until ends_at; only auto-renew off.
    await this.subscriptions.save(current);

    const view = await this.view(await this.loadWithPlan(tenantId, current.id));
    this.emitter.emit(
      SubscriptionCancelledEvent.eventName,
      new SubscriptionCancelledEvent(tenantId, current.id, dto.cancelAtPeriodEnd ?? false),
    );
    return view;
  }

  async reactivate(tenantId: string): Promise<SubscriptionView> {
    const subscription = await this.subscriptions.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      relations: { plan: true },
      order: { created_at: 'DESC' },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No subscription found for this tenant',
      });
    }
    if (subscription.status === SubscriptionStatus.ACTIVE) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Subscription is already active',
      });
    }

    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.auto_renew = true;
    if (subscription.ends_at < new Date()) {
      subscription.starts_at = new Date();
      subscription.ends_at = this.computeEnds(
        subscription.starts_at,
        subscription.plan.billing_cycle,
      );
    }
    await this.subscriptions.save(subscription);

    this.emitter.emit(
      SubscriptionReactivatedEvent.eventName,
      new SubscriptionReactivatedEvent(tenantId, subscription.id),
    );
    return this.view(subscription);
  }

  // ─────────────────── Cross-module access validation ────────────────────── //

  /**
   * Computes the effective status, live-deriving past the raw column when the
   * background transition sweep (`subscriptions.processor.ts`) hasn't caught
   * up yet: ACTIVE/TRIAL past `ends_at` reads as PAST_DUE; PAST_DUE whose
   * grace window (from `grace_started_at` + `graceDurationDays`) has elapsed
   * reads as GRACE_EXPIRED. CANCELLED/SUSPENDED (terminal) and an
   * already-GRACE_EXPIRED row pass through unchanged.
   */
  getEffectiveStatus(
    subscription: Subscription,
    graceDurationDays: number = this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14),
  ): EffectiveStatus {
    const now = new Date();
    if (
      subscription.status === SubscriptionStatus.CANCELLED ||
      subscription.status === SubscriptionStatus.SUSPENDED ||
      subscription.status === SubscriptionStatus.GRACE_EXPIRED
    ) {
      return subscription.status;
    }
    if (subscription.status === SubscriptionStatus.PAST_DUE) {
      if (subscription.grace_started_at) {
        const graceEndsAt = new Date(
          subscription.grace_started_at.getTime() + graceDurationDays * 86_400_000,
        );
        if (graceEndsAt < now) return SubscriptionStatus.GRACE_EXPIRED;
      }
      return SubscriptionStatus.PAST_DUE;
    }
    // ACTIVE / TRIAL
    if (subscription.ends_at < now) return SubscriptionStatus.PAST_DUE;
    return subscription.status;
  }

  /**
   * Read access is preserved in EVERY non-terminal state (FR-B007d) — only
   * CANCELLED/SUSPENDED are not usable. Distinct from
   * `assertBillableActionAllowed`, which is the narrower, write-specific gate.
   */
  isUsable(subscription: Subscription, graceDurationDays?: number): boolean {
    const effective = this.getEffectiveStatus(subscription, graceDurationDays);
    return (
      effective !== SubscriptionStatus.CANCELLED &&
      effective !== SubscriptionStatus.SUSPENDED
    );
  }

  /**
   * FND-031/FR-B007 — throws once a subscription is GRACE_EXPIRED. Callers
   * are the same call sites FND-034 already gates (appointments, campaigns,
   * WhatsApp sends, AI turns) plus any other billable/state-mutating action —
   * read-only endpoints must NEVER call this.
   */
  async assertBillableActionAllowed(tenantId: string): Promise<void> {
    const subscription = await this.subscriptions.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
    if (!subscription) return; // no subscription at all is AccessControlService's concern, not this gate's
    if (this.getEffectiveStatus(subscription) === SubscriptionStatus.GRACE_EXPIRED) {
      throw new AppError(ErrorCode.SUBSCRIPTION_GRACE_EXPIRED);
    }
  }

  /**
   * Throws 403 unless the tenant currently has platform access. Delegates to
   * AccessControlService so the FULL priority chain is honoured (global free
   * mode → free-access override → usable paid subscription) — not just the raw
   * subscription state. Exported for other domains to gate protected actions.
   */
  async assertUsable(tenantId: string): Promise<void> {
    await this.access.assertUsable(tenantId);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private view(subscription: Subscription): SubscriptionView {
    const graceDurationDays = this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
    const effectiveStatus = this.getEffectiveStatus(subscription, graceDurationDays);
    const isUsable = this.isUsable(subscription, graceDurationDays);

    let accessState: AccessState;
    let graceEndsAt: Date | null = null;
    switch (effectiveStatus) {
      case SubscriptionStatus.CANCELLED:
      case SubscriptionStatus.SUSPENDED:
        accessState = 'terminal';
        break;
      case SubscriptionStatus.GRACE_EXPIRED:
        accessState = 'grace-expired';
        break;
      case SubscriptionStatus.PAST_DUE:
        accessState = 'expired-in-grace';
        if (subscription.grace_started_at) {
          graceEndsAt = new Date(
            subscription.grace_started_at.getTime() + graceDurationDays * 86_400_000,
          );
        }
        break;
      default: // ACTIVE / TRIAL
        accessState = 'active';
    }

    return { subscription, effectiveStatus, isUsable, accessState, graceEndsAt };
  }

  private async getActivePlan(planId: string): Promise<SubscriptionPlan> {
    const plan = await this.plans.findOne({ where: { id: planId } });
    if (!plan) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Plan not found' });
    }
    if (!plan.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This plan is not available for subscription',
      });
    }
    return plan;
  }

  private async getActiveSubscription(tenantId: string): Promise<Subscription> {
    const subscription = await this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      relations: { plan: true },
      order: { created_at: 'DESC' },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No active subscription found for this tenant',
      });
    }
    return subscription;
  }

  private async loadWithPlan(tenantId: string, id: string): Promise<Subscription> {
    const subscription = await this.subscriptions.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { plan: true },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Subscription not found' });
    }
    return subscription;
  }

  private computeEnds(start: Date, cycle: BillingCycle): Date {
    const end = new Date(start);
    switch (cycle) {
      case BillingCycle.YEARLY:
        end.setUTCFullYear(end.getUTCFullYear() + 1);
        break;
      case BillingCycle.MONTHLY:
      case BillingCycle.CUSTOM:
      default:
        end.setUTCMonth(end.getUTCMonth() + 1);
        break;
    }
    return end;
  }
}
