import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccessControlService } from './access-control.service';
import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { AccessSource } from './platform-billing.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('AccessControlService', () => {
  let service: AccessControlService;
  let subscriptions: MockRepository;
  let billingMode: { isPaidMode: jest.Mock };
  let overrides: { getActive: jest.Mock; hasActive: jest.Mock };

  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  const justNow = new Date(Date.now() - 60_000);

  beforeEach(async () => {
    subscriptions = createMockRepository();
    billingMode = { isPaidMode: jest.fn() };
    overrides = { getActive: jest.fn(), hasActive: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AccessControlService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: BillingModeService, useValue: billingMode },
        { provide: FreeAccessOverrideService, useValue: overrides },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(7) } },
      ],
    }).compile();
    service = moduleRef.get(AccessControlService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('resolveAccess priority chain', () => {
    it('1) global FREE mode allows everyone', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(false);
      const d = await service.resolveAccess('t1');
      expect(d).toEqual({ allowed: true, source: AccessSource.PLATFORM_FREE_MODE });
      expect(overrides.getActive).not.toHaveBeenCalled();
    });

    it('2) an active free override outranks the paid check', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce({ ends_at: future });
      const d = await service.resolveAccess('t1');
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.FREE_OVERRIDE);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });

    it('3) a usable subscription grants access in paid mode', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', status: SubscriptionStatus.ACTIVE, ends_at: future });
      const d = await service.resolveAccess('t1');
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.SUBSCRIPTION);
      expect(d.subscriptionId).toBe('sub-1');
    });

    it('denies when paid, no override, and no subscription', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce(null);
      const d = await service.resolveAccess('t1');
      expect(d.allowed).toBe(false);
      expect(d.source).toBe(AccessSource.NONE);
    });

    // FND-031: this used to deny outright — that WAS the "silent lapse" bug
    // (an active-past-end-date tenant became unusable forever, with no
    // grace, no notice, no path back). It now live-derives into
    // "expired-in-grace" (== PAST_DUE), which has FULL, unchanged
    // capabilities — corrected here, not weakened; the old assertion
    // encoded the exact defect this finding fixes.
    it('an ACTIVE subscription past its end date live-derives into full expired-in-grace access, not a denial', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', status: SubscriptionStatus.ACTIVE, ends_at: past });
      const d = await service.resolveAccess('t1');
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.SUBSCRIPTION);
    });

    it('a PAST_DUE subscription still WITHIN its grace window is fully usable', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1', status: SubscriptionStatus.PAST_DUE, ends_at: past, grace_started_at: justNow,
      });
      const d = await service.resolveAccess('t1');
      expect(d.allowed).toBe(true);
    });

    // FR-B007d: read access (resolveAccess/assertUsable is the BROAD gate,
    // reads included) is preserved even once grace-expired — only
    // isBillableAllowed (a narrower, write-specific gate) refuses there.
    it('a GRACE_EXPIRED subscription is still "allowed" (read access preserved)', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1', status: SubscriptionStatus.GRACE_EXPIRED, ends_at: past, grace_started_at: longAgo,
      });
      const d = await service.resolveAccess('t1');
      expect(d.allowed).toBe(true);
    });

    it('CANCELLED remains denied (terminal, unchanged)', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', status: SubscriptionStatus.CANCELLED, ends_at: past });
      const d = await service.resolveAccess('t1');
      expect(d.allowed).toBe(false);
    });
  });

  describe('isBillableAllowed (FND-031/T082 — narrow, write-specific gate)', () => {
    it('refuses once grace-expired (live-derived from an elapsed PAST_DUE window)', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(false);
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1', status: SubscriptionStatus.PAST_DUE, ends_at: past, grace_started_at: longAgo,
      });
      expect(await service.isBillableAllowed('t1')).toBe(false);
    });

    it('refuses once the status column already says GRACE_EXPIRED', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(false);
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', status: SubscriptionStatus.GRACE_EXPIRED, ends_at: past });
      expect(await service.isBillableAllowed('t1')).toBe(false);
    });

    it('allows during expired-in-grace (PAST_DUE, still within the window) — full capabilities unchanged', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(false);
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1', status: SubscriptionStatus.PAST_DUE, ends_at: past, grace_started_at: justNow,
      });
      expect(await service.isBillableAllowed('t1')).toBe(true);
    });

    it('allows for an active subscription', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(false);
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1', status: SubscriptionStatus.ACTIVE, ends_at: future });
      expect(await service.isBillableAllowed('t1')).toBe(true);
    });

    it('allows unconditionally under free platform mode', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(false);
      expect(await service.isBillableAllowed('t1')).toBe(true);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });

    it('allows unconditionally under an active free-access override', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(true);
      expect(await service.isBillableAllowed('t1')).toBe(true);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });
  });

  describe('assertUsable', () => {
    it('passes silently when access is allowed', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(false);
      await expect(service.assertUsable('t1')).resolves.toBeUndefined();
    });

    it('throws FORBIDDEN when access is denied', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce(null);
      await expect(service.assertUsable('t1')).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });
  });

  describe('isEnforced', () => {
    it('is false under free mode', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(false);
      expect(await service.isEnforced('t1')).toBe(false);
    });

    it('is false when an override is active', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(true);
      expect(await service.isEnforced('t1')).toBe(false);
    });

    it('is true in paid mode with no override', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(false);
      expect(await service.isEnforced('t1')).toBe(true);
    });
  });
});
