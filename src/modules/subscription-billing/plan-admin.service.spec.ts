import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PlanAdminService } from './plan-admin.service';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { ErrorCode } from '../../common/errors';
import {
  createMockAccessCache,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AccessCacheService } from './access-cache.service';

describe('PlanAdminService', () => {
  let service: PlanAdminService;
  let plans: MockRepository;
  let subscriptions: MockRepository;
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };
  let accessCache: ReturnType<typeof createMockAccessCache>;

  const plan = (overrides: Record<string, unknown> = {}) => ({
    id: 'plan-1',
    name: 'Starter',
    price: '99.00',
    billing_cycle: 'MONTHLY',
    max_branches: 1,
    max_users: 5,
    is_active: true,
    is_custom: false,
    ...overrides,
  });

  beforeEach(async () => {
    plans = createMockRepository();
    subscriptions = createMockRepository();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = {
      getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }),
    };
    accessCache = createMockAccessCache();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PlanAdminService,
        { provide: getRepositoryToken(SubscriptionPlan), useValue: plans },
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: TenantContextService, useValue: tenantContext },
        { provide: AccessCacheService, useValue: accessCache },
      ],
    }).compile();
    service = moduleRef.get(PlanAdminService);
  });

  afterEach(() => jest.clearAllMocks());

  it('get throws NOT_FOUND for an unknown plan', async () => {
    plans.findOne.mockResolvedValueOnce(null);
    await expect(service.get('x')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  // FND-015 — plan create/update/activate/deactivate previously wrote NO audit entry.
  describe('FND-015 — audit trail', () => {
    it('audits a successful create', async () => {
      plans.save.mockResolvedValueOnce(plan());
      await service.create({
        name: 'Starter',
        price: 99,
        billingCycle: 'MONTHLY',
      } as any);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.plan.create',
          userId: 'super-admin-1',
          entityType: 'subscription_plan',
          entityId: 'plan-1',
          before: null,
          after: expect.objectContaining({ name: 'Starter', price: '99.00' }),
        }),
      );
    });

    it('audits a successful name/is_active-only update (not in use)', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.count.mockResolvedValueOnce(0); // isInUse → false, but never even checked since no term changes
      plans.save.mockImplementationOnce(async (p: any) => p);

      await service.update('plan-1', { name: 'Starter Plus' } as any);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.plan.update',
          userId: 'super-admin-1',
          entityType: 'subscription_plan',
          entityId: 'plan-1',
          before: expect.objectContaining({ name: 'Starter' }),
          after: expect.objectContaining({ name: 'Starter Plus' }),
        }),
      );
    });

    it('audits a REJECTED term change on an in-use plan (AD-14: refusals recorded too)', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.count.mockResolvedValueOnce(3); // in use

      await expect(
        service.update('plan-1', { price: 199 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.plan.update_rejected',
          userId: 'super-admin-1',
          entityType: 'subscription_plan',
          entityId: 'plan-1',
        }),
      );
      expect(plans.save).not.toHaveBeenCalled();
    });

    it('audits activate and deactivate with distinct action values', async () => {
      plans.findOne.mockResolvedValueOnce(plan({ is_active: false }));
      plans.save.mockImplementationOnce(async (p: any) => p);
      await service.setActive('plan-1', true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.plan.activate',
          before: { isActive: false },
          after: { isActive: true },
        }),
      );

      plans.findOne.mockResolvedValueOnce(plan({ is_active: true }));
      plans.save.mockImplementationOnce(async (p: any) => p);
      await service.setActive('plan-1', false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.plan.deactivate',
          before: { isActive: true },
          after: { isActive: false },
        }),
      );
    });
  });

  // VER-014 (REQ-PLAN-009) — update() only had audit-side coverage; the
  // actual field-patch business logic (the happy path where terms DO change)
  // was untested.
  describe('update (VER-014 — REQ-PLAN-009)', () => {
    it('applies economic-term changes on a plan that is NOT in use (the happy path — only the rejection case had coverage before)', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.count.mockResolvedValueOnce(0); // not in use
      plans.save.mockImplementationOnce(async (p: any) => p);

      const result = await service.update('plan-1', {
        price: 149,
        maxUsers: 10,
      } as any);

      expect(result.price).toBe('149.00');
      expect(result.max_users).toBe(10);
      expect(plans.save).toHaveBeenCalled();
    });

    it('patches EVERY field the DTO declares, leaving unspecified fields untouched', async () => {
      plans.findOne.mockResolvedValueOnce(
        plan({ max_ai_tokens: '1000', max_whatsapp_messages: 500 }),
      );
      subscriptions.count.mockResolvedValueOnce(0);
      plans.save.mockImplementationOnce(async (p: any) => p);

      const result = await service.update('plan-1', {
        maxAiTokens: 5000,
      } as any);

      expect(result.max_ai_tokens).toBe('5000');
      expect(result.max_whatsapp_messages).toBe(500); // untouched
      expect(result.name).toBe('Starter'); // untouched
    });

    it('name/is_active edits on an IN-USE plan are allowed without even checking isInUse (presentational fields are never frozen)', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      plans.save.mockImplementationOnce(async (p: any) => p);

      await service.update('plan-1', { name: 'Renamed' } as any);

      expect(subscriptions.count).not.toHaveBeenCalled();
      expect(plans.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Renamed' }),
      );
    });

    it('a term value IDENTICAL to the current one is not treated as a change — does not trigger the in-use check', async () => {
      plans.findOne.mockResolvedValueOnce(plan({ price: '99.00' }));
      plans.save.mockImplementationOnce(async (p: any) => p);

      await service.update('plan-1', { price: 99 } as any); // same value, just re-sent

      expect(subscriptions.count).not.toHaveBeenCalled();
    });

    it('isInUse counts only non-CANCELLED, non-deleted subscriptions referencing the plan', async () => {
      await service.isInUse('plan-1');
      expect(subscriptions.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ plan: { id: 'plan-1' } }),
        }),
      );
    });
  });

  // Phase 0.2 — limitDeclarations (plan §8)
  describe('limitDeclarations (Phase 0.2)', () => {
    it('create() translates a camelCase DTO key to its snake_case column', async () => {
      plans.save.mockImplementationOnce(async (p: any) => p);

      await service.create({
        name: 'Starter',
        price: 99,
        billingCycle: 'MONTHLY',
        limitDeclarations: { maxBranches: 'unlimited' },
      } as any);

      expect(plans.create).toHaveBeenCalledWith(
        expect.objectContaining({
          limit_declarations: { max_branches: 'unlimited' },
        }),
      );
    });

    it('create() rejects an unknown limitDeclarations key', async () => {
      await expect(
        service.create({
          name: 'Starter',
          price: 99,
          billingCycle: 'MONTHLY',
          limitDeclarations: { notARealField: 'unlimited' },
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(plans.save).not.toHaveBeenCalled();
    });

    it('create() rejects a value other than the literal "unlimited"', async () => {
      await expect(
        service.create({
          name: 'Starter',
          price: 99,
          billingCycle: 'MONTHLY',
          limitDeclarations: { maxBranches: 'infinite' },
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('update() sets limitDeclarations on an IN-USE plan WITHOUT checking isInUse — not a frozen term', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      plans.save.mockImplementationOnce(async (p: any) => p);

      await service.update('plan-1', {
        limitDeclarations: { maxBranches: 'unlimited' },
      } as any);

      expect(subscriptions.count).not.toHaveBeenCalled();
      expect(plans.save).toHaveBeenCalledWith(
        expect.objectContaining({
          limit_declarations: { max_branches: 'unlimited' },
        }),
      );
    });

    it('update() bundling limitDeclarations WITH an actual term change on an in-use plan is still rejected as a whole', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.count.mockResolvedValueOnce(3); // in use

      await expect(
        service.update('plan-1', {
          price: 199,
          limitDeclarations: { maxBranches: 'unlimited' },
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(plans.save).not.toHaveBeenCalled();
    });

    it('update() replaces the full declaration set rather than merging', async () => {
      plans.findOne.mockResolvedValueOnce(
        plan({ limit_declarations: { max_branches: 'unlimited', max_users: 'unlimited' } }),
      );
      plans.save.mockImplementationOnce(async (p: any) => p);

      const result = await service.update('plan-1', {
        limitDeclarations: { maxUsers: 'unlimited' },
      } as any);

      expect(result.limit_declarations).toEqual({ max_users: 'unlimited' });
    });

    it('update() with limitDeclarations: undefined leaves the existing declarations untouched', async () => {
      plans.findOne.mockResolvedValueOnce(
        plan({ limit_declarations: { max_branches: 'unlimited' } }),
      );
      plans.save.mockImplementationOnce(async (p: any) => p);

      const result = await service.update('plan-1', { name: 'Renamed' } as any);

      expect(result.limit_declarations).toEqual({ max_branches: 'unlimited' });
    });

    it('snapshot (audit) includes limitDeclarations', async () => {
      plans.save.mockResolvedValueOnce(
        plan({ limit_declarations: { max_branches: 'unlimited' } }),
      );
      await service.create({
        name: 'Starter',
        price: 99,
        billingCycle: 'MONTHLY',
        limitDeclarations: { maxBranches: 'unlimited' },
      } as any);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          after: expect.objectContaining({
            limitDeclarations: { max_branches: 'unlimited' },
          }),
        }),
      );
    });
  });

  // VER-015 (REQ-PLAN-011) — deactivate must hide the plan from the catalogue
  // WITHOUT affecting existing subscribers (the class's own documented
  // guarantee) — proven here, not assumed.
  describe('deactivate — setActive(false) (VER-015 — REQ-PLAN-011)', () => {
    it('deactivating an IN-USE plan is ALLOWED — unlike a term change, availability is never frozen', async () => {
      plans.findOne.mockResolvedValueOnce(plan({ is_active: true }));
      plans.save.mockImplementationOnce(async (p: any) => p);
      // Deliberately do NOT stub subscriptions.count — if setActive() ever
      // starts consulting isInUse(), this proves it currently does not.

      const result = await service.setActive('plan-1', false);

      expect(result.is_active).toBe(false);
      expect(subscriptions.count).not.toHaveBeenCalled();
    });

    it('deactivating does not touch any OTHER field on the plan (price/limits survive untouched)', async () => {
      plans.findOne.mockResolvedValueOnce(
        plan({ price: '199.00', max_users: 25 }),
      );
      plans.save.mockImplementationOnce(async (p: any) => p);

      const result = await service.setActive('plan-1', false);

      expect(result.price).toBe('199.00');
      expect(result.max_users).toBe(25);
    });

    it('re-activating a deactivated plan (setActive(true)) is the exact mirror operation', async () => {
      plans.findOne.mockResolvedValueOnce(plan({ is_active: false }));
      plans.save.mockImplementationOnce(async (p: any) => p);

      const result = await service.setActive('plan-1', true);

      expect(result.is_active).toBe(true);
    });

    it('throws NOT_FOUND for an unknown plan id — never silently no-ops', async () => {
      plans.findOne.mockResolvedValueOnce(null);
      await expect(
        service.setActive('nonexistent', false),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });
});
