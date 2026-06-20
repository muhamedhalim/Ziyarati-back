import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { CreatePlanDto, UpdatePlanDto } from './dto/upsert-plan.dto';

/**
 * SUPER-ADMIN plan administration (`subscription_plans`).
 *
 * The plan catalogue is platform-owned: only the super admin creates plans,
 * edits them, and activates/deactivates them (enforced at the controller via
 * RolesGuard + @Roles(super_admin)). Tenants only ever READ plans (via
 * SubscriptionService.listPlans) and subscribe to them.
 *
 * Backward compatibility (the critical rule "update plans without breaking
 * existing subscriptions"): a plan's PRICE / BILLING CYCLE / LIMITS are
 * IMMUTABLE once any non-cancelled subscription references it. Subscriptions
 * hold a live FK to the plan row, so mutating those fields would retroactively
 * rewrite active customers' terms. Instead the API forces a new plan to be
 * created (Stripe-style immutable pricing). Only presentational/availability
 * fields (`name`, `is_active`) are editable on an in-use plan. Deactivating a
 * plan hides it from the catalogue WITHOUT affecting existing subscribers.
 */
@Injectable()
export class PlanAdminService {
  /** Fields that define the economic terms of a plan — frozen once in use. */
  private static readonly TERM_FIELDS: ReadonlyArray<keyof SubscriptionPlan> = [
    'price',
    'billing_cycle',
    'max_branches',
    'max_users',
    'max_ai_tokens',
    'max_whatsapp_messages',
    'max_appointments',
    'max_campaigns',
    'is_custom',
  ];

  constructor(
    @InjectRepository(SubscriptionPlan)
    private readonly plans: Repository<SubscriptionPlan>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
  ) {}

  /** Full catalogue including inactive plans (admin view). */
  listAll(): Promise<SubscriptionPlan[]> {
    return this.plans.find({ order: { price: 'ASC' } });
  }

  async get(id: string): Promise<SubscriptionPlan> {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Plan not found' });
    }
    return plan;
  }

  create(dto: CreatePlanDto): Promise<SubscriptionPlan> {
    return this.plans.save(
      this.plans.create({
        name: dto.name,
        price: dto.price.toFixed(2),
        billing_cycle: dto.billingCycle,
        max_branches: dto.maxBranches ?? undefined,
        max_users: dto.maxUsers ?? undefined,
        max_ai_tokens: dto.maxAiTokens != null ? String(dto.maxAiTokens) : undefined,
        max_whatsapp_messages: dto.maxWhatsappMessages ?? undefined,
        max_appointments: dto.maxAppointments ?? undefined,
        max_campaigns: dto.maxCampaigns ?? undefined,
        is_active: dto.isActive ?? true,
        is_custom: dto.isCustom ?? false,
      }),
    );
  }

  /**
   * Edit a plan. Name/is_active are always allowed; economic terms are rejected
   * (422) when the plan is in use — create a new plan instead.
   */
  async update(id: string, dto: UpdatePlanDto): Promise<SubscriptionPlan> {
    const plan = await this.get(id);

    const desiredTerms = this.toTermPatch(dto);
    const changesTerms = Object.entries(desiredTerms).some(
      ([k, v]) => v !== undefined && String(v) !== String(plan[k as keyof SubscriptionPlan]),
    );

    if (changesTerms && (await this.isInUse(id))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Pricing, billing cycle and limits are immutable once a plan has active subscribers. Create a new plan version instead (existing subscriptions keep their terms).',
      });
    }

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.isActive !== undefined) plan.is_active = dto.isActive;
    // Term edits are only reachable here when the plan is NOT in use.
    if (dto.price !== undefined) plan.price = dto.price.toFixed(2);
    if (dto.billingCycle !== undefined) plan.billing_cycle = dto.billingCycle;
    if (dto.maxBranches !== undefined) plan.max_branches = dto.maxBranches ?? undefined;
    if (dto.maxUsers !== undefined) plan.max_users = dto.maxUsers ?? undefined;
    if (dto.maxAiTokens !== undefined)
      plan.max_ai_tokens = dto.maxAiTokens != null ? String(dto.maxAiTokens) : undefined;
    if (dto.maxWhatsappMessages !== undefined)
      plan.max_whatsapp_messages = dto.maxWhatsappMessages ?? undefined;
    if (dto.maxAppointments !== undefined)
      plan.max_appointments = dto.maxAppointments ?? undefined;
    if (dto.maxCampaigns !== undefined) plan.max_campaigns = dto.maxCampaigns ?? undefined;
    if (dto.isCustom !== undefined) plan.is_custom = dto.isCustom;

    return this.plans.save(plan);
  }

  /** Activate / deactivate. Deactivating only hides the plan from the catalogue. */
  async setActive(id: string, isActive: boolean): Promise<SubscriptionPlan> {
    const plan = await this.get(id);
    plan.is_active = isActive;
    return this.plans.save(plan);
  }

  /** How many non-cancelled subscriptions reference this plan (compat check). */
  async isInUse(planId: string): Promise<boolean> {
    const count = await this.subscriptions.count({
      where: {
        plan: { id: planId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
    });
    return count > 0;
  }

  private toTermPatch(dto: UpdatePlanDto): Partial<Record<keyof SubscriptionPlan, unknown>> {
    return {
      price: dto.price != null ? dto.price.toFixed(2) : undefined,
      billing_cycle: dto.billingCycle,
      max_branches: dto.maxBranches,
      max_users: dto.maxUsers,
      max_ai_tokens: dto.maxAiTokens != null ? String(dto.maxAiTokens) : undefined,
      max_whatsapp_messages: dto.maxWhatsappMessages,
      max_appointments: dto.maxAppointments,
      max_campaigns: dto.maxCampaigns,
      is_custom: dto.isCustom,
    };
  }
}
