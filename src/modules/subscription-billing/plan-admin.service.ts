import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';
import { AccessCacheService } from './access-cache.service';

import { CreatePlanDto, UpdatePlanDto } from './dto/upsert-plan.dto';

/** DTO keys carrying a plain numeric limit — the only keys the map below may name. */
type NumericPlanDtoKey = {
  [K in keyof CreatePlanDto]-?: CreatePlanDto[K] extends number | undefined
    ? K
    : never;
}[keyof CreatePlanDto];

/**
 * Every plan limit column, paired with its DTO key. ONE list, four consumers
 * (`create`, `update`, `snapshot`, `toTermPatch`).
 *
 * This replaces the four hand-maintained copies that used to live in this file
 * — plus a fifth, `TERM_FIELDS`, which was declared, never read, and had
 * already drifted from `toTermPatch` (the copy that actually ran). Adding the
 * 13 count-based caps to four separate lists by hand is precisely how that
 * drift happens, so they are derived from here instead.
 *
 * `bigint: true` marks the columns Postgres returns as strings, which must be
 * stringified on the way in so the immutability comparison in `update()` (which
 * compares with `String(...)`) matches what came out of the database.
 */
export const PLAN_LIMIT_FIELDS = [
  { dto: 'maxBranches', column: 'max_branches' },
  { dto: 'maxUsers', column: 'max_users' },
  { dto: 'maxAiTokens', column: 'max_ai_tokens', bigint: true },
  { dto: 'maxWhatsappMessages', column: 'max_whatsapp_messages' },
  { dto: 'maxAppointments', column: 'max_appointments' },
  { dto: 'maxCampaigns', column: 'max_campaigns' },
  { dto: 'maxAiRequests', column: 'max_ai_requests' },
  { dto: 'maxCustomers', column: 'max_customers' },
  { dto: 'maxCrmContacts', column: 'max_crm_contacts' },
  { dto: 'maxConversations', column: 'max_conversations' },
  { dto: 'maxStorageBytes', column: 'max_storage_bytes', bigint: true },
  { dto: 'maxUploadedFiles', column: 'max_uploaded_files' },
  { dto: 'maxApiCalls', column: 'max_api_calls', bigint: true },
  { dto: 'maxEmails', column: 'max_emails' },
  { dto: 'maxInvoices', column: 'max_invoices' },
  { dto: 'maxPayments', column: 'max_payments' },
  { dto: 'maxTransactions', column: 'max_transactions' },
  { dto: 'maxKnowledgeBaseFiles', column: 'max_knowledge_base_files' },
  { dto: 'maxTrainingFiles', column: 'max_training_files' },
] as const satisfies ReadonlyArray<{
  dto: NumericPlanDtoKey;
  column: keyof SubscriptionPlan;
  bigint?: boolean;
}>;

/** A limit value as it must be written to the entity (bigint columns are strings). */
function limitValue(
  isBigInt: boolean,
  raw: number | undefined,
): string | number | undefined {
  if (raw == null) return undefined;
  return isBigInt ? String(raw) : raw;
}

/** `bigint` is absent on most entries, so read it through a widened view. */
function isBigIntColumn(field: (typeof PLAN_LIMIT_FIELDS)[number]): boolean {
  return (field as { bigint?: boolean }).bigint === true;
}

/**
 * Translates the DTO's camelCase `limitDeclarations` keys (matching the
 * other limit fields' own naming) to the entity's snake_case column keys
 * (matching `subscription_plans.limit_declarations`'s actual stored shape,
 * and every one of the ~20 call sites that already read a plan limit by
 * column name). Reuses {@link PLAN_LIMIT_FIELDS} rather than a second
 * key list, so an unknown/misspelled key is refused here — before it ever
 * reaches storage — instead of silently sitting in the JSONB blob as a
 * declaration nothing will ever consult.
 */
