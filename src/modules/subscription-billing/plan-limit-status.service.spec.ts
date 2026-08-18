import { PlanLimitStatusService, PLAN_LIMIT_STATUS } from './plan-limit-status.service';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';

function plan(overrides: Partial<SubscriptionPlan> = {}): SubscriptionPlan {
  return {
    id: 'plan-1',
    max_branches: null,
    max_customers: null,
    max_users: 5,
    limit_declarations: null,
    ...overrides,
  } as SubscriptionPlan;
}

describe('PlanLimitStatusService', () => {
  const service = new PlanLimitStatusService();

  describe('resolve', () => {
    it('a set number is Finite', () => {
      expect(service.resolve(plan(), 'max_users')).toBe(PLAN_LIMIT_STATUS.FINITE);
    });

    it('NULL + declared unlimited is Unlimited', () => {
      const p = plan({ limit_declarations: { max_branches: 'unlimited' } });
      expect(service.resolve(p, 'max_branches')).toBe(PLAN_LIMIT_STATUS.UNLIMITED);
    });

    it('NULL + not declared is Not configured', () => {
      expect(service.resolve(plan(), 'max_branches')).toBe(PLAN_LIMIT_STATUS.NOT_CONFIGURED);
    });

    it('NULL + limit_declarations set for a DIFFERENT column is still Not configured for this one', () => {
      const p = plan({ limit_declarations: { max_customers: 'unlimited' } });
      expect(service.resolve(p, 'max_branches')).toBe(PLAN_LIMIT_STATUS.NOT_CONFIGURED);
    });

    it('a Finite column is never overridden by a declaration (a number always wins)', () => {
      const p = plan({ max_users: 10, limit_declarations: { max_users: 'unlimited' } });
      expect(service.resolve(p, 'max_users')).toBe(PLAN_LIMIT_STATUS.FINITE);
    });

    it('limit_declarations === null (never configured) is Not configured, not a crash', () => {
      const p = plan({ limit_declarations: null });
      expect(service.resolve(p, 'max_branches')).toBe(PLAN_LIMIT_STATUS.NOT_CONFIGURED);
    });
  });

  describe('resolveAll', () => {
    it('resolves every one of the 19 PLAN_LIMIT_FIELDS columns', () => {
      const all = service.resolveAll(plan());
      expect(Object.keys(all).length).toBe(19);
      expect(all.max_users).toBe(PLAN_LIMIT_STATUS.FINITE);
      expect(all.max_branches).toBe(PLAN_LIMIT_STATUS.NOT_CONFIGURED);
    });
  });

  describe('hasAnyFiniteLimit', () => {
    it('true when at least one named column is Finite', () => {
      expect(service.hasAnyFiniteLimit(plan(), ['max_branches', 'max_users'])).toBe(true);
    });

    it('false when every named column is unlimited or not configured', () => {
      const p = plan({ limit_declarations: { max_branches: 'unlimited' } });
      expect(service.hasAnyFiniteLimit(p, ['max_branches', 'max_customers'])).toBe(false);
    });
  });

  describe('coverage', () => {
    it('tallies finite / unlimited / not-configured across a set of plans for one column', () => {
      const plans = [
        plan({ id: 'a', max_branches: 3 }),
        plan({ id: 'b', max_branches: undefined, limit_declarations: { max_branches: 'unlimited' } }),
        plan({ id: 'c', max_branches: undefined }),
        plan({ id: 'd', max_branches: 5 }),
      ];
      const result = service.coverage(plans, 'max_branches');
      expect(result).toEqual({ finite: 2, unlimited: 1, notConfigured: 1, total: 4 });
    });

    it('an empty plan list reports all zeros', () => {
      expect(service.coverage([], 'max_branches')).toEqual({
        finite: 0,
        unlimited: 0,
        notConfigured: 0,
        total: 0,
      });
    });
  });
});
