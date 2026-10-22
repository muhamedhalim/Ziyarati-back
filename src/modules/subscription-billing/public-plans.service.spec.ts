import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { BillingCycle, CustomCycleUnit } from '../../entities/enums';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { PlanLimitStatusService } from './plan-limit-status.service';
import { PublicPlansService } from './public-plans.service';

function plan(overrides: Partial<SubscriptionPlan> = {}): SubscriptionPlan {
  return {
    id: 'plan-1',
    name: 'Starter',
    price: '99.00',
    billing_cycle: BillingCycle.MONTHLY,
    custom_cycle_value: null,
    custom_cycle_unit: null,
    limit_declarations: null,
    is_active: true,
    is_custom: false,
    ...overrides,
  } as SubscriptionPlan;
}

function def(overrides: Partial<FeatureDefinition> = {}): FeatureDefinition {
  return {
    feature_key: 'crm',
    name: 'CRM',
    category: 'Core',
    ...overrides,
  } as FeatureDefinition;
}

function build(opts: {
  plans: SubscriptionPlan[];
  defs?: FeatureDefinition[];
  featurePlans?: Array<Pick<FeaturePlan, 'feature_key' | 'plan_id'>>;
  currency?: string;
}) {
  const listPlans = jest.fn().mockResolvedValue(opts.plans);
  const findDefs = jest.fn().mockResolvedValue(opts.defs ?? []);
  const findPlans = jest.fn().mockResolvedValue(opts.featurePlans ?? []);
  const service = new PublicPlansService(
    { listPlans } as never,
    new PlanLimitStatusService(),
    { getTyped: jest.fn().mockResolvedValue(opts.currency ?? 'SAR') } as never,
    { find: findDefs } as never,
    { find: findPlans } as never,
  );
  return { service, listPlans, findDefs, findPlans };
}

describe('PublicPlansService', () => {
  it('reads the catalogue through SubscriptionService.listPlans (the single "active" definition)', async () => {
    const { service, listPlans } = build({ plans: [plan()] });
    await service.getCatalog();
    expect(listPlans).toHaveBeenCalledTimes(1);
  });

  it('returns an empty catalogue (not an error) when no plan is active, without touching feature tables', async () => {
    const { service, findDefs, findPlans } = build({ plans: [] });
    await expect(service.getCatalog()).resolves.toEqual({
      currency: 'SAR',
      plans: [],
    });
    expect(findDefs).not.toHaveBeenCalled();
    expect(findPlans).not.toHaveBeenCalled();
  });

  it('exposes the billing currency from platform settings', async () => {
    const { service } = build({ plans: [plan()], currency: 'USD' });
    expect((await service.getCatalog()).currency).toBe('USD');
  });

  it('projects name, price, cycle and custom flag straight from the stored plan', async () => {
    const { service } = build({
      plans: [
        plan({
          name: 'Enterprise',
          price: '1299.50',
          billing_cycle: BillingCycle.CUSTOM,
          custom_cycle_value: 3,
          custom_cycle_unit: CustomCycleUnit.MONTH,
          is_custom: true,
        }),
      ],
    });
    const [p] = (await service.getCatalog()).plans;
    expect(p).toMatchObject({
      id: 'plan-1',
      name: 'Enterprise',
      price: '1299.50',
      billingCycle: BillingCycle.CUSTOM,
      customCycleValue: 3,
      customCycleUnit: CustomCycleUnit.MONTH,
      isCustom: true,
    });
  });

  it('never leaks internals: no is_active, no raw limit columns, no declarations blob', async () => {
    const { service } = build({
      plans: [
        plan({
          max_users: 5,
          limit_declarations: { max_branches: 'unlimited' },
        }),
      ],
    });
    const json = JSON.stringify(await service.getCatalog());
    for (const forbidden of [
      'is_active',
      'isActive',
      'limit_declarations',
      'limitDeclarations',
      'max_users',
      'is_in_use',
      'subscri',
      'tenant',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  describe('limits', () => {
    it('finite -> number, declared-unlimited -> null, not-configured -> omitted', async () => {
      const { service } = build({
        plans: [
          plan({
            max_users: 5,
            max_ai_tokens: '1000000',
            limit_declarations: { max_branches: 'unlimited' },
          }),
        ],
      });
      const [p] = (await service.getCatalog()).plans;
      expect(p.limits).toEqual([
        { key: 'maxBranches', value: null },
        { key: 'maxUsers', value: 5 },
        { key: 'maxAiTokens', value: 1_000_000 },
      ]);
    });

    it('a plan with nothing configured lists no limits at all', async () => {
      const { service } = build({ plans: [plan()] });
      expect((await service.getCatalog()).plans[0].limits).toEqual([]);
    });
  });

  describe('features', () => {
    it('a feature with no feature_plans rows is on every plan', async () => {
      const { service } = build({
        plans: [plan({ id: 'a' }), plan({ id: 'b' })],
        defs: [def()],
      });
      const { plans } = await service.getCatalog();
      expect(plans.map((p) => p.features.map((f) => f.key))).toEqual([
        ['crm'],
        ['crm'],
      ]);
    });

    it('a plan-restricted feature appears only on the plans it is mapped to', async () => {
      const { service } = build({
        plans: [plan({ id: 'a' }), plan({ id: 'b' })],
        defs: [def({ feature_key: 'ai', name: 'AI' })],
        featurePlans: [{ feature_key: 'ai', plan_id: 'b' }],
      });
      const { plans } = await service.getCatalog();
      expect(plans.find((p) => p.id === 'a')!.features).toEqual([]);
      expect(plans.find((p) => p.id === 'b')!.features).toEqual([
        { key: 'ai', name: 'AI', category: 'Core' },
      ]);
    });

    it('only asks the database for public, active, non-deprecated, on-by-default features', async () => {
      const { service, findDefs } = build({ plans: [plan()] });
      await service.getCatalog();
      expect(findDefs).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            is_active: true,
            is_deprecated: false,
            visibility: 'public',
            default_enabled: true,
          },
        }),
      );
    });
  });
});
