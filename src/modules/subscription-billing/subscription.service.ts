import { Injectable } from '@nestjs/common';
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

/** Effective (computed) status — adds the derived EXPIRED state on top of the enum. */
export type EffectiveStatus = SubscriptionStatus | 'EXPIRED';

export interface SubscriptionView {
  subscription: Subscription;
  effectiveStatus: EffectiveStatus;
  isUsable: boolean;
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
    const endsAt = this.computeEnds(startsAt, plan.billing_cycle);
    const status = dto.startTrial
      ? SubscriptionStatus.TRIAL
      : SubscriptionStatus.ACTIVE;

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

    return this.view(await this.loadWithPlan(tenantId, subscription.id));
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

    return this.view(await this.loadWithPlan(tenantId, current.id));
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

    return this.view(await this.loadWithPlan(tenantId, current.id));
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

    return this.view(subscription);
  }

  // ─────────────────── Cross-module access validation ────────────────────── //

  /** Computes the effective status (incl. derived EXPIRED) and usability. */
  getEffectiveStatus(subscription: Subscription): EffectiveStatus {
    const now = new Date();
    if (
      (subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.TRIAL) &&
      subscription.ends_at < now
    ) {
      return 'EXPIRED';
    }
    return subscription.status;
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
    const effectiveStatus = this.getEffectiveStatus(subscription);
    const isUsable =
      effectiveStatus === SubscriptionStatus.ACTIVE ||
      effectiveStatus === SubscriptionStatus.TRIAL;
    return { subscription, effectiveStatus, isUsable };
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
