import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccessControlService } from './access-control.service';
import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { FeatureFlagService } from './feature-flag.service';
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
  let featureFlags: { isEnabled: jest.Mock };

  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  const justNow = new Date(Date.now() - 60_000);

  beforeEach(async () => {
    subscriptions = createMockRepository();
    billingMode = { isPaidMode: jest.fn() };
    overrides = { getActive: jest.fn(), hasActive: jest.fn() };
    featureFlags = { isEnabled: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AccessControlService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: BillingModeService, useValue: billingMode },
        { provide: FreeAccessOverrideService, useValue: overrides },
        { provide: FeatureFlagService, useValue: featureFlags },
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
      // No featureKey was passed, so step 4 never even consults the flag store.
      expect(featureFlags.isEnabled).not.toHaveBeenCalled();
    });

    // Feature Flags (Platform) — Super Admin toggles a tenant-specific
    // `feature_flags` override via /platform/feature-flags even when the
    // clinic has no active subscription. Step 4 must grant access to that
    // ONE route/feature without touching the tenant-wide `allowed`/`source`
    // semantics used everywhere else (e.g. the FeatureFlagService lookup is
    // only ever consulted after steps 1-3 have already failed).
    describe('4) tenant feature-flag override (scoped, evaluated only after subscription fails)', () => {
      it('an enabled tenant override for the route\'s own feature grants access despite no subscription', async () => {
        billingMode.isPaidMode.mockResolvedValueOnce(true);
        overrides.getActive.mockResolvedValueOnce(null);
        subscriptions.findOne.mockResolvedValueOnce(null);
        featureFlags.isEnabled.mockResolvedValueOnce(true);

        const d = await service.resolveAccess('t1', 'ai');
        expect(d.allowed).toBe(true);
        expect(d.source).toBe(AccessSource.FEATURE_OVERRIDE);
        expect(featureFlags.isEnabled).toHaveBeenCalledWith('t1', 'ai', undefined);
      });

      it('a disabled (explicit false) override does NOT grant access — same as no override', async () => {
        billingMode.isPaidMode.mockResolvedValueOnce(true);
        overrides.getActive.mockResolvedValueOnce(null);
        subscriptions.findOne.mockResolvedValueOnce(null);
        featureFlags.isEnabled.mockResolvedValueOnce(false);

        const d = await service.resolveAccess('t1', 'ai');
        expect(d.allowed).toBe(false);
        expect(d.source).toBe(AccessSource.NONE);
      });

      it('no override at all (featureKey unset for the tenant) still denies', async () => {
        billingMode.isPaidMode.mockResolvedValueOnce(true);
        overrides.getActive.mockResolvedValueOnce(null);
        subscriptions.findOne.mockResolvedValueOnce(null);
        featureFlags.isEnabled.mockResolvedValueOnce(false); // no row → default false

        const d = await service.resolveAccess('t1', 'campaigns');
        expect(d.allowed).toBe(false);
      });

      it('an override enabled for a DIFFERENT feature than the one being checked does not leak across', async () => {
        billingMode.isPaidMode.mockResolvedValueOnce(true);
        overrides.getActive.mockResolvedValueOnce(null);
        subscriptions.findOne.mockResolvedValueOnce(null);
        // Tenant has 'ai' overridden, but this call is gating 'campaigns'.
        featureFlags.isEnabled.mockImplementation(
          async (_tenantId: string, key: string) => key === 'ai',
        );

        const d = await service.resolveAccess('t1', 'campaigns');
        expect(d.allowed).toBe(false);
        expect(featureFlags.isEnabled).toHaveBeenCalledWith('t1', 'campaigns', undefined);
      });

      it('an active PAID subscription is granted via step 3 and never even reaches the feature-flag check', async () => {
        billingMode.isPaidMode.mockResolvedValueOnce(true);
        overrides.getActive.mockResolvedValueOnce(null);
        subscriptions.findOne.mockResolvedValueOnce({
          id: 'sub-1', status: SubscriptionStatus.ACTIVE, ends_at: future,
        });

        const d = await service.resolveAccess('t1', 'ai');
        expect(d.allowed).toBe(true);
        expect(d.source).toBe(AccessSource.SUBSCRIPTION);
        expect(featureFlags.isEnabled).not.toHaveBeenCalled();
      });

      it('global FREE mode is granted via step 1 and never reaches the feature-flag check', async () => {
        billingMode.isPaidMode.mockResolvedValueOnce(false);
        const d = await service.resolveAccess('t1', 'ai');
        expect(d.allowed).toBe(true);
        expect(d.source).toBe(AccessSource.PLATFORM_FREE_MODE);
        expect(featureFlags.isEnabled).not.toHaveBeenCalled();
      });
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

    it('throws NO_ACTIVE_SUBSCRIPTION when access is denied', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce(null);
      await expect(service.assertUsable('t1')).rejects.toMatchObject({
        code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
      });
    });

    // Mirrors the SubscriptionAccessGuard call shape: it reads the route's
    // own @RequireFeature() key and passes it straight through here.
    it('passes silently when the route\'s own feature has an enabled tenant override, despite no subscription', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce(null);
      featureFlags.isEnabled.mockResolvedValueOnce(true);
      await expect(service.assertUsable('t1', 'ai')).resolves.toBeUndefined();
    });

    it('still throws NO_ACTIVE_SUBSCRIPTION when the override is disabled/absent for that feature', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.getActive.mockResolvedValueOnce(null);
      subscriptions.findOne.mockResolvedValueOnce(null);
      featureFlags.isEnabled.mockResolvedValueOnce(false);
      await expect(service.assertUsable('t1', 'ai')).rejects.toMatchObject({
        code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
      });
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

    // FND-047: `isEnforced` is called from inside `UsageService.incrementIfWithinLimit`,
    // which may already be running inside a caller's open `dataSource.transaction()`
    // (campaigns, appointments). Without threading that transaction's manager through,
    // this call must borrow a SECOND pool connection while the first is held open —
    // under enough concurrency to saturate the pool with held transactions, that
    // second borrow can never be satisfied (see evidence/fnd-047-fix.md). Passing the
    // manager through makes every nested read reuse the SAME connection.
    it('threads a supplied manager through to billingMode.isPaidMode and overrides.hasActive', async () => {
      const manager = { marker: 'fake-manager' } as any;
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(false);

      expect(await service.isEnforced('t1', manager)).toBe(true);

      expect(billingMode.isPaidMode).toHaveBeenCalledWith(manager);
      expect(overrides.hasActive).toHaveBeenCalledWith('t1', manager);
    });

    it('omits the manager for standalone callers (AI/WhatsApp execution paths — unchanged)', async () => {
      billingMode.isPaidMode.mockResolvedValueOnce(true);
      overrides.hasActive.mockResolvedValueOnce(false);

      expect(await service.isEnforced('t1')).toBe(true);

      expect(billingMode.isPaidMode).toHaveBeenCalledWith(undefined);
      expect(overrides.hasActive).toHaveBeenCalledWith('t1', undefined);
    });
  });

  /**
   * The admin-free-access fix: enforcement is DERIVED from the same decision
   * the route guard used, so a tenant admitted by a super-admin grant is not
   * then required to hold a subscription by the usage layer.
   *
   * Regression origin: `POST /whatsapp/templates/:id/send` 500'd with
   * "No active subscription found for this tenant" — the guard admitted the
   * tenant via FEATURE_OVERRIDE while `isEnforced` (billing-mode + free-override
   * only) still reported `true`.
   */
  describe('isEnforced — feature-scoped access (admin free access)', () => {
    const paidNoFreeOverride = () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      overrides.hasActive.mockResolvedValue(false);
      overrides.getActive.mockResolvedValue(null);
    };

    it('is NOT enforced when a per-feature override is what grants access (no subscription)', async () => {
      paidNoFreeOverride();
      subscriptions.findOne.mockResolvedValueOnce(null); // no subscription at all
      featureFlags.isEnabled.mockResolvedValueOnce(true); // super-admin enabled 'whatsapp'

      expect(await service.isEnforced('t1', undefined, ['whatsapp'])).toBe(false);
    });

    it('STAYS enforced for a paid tenant even when the feature flag is also on (paid behavior preserved)', async () => {
      paidNoFreeOverride();
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
      });
      featureFlags.isEnabled.mockResolvedValue(true);

      // Access came from the SUBSCRIPTION, so its plan quotas still apply —
      // otherwise enabling a feature flag would silently unmeter every payer.
      expect(await service.isEnforced('t1', undefined, ['whatsapp'])).toBe(true);
    });

    it('does not let an override for one feature unmeter a different one', async () => {
      paidNoFreeOverride();
      subscriptions.findOne.mockResolvedValueOnce(null);
      featureFlags.isEnabled.mockResolvedValue(false); // 'appointments' NOT granted

      expect(await service.isEnforced('t1', undefined, ['appointments'])).toBe(true);
      expect(featureFlags.isEnabled).toHaveBeenCalledWith('t1', 'appointments', undefined);
    });

    it('fails closed: no subscription and no override at all stays enforced (denied downstream)', async () => {
      paidNoFreeOverride();
      subscriptions.findOne.mockResolvedValueOnce(null);
      featureFlags.isEnabled.mockResolvedValue(false);

      expect(await service.isEnforced('t1', undefined, ['whatsapp'])).toBe(true);
    });

    it('accepts any of several candidate keys for one metric (e.g. ai / ai.assistant)', async () => {
      paidNoFreeOverride();
      subscriptions.findOne.mockResolvedValueOnce(null);
      // 'ai' absent, but the catalog key 'ai.assistant' is enabled.
      featureFlags.isEnabled
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      expect(await service.isEnforced('t1', undefined, ['ai', 'ai.assistant'])).toBe(false);
    });

    it('threads the manager through the feature-scoped path too (FND-047)', async () => {
      paidNoFreeOverride();
      const managerRepo = createMockRepository();
      managerRepo.findOne.mockResolvedValueOnce(null);
      const manager = { getRepository: jest.fn().mockReturnValue(managerRepo) } as any;
      featureFlags.isEnabled.mockResolvedValueOnce(true);

      expect(await service.isEnforced('t1', manager, ['whatsapp'])).toBe(false);

      expect(billingMode.isPaidMode).toHaveBeenCalledWith(manager);
      // The subscription read went through the transaction's repository, not
      // the injected non-transactional one (FND-047).
      expect(managerRepo.findOne).toHaveBeenCalled();
      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(featureFlags.isEnabled).toHaveBeenCalledWith('t1', 'whatsapp', manager);
    });
  });
});
