import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UsageService } from './usage.service';
import { AccessControlService } from './access-control.service';
import { TenantUsageLimitOverrideService } from './tenant-usage-limit-override.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { USAGE_METRIC, COUNT_LIMIT } from './usage-metric';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('UsageService', () => {
  let service: UsageService;
  let subscriptions: MockRepository;
  let usageRepo: MockRepository;
  let access: { isEnforced: jest.Mock };
  let limitOverrides: { getActive: jest.Mock; getActiveMap: jest.Mock };

  beforeEach(async () => {
    subscriptions = createMockRepository();
    usageRepo = createMockRepository();
    access = { isEnforced: jest.fn().mockResolvedValue(true) };
    // No active override in any existing scenario — preserves prior behavior.
    limitOverrides = {
      getActive: jest.fn().mockResolvedValue(null),
      getActiveMap: jest.fn().mockResolvedValue(new Map()),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(SubscriptionUsage), useValue: usageRepo },
        { provide: AccessControlService, useValue: access },
        { provide: TenantUsageLimitOverrideService, useValue: limitOverrides },
      ],
    }).compile();
    service = moduleRef.get(UsageService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('increment', () => {
    it('is a no-op for a non-positive amount', async () => {
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 0);
      expect(usageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('is unmetered when enforcement is off (free mode / override)', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 1);
      expect(usageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('silently skips when the tenant has no subscription (best-effort metering)', async () => {
      subscriptions.findOne.mockResolvedValueOnce(null);
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 1);
      expect(usageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('upserts then atomically increments the metric', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1' });
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 2);
      // insert(orIgnore) + update => two query builders
      expect(usageRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });
  });

  describe('assertWithinLimit', () => {
    it('is a no-op when enforcement is off', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      await expect(service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS)).resolves.toBeUndefined();
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });

    it('allows unlimited metrics (null plan limit)', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', plan: { max_appointments: null } });
      await expect(service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS)).resolves.toBeUndefined();
    });

    it('allows when usage stays within the plan limit', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', plan: { max_appointments: 100 } });
      usageRepo.findOne.mockResolvedValueOnce({ appointments_used: 50 });
      await expect(service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS, 10)).resolves.toBeUndefined();
    });

    it('throws 422 when the increment would exceed the limit', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', plan: { max_appointments: 100 } });
      usageRepo.findOne.mockResolvedValueOnce({ appointments_used: 100 });
      await expect(service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS, 1)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('assertCountWithinLimit', () => {
    it('throws 422 when adding would exceed the absolute cap', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', plan: { max_users: 5 } });
      await expect(service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 5)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('allows an unlimited count cap (null)', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', plan: { max_users: null } });
      await expect(service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 999)).resolves.toBeUndefined();
    });
  });

  describe('getUsage / getBreakdown', () => {
    it('returns zeros when no usage row exists', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1' });
      usageRepo.findOne.mockResolvedValueOnce(null);
      const u = await service.getUsage('t1');
      expect(u).toMatchObject({ appointmentsUsed: 0, aiTokensUsed: 0 });
    });

    it('computes remaining and percentUsed per metric', async () => {
      subscriptions.findOne.mockResolvedValue({
        id: 'sub-1',
        plan: { id: 'p1', name: 'Pro', max_appointments: 100, max_ai_tokens: null, max_whatsapp_messages: 50, max_campaigns: 10 },
      });
      usageRepo.findOne.mockResolvedValue({ appointments_used: 25, whatsapp_messages_used: 50, campaigns_used: 0, ai_tokens_used: '0' });
      const b = await service.getBreakdown('t1');
      expect(b.metrics.appointments).toMatchObject({ used: 25, limit: 100, remaining: 75, percentUsed: 25, exceeded: false });
      expect(b.metrics.aiTokens.limit).toBeNull();
      expect(b.metrics.whatsappMessages.remaining).toBe(0);
    });
  });
});