function toColumnDeclarations(
  dtoDeclarations: Record<string, string> | undefined,
): Record<string, 'unlimited'> | undefined {
  if (dtoDeclarations === undefined) return undefined;
  const out: Record<string, 'unlimited'> = {};
  for (const [dtoKey, value] of Object.entries(dtoDeclarations)) {
    const field = PLAN_LIMIT_FIELDS.find((f) => f.dto === dtoKey);
    if (!field) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Unknown limit field "${dtoKey}" in limitDeclarations.`,
      });
    }
    if (value !== 'unlimited') {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `limitDeclarations.${dtoKey} must be "unlimited" (got "${value}").`,
      });
    }
    out[field.column] = 'unlimited';
  }
  return out;
}

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
  constructor(
    @InjectRepository(SubscriptionPlan)
    private readonly plans: Repository<SubscriptionPlan>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly audit: PlatformAdminAuditService,
    private readonly tenantContext: TenantContextService,
    private readonly accessCache: AccessCacheService,
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

  async create(dto: CreatePlanDto): Promise<SubscriptionPlan> {
    const limits: Record<string, string | number | undefined> = {};
    for (const field of PLAN_LIMIT_FIELDS) {
      limits[field.column] = limitValue(isBigIntColumn(field), dto[field.dto]);
    }
    const result = await this.plans.save(
      this.plans.create({
        name: dto.name,
        price: dto.price.toFixed(2),
        billing_cycle: dto.billingCycle,
        ...limits,
        limit_declarations: toColumnDeclarations(dto.limitDeclarations) ?? null,
        is_active: dto.isActive ?? true,
        is_custom: dto.isCustom ?? false,
      }),
    );
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.PLAN_CREATE,
      userId: this.actorId(),
      entityType: 'subscription_plan',
      entityId: result.id,
      before: null,
      after: this.snapshot(result),
    });
    return result;
  }

  /**
   * Edit a plan. Name/is_active are always allowed; economic terms are rejected
   * (422) when the plan is in use — create a new plan instead.
   */
  async update(id: string, dto: UpdatePlanDto): Promise<SubscriptionPlan> {
    const plan = await this.get(id);
    const before = this.snapshot(plan);

    const desiredTerms = this.toTermPatch(dto);
    const changesTerms = Object.entries(desiredTerms).some(
      ([k, v]) =>
        v !== undefined &&
        String(v) !== String(plan[k as keyof SubscriptionPlan]),
    );

    if (changesTerms && (await this.isInUse(id))) {
      // FND-015 / AD-14: both success and refusal are recorded — an attempt
      // to change frozen economic terms on an in-use plan is exactly the kind
      // of thing platform support needs visibility into.
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.PLAN_UPDATE_REJECTED,
        userId: this.actorId(),
        entityType: 'subscription_plan',
        entityId: id,
        before,
        after: {
          attemptedTerms: desiredTerms,
          result: 'rejected: plan is in use',
        },
      });
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Pricing, billing cycle and limits are immutable once a plan has active subscribers. Create a new plan version instead (existing subscriptions keep their terms).',
      });
    }

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.isActive !== undefined) plan.is_active = dto.isActive;
    // Declaring a NULL limit "unlimited" documents existing behaviour — no
    // subscriber's effective limit moves — so, like name/is_active, it is
    // NOT a frozen economic term (absent from toTermPatch) and stays
    // editable on an in-use plan. Full-object replace, not a merge: the
    // admin form always submits the complete desired declaration set.
    if (dto.limitDeclarations !== undefined) {
      plan.limit_declarations = toColumnDeclarations(dto.limitDeclarations) ?? null;
    }
    // Term edits are only reachable here when the plan is NOT in use.
    if (dto.price !== undefined) plan.price = dto.price.toFixed(2);
    if (dto.billingCycle !== undefined) plan.billing_cycle = dto.billingCycle;
    for (const field of PLAN_LIMIT_FIELDS) {
      const raw = dto[field.dto];
      if (raw === undefined) continue;
      (plan as unknown as Record<string, unknown>)[field.column] = limitValue(
        isBigIntColumn(field),
        raw,
      );
    }
    if (dto.isCustom !== undefined) plan.is_custom = dto.isCustom;

    const result = await this.plans.save(plan);
    // `is_active` and the limit columns feed the decision (and the quota
    // arithmetic) of every tenant subscribed to this plan. Cheaper and safer to
    // drop everything than to look up who those tenants are.
    this.accessCache.invalidateAll();
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.PLAN_UPDATE,
      userId: this.actorId(),
      entityType: 'subscription_plan',
      entityId: result.id,
      before,
      after: this.snapshot(result),
    });
    return result;
  }

  /** Activate / deactivate. Deactivating only hides the plan from the catalogue. */
  async setActive(id: string, isActive: boolean): Promise<SubscriptionPlan> {
    const plan = await this.get(id);
    const wasActive = plan.is_active;
    plan.is_active = isActive;
    const result = await this.plans.save(plan);
    await this.audit.record({
      action: isActive
        ? PLATFORM_ADMIN_AUDIT_ACTION.PLAN_ACTIVATE
        : PLATFORM_ADMIN_AUDIT_ACTION.PLAN_DEACTIVATE,
      userId: this.actorId(),
      entityType: 'subscription_plan',
      entityId: result.id,
      before: { isActive: wasActive },
      after: { isActive },
    });
    return result;
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

  private actorId(): string | undefined {
    return this.tenantContext.getUser()?.id;
  }

  /**
   * Compact, audit-safe snapshot of a plan's economically-relevant fields.
   * Covers all 19 limit columns — the 13 count-based caps used to be absent
   * here, so a change to one was invisible in the audit trail.
   */
  private snapshot(plan: SubscriptionPlan): Record<string, unknown> {
    const limits: Record<string, unknown> = {};
    for (const field of PLAN_LIMIT_FIELDS) {
      limits[field.dto] = (plan as unknown as Record<string, unknown>)[
        field.column
      ];
    }
    return {
      name: plan.name,
      price: plan.price,
      billingCycle: plan.billing_cycle,
      ...limits,
      limitDeclarations: plan.limit_declarations ?? null,
      isActive: plan.is_active,
      isCustom: plan.is_custom,
    };
  }

  /**
   * The economic terms, frozen once the plan has a non-cancelled subscriber.
   * Every limit column counts: raising a cap on an in-use plan would silently
   * rewrite live customers' entitlements, which is exactly what the freeze
   * exists to prevent. Tenant-specific raises go through paid add-ons or a
   * super-admin override instead — neither of which touches the plan row.
   */
  private toTermPatch(
    dto: UpdatePlanDto,
  ): Partial<Record<keyof SubscriptionPlan, unknown>> {
    const limits: Partial<Record<keyof SubscriptionPlan, unknown>> = {};
    for (const field of PLAN_LIMIT_FIELDS) {
      limits[field.column] = limitValue(isBigIntColumn(field), dto[field.dto]);
    }
    return {
      price: dto.price != null ? dto.price.toFixed(2) : undefined,
      billing_cycle: dto.billingCycle,
      ...limits,
      is_custom: dto.isCustom,
    };
  }
}
