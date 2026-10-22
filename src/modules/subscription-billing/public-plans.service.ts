import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { BillingCycle, CustomCycleUnit } from '../../entities/enums';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import { PLAN_LIMIT_FIELDS } from './plan-admin.service';
import { PlanLimitStatusService } from './plan-limit-status.service';
import { SubscriptionService } from './subscription.service';

/** One configured limit. A limit that is "not configured" is omitted entirely. */
export interface PublicPlanLimit {
  /** camelCase DTO key, e.g. `maxBranches` (same names the admin API uses). */
  key: string;
  /** `null` means the plan declares this limit unlimited. */
  value: number | null;
}

export interface PublicPlanFeature {
  key: string;
  name: string;
  category: string;
}

/**
 * What an anonymous visitor may know about a plan. Deliberately a projection,
 * not the entity: no `is_active` (the list is active-only by construction),
 * no `limit_declarations` blob, no subscriber counts, nothing tenant- or
 * finance-related.
 */
export interface PublicPlan {
  id: string;
  name: string;
  /** Decimal string, e.g. "299.00". */
  price: string;
  billingCycle: BillingCycle;
  customCycleValue: number | null;
  customCycleUnit: CustomCycleUnit | null;
  /** Negotiated / enterprise plan — the site points these at sales, not checkout. */
  isCustom: boolean;
  limits: PublicPlanLimit[];
  features: PublicPlanFeature[];
}

export interface PublicPlanCatalog {
  /** Platform billing currency — plans themselves carry none. */
  currency: string;
  plans: PublicPlan[];
}

/**
 * The public pricing catalogue (`GET /public/plans`).
 *
 * Source of truth is the same `subscription_plans` table the super-admin
 * edits at `/platform/subscriptions`, read through
 * `SubscriptionService.listPlans()` — the very method the tenant-facing plan
 * list and `getActivePlan` use — so "visible on /pricing", "listed to a
 * tenant" and "purchasable" can never disagree about what active means.
 *
 * Features are the public, active, non-deprecated catalogue entries that a
 * tenant on that plan actually receives by default: a feature with no
 * `feature_plans` rows is on every plan, otherwise only on the listed ones
 * (the same rule `FeatureResolverService` applies), and it must be
 * `default_enabled` — otherwise it is an opt-in an admin grants per tenant,
 * not something the plan includes.
 */
@Injectable()
export class PublicPlansService {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly limitStatus: PlanLimitStatusService,
    private readonly settings: SystemSettingService,
    @InjectRepository(FeatureDefinition)
    private readonly featureDefs: Repository<FeatureDefinition>,
    @InjectRepository(FeaturePlan)
    private readonly featurePlans: Repository<FeaturePlan>,
  ) {}

  async getCatalog(): Promise<PublicPlanCatalog> {
    const [plans, currency] = await Promise.all([
      this.subscriptions.listPlans(),
      this.settings.getTyped<string>(SettingKey.DEFAULT_CURRENCY),
    ]);
    if (plans.length === 0) return { currency, plans: [] };

    const [defs, planRows] = await Promise.all([
      this.featureDefs.find({
        where: {
          is_active: true,
          is_deprecated: false,
          visibility: 'public',
          default_enabled: true,
        },
        order: { category: 'ASC', name: 'ASC' },
      }),
      this.featurePlans.find(),
    ]);

    const restrictedTo = new Map<string, Set<string>>();
    for (const row of planRows) {
      const set = restrictedTo.get(row.feature_key) ?? new Set<string>();
      set.add(row.plan_id);
      restrictedTo.set(row.feature_key, set);
    }

    return {
      currency,
      plans: plans.map((plan) => this.project(plan, defs, restrictedTo)),
    };
  }

  private project(
    plan: SubscriptionPlan,
    defs: FeatureDefinition[],
    restrictedTo: Map<string, Set<string>>,
  ): PublicPlan {
    return {
      id: plan.id,
      name: plan.name,
      price: plan.price,
      billingCycle: plan.billing_cycle,
      customCycleValue: plan.custom_cycle_value ?? null,
      customCycleUnit: plan.custom_cycle_unit ?? null,
      isCustom: plan.is_custom,
      limits: this.limits(plan),
      features: defs
        .filter((d) => {
          const allowed = restrictedTo.get(d.feature_key);
          return !allowed || allowed.has(plan.id);
        })
        .map((d) => ({
          key: d.feature_key,
          name: d.name,
          category: d.category,
        })),
    };
  }

  private limits(plan: SubscriptionPlan): PublicPlanLimit[] {
    const out: PublicPlanLimit[] = [];
    for (const field of PLAN_LIMIT_FIELDS) {
      const status = this.limitStatus.resolve(plan, field.column);
      if (status === 'finite') {
        const raw = (plan as unknown as Record<string, unknown>)[field.column];
        out.push({ key: field.dto, value: Number(raw) });
      } else if (status === 'unlimited') {
        out.push({ key: field.dto, value: null });
      }
      // not_configured: nobody decided what this plan allows, so say nothing.
    }
    return out;
  }
}
