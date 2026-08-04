import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PlanAdminService } from './plan-admin.service';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

describe('PlanAdminService', () => {
  let service: PlanAdminService;
  let plans: MockRepository;
  let subscriptions: MockRepository;
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };

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
    tenantContext = { getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PlanAdminService,
        { provide: getRepositoryToken(SubscriptionPlan), useValue: plans },
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(PlanAdminService);
  });

  afterEach(() => jest.clearAllMocks());

  it('get throws NOT_FOUND for an unknown plan', async () => {
    plans.findOne.mockResolvedValueOnce(null);
    await expect(service.get('x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  // FND-015 — plan create/update/activate/deactivate previously wrote NO audit entry.
  describe('FND-015 — audit trail', () => {
    it('audits a successful create', async () => {
      plans.save.mockResolvedValueOnce(plan());
      await service.create({ name: 'Starter', price: 99, billingCycle: 'MONTHLY' } as any);

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
});
