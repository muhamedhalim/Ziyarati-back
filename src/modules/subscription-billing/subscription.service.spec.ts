import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SubscriptionService } from './subscription.service';
import { BillingService } from './billing.service';
import { AccessControlService } from './access-control.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { BillingCycle, SubscriptionStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 86_400_000);

describe('SubscriptionService', () => {
  let service: SubscriptionService;
  let subscriptions: MockRepository;
  let plans: MockRepository;
  let billing: { generateInvoice: jest.Mock };
  let access: { assertUsable: jest.Mock };

  const plan = (overrides = {}) => ({ id: 'p1', is_active: true, price: 100, billing_cycle: BillingCycle.MONTHLY, ...overrides });

  beforeEach(async () => {
    subscriptions = createMockRepository();
    plans = createMockRepository();
    billing = { generateInvoice: jest.fn().mockResolvedValue(undefined) };
    access = { assertUsable: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(SubscriptionPlan), useValue: plans },
        { provide: BillingService, useValue: billing },
        { provide: AccessControlService, useValue: access },
        {
          provide: SystemSettingService,
          useValue: { getTyped: jest.fn().mockResolvedValue(14) },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(14) } },
      ],
    }).compile();
    service = moduleRef.get(SubscriptionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates a paid subscription and issues the first invoice', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.findOne.mockResolvedValueOnce(null); // no existing
      subscriptions.save.mockResolvedValueOnce({ id: 'sub1' });
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub1', status: SubscriptionStatus.ACTIVE, ends_at: future, plan: plan() });

      const res = await service.create(TENANT, { planId: 'p1' } as any);
      expect(billing.generateInvoice).toHaveBeenCalledWith(TENANT, 'sub1', 100);
      expect(res.isUsable).toBe(true);
    });

    it('does not invoice a trial subscription', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.findOne.mockResolvedValueOnce(null);
      subscriptions.save.mockResolvedValueOnce({ id: 'sub1' });
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub1', status: SubscriptionStatus.TRIAL, ends_at: future, plan: plan() });
      await service.create(TENANT, { planId: 'p1', startTrial: true } as any);
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    });

    it('rejects an inactive plan with 422', async () => {
      plans.findOne.mockResolvedValueOnce(plan({ is_active: false }));
      await expect(service.create(TENANT, { planId: 'p1' } as any)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects when a subscription already exists', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create(TENANT, { planId: 'p1' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  describe('changePlan', () => {
    it('switches plans and invoices the new price', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub1', plan: { id: 'p1' } }); // getActiveSubscription
      plans.findOne.mockResolvedValueOnce(plan({ id: 'p2', price: 200 }));
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub1', status: SubscriptionStatus.ACTIVE, ends_at: future, plan: plan({ id: 'p2' }) });
      await service.changePlan(TENANT, { planId: 'p2' } as any);
      expect(billing.generateInvoice).toHaveBeenCalledWith(TENANT, 'sub1', 200);
    });

    it('rejects changing to the same plan', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub1', plan: { id: 'p1' } });
      await expect(service.changePlan(TENANT, { planId: 'p1' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  describe('cancel / reactivate', () => {
    it('cancels immediately when not at period end', async () => {
      subscriptions.findOne
        .mockResolvedValueOnce({ id: 'sub1', plan: { id: 'p1' }, status: SubscriptionStatus.ACTIVE })
        .mockResolvedValueOnce({ id: 'sub1', status: SubscriptionStatus.CANCELLED, ends_at: future, plan: plan() });
      await service.cancel(TENANT, { cancelAtPeriodEnd: false } as any);
      expect(subscriptions.save).toHaveBeenCalledWith(expect.objectContaining({ status: SubscriptionStatus.CANCELLED }));
    });

    it('reactivate rejects an already-active subscription', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub1', status: SubscriptionStatus.ACTIVE, plan: plan() });
      await expect(service.reactivate(TENANT)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('reactivate renews an expired subscription window', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub1', status: SubscriptionStatus.PAST_DUE, ends_at: past, plan: plan() });
      const res = await service.reactivate(TENANT);
      expect(res.subscription.status).toBe(SubscriptionStatus.ACTIVE);
    });
  });

  describe('getEffectiveStatus / getCurrent', () => {
    // FND-031: the OLD 'EXPIRED' derivation made an active-past-end-date
    // subscription silently unusable forever — no grace, no notice, no path
    // back (the exact "silent lapse" this finding fixes). It now LIVE-derives
    // into PAST_DUE (== expired-in-grace, full capabilities preserved),
    // matching the real "ACTIVE --ends_at reached--> PAST_DUE" transition
    // instead of a separate limbo state.
    it('derives PAST_DUE (not the old EXPIRED limbo) for an active subscription past its end date', () => {
      expect(
        service.getEffectiveStatus({ status: SubscriptionStatus.ACTIVE, ends_at: past } as any),
      ).toBe(SubscriptionStatus.PAST_DUE);
    });

    it('derives GRACE_EXPIRED for a PAST_DUE subscription whose grace window has elapsed', () => {
      const longAgo = new Date(Date.now() - 30 * 86_400_000);
      expect(
        service.getEffectiveStatus({
          status: SubscriptionStatus.PAST_DUE,
          ends_at: past,
          grace_started_at: longAgo,
        } as any, /* graceDurationDays */ 7),
      ).toBe(SubscriptionStatus.GRACE_EXPIRED);
    });

    it('stays PAST_DUE while still within the grace window', () => {
      const justNow = new Date(Date.now() - 60_000);
      expect(
        service.getEffectiveStatus({
          status: SubscriptionStatus.PAST_DUE,
          ends_at: past,
          grace_started_at: justNow,
        } as any, 7),
      ).toBe(SubscriptionStatus.PAST_DUE);
    });

    it('getCurrent throws when there is no subscription', async () => {
      subscriptions.findOne.mockResolvedValueOnce(null);
      await expect(service.getCurrent(TENANT)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('assertUsable delegates to AccessControlService', async () => {
      await service.assertUsable(TENANT);
      expect(access.assertUsable).toHaveBeenCalledWith(TENANT);
    });

    // FR-B007d: read access (isUsable) is preserved in EVERY non-terminal
    // state, including grace-expired — only CANCELLED/SUSPENDED are not usable.
    it.each([
      [SubscriptionStatus.ACTIVE, true],
      [SubscriptionStatus.TRIAL, true],
      [SubscriptionStatus.PAST_DUE, true],
      [SubscriptionStatus.GRACE_EXPIRED, true],
      [SubscriptionStatus.CANCELLED, false],
      [SubscriptionStatus.SUSPENDED, false],
    ])('isUsable(%s) === %s (read access preserved through grace)', (status, expected) => {
      expect(
        service.isUsable({ status, ends_at: future } as any),
      ).toBe(expected);
    });
  });

  describe('assertBillableActionAllowed (FND-031/T082)', () => {
    it('refuses a billable/usage-increasing action once grace-expired', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub1',
        status: SubscriptionStatus.GRACE_EXPIRED,
        ends_at: past,
        plan: plan(),
      });
      await expect(service.assertBillableActionAllowed(TENANT)).rejects.toMatchObject({
        code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
      });
    });

    it('allows a billable action during expired-in-grace (PAST_DUE) — full capabilities unchanged', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub1',
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: new Date(),
        plan: plan(),
      });
      await expect(service.assertBillableActionAllowed(TENANT)).resolves.toBeUndefined();
    });

    it('allows a billable action for an active subscription', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
        plan: plan(),
      });
      await expect(service.assertBillableActionAllowed(TENANT)).resolves.toBeUndefined();
    });
  });
});
