import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccessControlService } from './access-control.service';
import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { FeatureFlagService, FlagState } from './feature-flag.service';
import { FeatureKey } from './feature-registry';
import { AccessSource, QuotaPolicy } from './tenant-access-decision';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureFlagSource } from '../../entities/SaaS-Core/FeatureFlag';
import { SubscriptionStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

/** An authoritative (super-admin) grant for `keys`. */
function granted(...keys: FeatureKey[]): Map<string, FlagState> {
  return new Map(
    keys.map((k) => [
      k,
      {
        granted: true,
        suspended: false,
        source: FeatureFlagSource.PLATFORM_ADMIN,
      },
    ]),
  );
}

describe('AccessControlService', () => {
  let service: AccessControlService;
  let subscriptions: MockRepository;
  let definitions: MockRepository;
  let featurePlans: MockRepository;
  let billingMode: { isPaidMode: jest.Mock };
  let overrides: { getActive: jest.Mock; hasActive: jest.Mock };
  let featureFlags: { getStates: jest.Mock };

  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  const justNow = new Date(Date.now() - 60_000);

  const activeSub = {
    id: 'sub-1',
    status: SubscriptionStatus.ACTIVE,
    ends_at: future,
    plan: { id: 'plan-1' },
  };

  beforeEach(async () => {
    subscriptions = createMockRepository();
    definitions = createMockRepository();
    featurePlans = createMockRepository();
    billingMode = { isPaidMode: jest.fn() };
    overrides = { getActive: jest.fn(), hasActive: jest.fn() };
    featureFlags = { getStates: jest.fn() };

    // Defaults: nothing configured. Individual tests override.
    definitions.find.mockResolvedValue([]);
    featurePlans.find.mockResolvedValue([]);
    featureFlags.getStates.mockResolvedValue(new Map());
    subscriptions.findOne.mockResolvedValue(null);
    overrides.getActive.mockResolvedValue(null);
    overrides.hasActive.mockResolvedValue(false);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AccessControlService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        {
          provide: getRepositoryToken(FeatureDefinition),
          useValue: definitions,
        },
        { provide: getRepositoryToken(FeaturePlan), useValue: featurePlans },
        { provide: BillingModeService, useValue: billingMode },
        { provide: FreeAccessOverrideService, useValue: overrides },
        { provide: FeatureFlagService, useValue: featureFlags },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(7) },
        },
      ],
    }).compile();
    service = moduleRef.get(AccessControlService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─────────────────────── Tenant-wide precedence ────────────────────────

  describe('precedence chain (tenant-wide)', () => {
    it('FREE mode allows everyone and never reads the subscription', async () => {
      billingMode.isPaidMode.mockResolvedValue(false);
      const d = await service.resolve('t1');
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.PLATFORM_FREE_MODE);
      expect(d.quotaPolicy).toBe(QuotaPolicy.UNMETERED_PLATFORM_FREE);
      expect(overrides.getActive).not.toHaveBeenCalled();
    });

    it('an active admin free-access grant outranks the paid check', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      overrides.getActive.mockResolvedValue({ ends_at: future });
      const d = await service.resolve('t1');
      expect(d.source).toBe(AccessSource.ADMIN_FREE_ACCESS);
      expect(d.quotaPolicy).toBe(QuotaPolicy.UNMETERED_ADMIN_GRANT);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });

    it('a usable subscription grants access, carrying plan and quota policy', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue(activeSub);
      const d = await service.resolve('t1');
      expect(d.source).toBe(AccessSource.ACTIVE_SUBSCRIPTION);
      expect(d.subscriptionId).toBe('sub-1');
      expect(d.planId).toBe('plan-1');
      expect(d.quotaPolicy).toBe(QuotaPolicy.PLAN_ENFORCED);
    });

    it('denies when paid with no override and no subscription', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      const d = await service.resolve('t1');
      expect(d.allowed).toBe(false);
      expect(d.source).toBe(AccessSource.DENIED);
      expect(d.quotaPolicy).toBe(QuotaPolicy.BLOCKED);
      // A tenant-wide question must never consult per-feature grants — a
      // feature override is not a substitute for a subscription.
      expect(featureFlags.getStates).not.toHaveBeenCalled();
    });

    // FND-031: this used to deny outright — that WAS the "silent lapse" bug.
    it('an ACTIVE subscription past its end date is expired-in-grace, not denied', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({ ...activeSub, ends_at: past });
      const d = await service.resolve('t1');
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.ACTIVE_SUBSCRIPTION);
    });

    it('a PAST_DUE subscription within its grace window is fully usable', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({
        ...activeSub,
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: justNow,
      });
      expect((await service.resolve('t1')).allowed).toBe(true);
    });

    // FR-B007d: reads survive grace expiry; only isBillableAllowed refuses.
    it('a GRACE_EXPIRED subscription still has read access', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({
        ...activeSub,
        status: SubscriptionStatus.GRACE_EXPIRED,
        ends_at: past,
        grace_started_at: longAgo,
      });
      expect((await service.resolve('t1')).allowed).toBe(true);
    });

    it('CANCELLED remains denied (terminal)', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({
        ...activeSub,
        status: SubscriptionStatus.CANCELLED,
        ends_at: past,
      });
      expect((await service.resolve('t1')).allowed).toBe(false);
    });
  });

  // ────────────────────── Per-feature administrative grant ────────────────

  describe('feature override (super-admin, no subscription)', () => {
    beforeEach(() => billingMode.isPaidMode.mockResolvedValue(true));

    it('grants the toggled capability despite no subscription', async () => {
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));
      const d = await service.resolve('t1', FeatureKey.WHATSAPP);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.FEATURE_OVERRIDE);
      expect(d.quotaPolicy).toBe(QuotaPolicy.UNMETERED_BY_PLAN);
      expect(d.grantedVia).toEqual({ directly: true });
    });

    it('grants the dependency closure so the capability actually works', async () => {
      // The user-facing requirement: "WhatsApp override = enabled → WhatsApp
      // works end-to-end". The inbox reads conversations and customer records,
      // both of which used to return NO_ACTIVE_SUBSCRIPTION.
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));

      for (const dep of [FeatureKey.CONVERSATIONS, FeatureKey.CRM]) {
        const d = await service.resolve('t1', dep);
        expect(d.allowed).toBe(true);
        expect(d.source).toBe(AccessSource.FEATURE_OVERRIDE);
        expect(d.grantedVia).toEqual({
          directly: false,
          viaDependencyOf: FeatureKey.WHATSAPP,
        });
      }
    });

    it('does NOT leak to unrelated capabilities', async () => {
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));
      for (const other of [
        FeatureKey.CAMPAIGNS,
        FeatureKey.PAYMENTS,
        FeatureKey.AI_ASSISTANT,
      ]) {
        expect((await service.resolve('t1', other)).allowed).toBe(false);
      }
    });

    it('opens exactly the capabilities named by multiple overrides', async () => {
      featureFlags.getStates.mockResolvedValue(
        granted(FeatureKey.WHATSAPP, FeatureKey.AI_ASSISTANT),
      );
      expect((await service.resolve('t1', FeatureKey.WHATSAPP)).allowed).toBe(
        true,
      );
      expect(
        (await service.resolve('t1', FeatureKey.AI_ASSISTANT)).allowed,
      ).toBe(true);
      expect((await service.resolve('t1', FeatureKey.CAMPAIGNS)).allowed).toBe(
        false,
      );
    });

    it('a tenant-written row grants NOTHING', async () => {
      // The paid-plan bypass: `featureflag.manage` is delegable into a tenant
      // custom role, so a clinic could write its own grant. Provenance is what
      // stops that row from meaning anything.
      featureFlags.getStates.mockResolvedValue(
        new Map([
          [
            FeatureKey.WHATSAPP,
            {
              granted: false,
              suspended: false,
              source: FeatureFlagSource.TENANT,
            },
          ],
        ]),
      );
      const d = await service.resolve('t1', FeatureKey.WHATSAPP);
      expect(d.allowed).toBe(false);
    });

    it('an absent row denies (no row is not a grant)', async () => {
      expect((await service.resolve('t1', FeatureKey.WHATSAPP)).allowed).toBe(
        false,
      );
    });

    it('an unknown key fails closed rather than throwing', async () => {
      const d = await service.resolve('t1', 'not-a-feature' as FeatureKey);
      expect(d.allowed).toBe(false);
      expect(d.source).toBe(AccessSource.DENIED);
    });
  });

  // ─────────────────────────── Suspension ────────────────────────────────

  describe('administrative suspension', () => {
    const suspended = new Map<string, FlagState>([
      [
        FeatureKey.WHATSAPP,
        {
          granted: true,
          suspended: true,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
      ],
    ]);

    it('outranks a paid subscription', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue(activeSub);
      featureFlags.getStates.mockResolvedValue(suspended);
      const d = await service.resolve('t1', FeatureKey.WHATSAPP);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/suspended/i);
    });

    it('outranks platform FREE mode (it is an incident kill-switch)', async () => {
      billingMode.isPaidMode.mockResolvedValue(false);
      featureFlags.getStates.mockResolvedValue(suspended);
      expect((await service.resolve('t1', FeatureKey.WHATSAPP)).allowed).toBe(
        false,
      );
    });

    it('is scoped to the suspended capability only', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue(activeSub);
      featureFlags.getStates.mockResolvedValue(suspended);
      expect((await service.resolve('t1', FeatureKey.CRM)).allowed).toBe(true);
    });

    it('cannot lock a tenant out of billing (always-on capabilities)', async () => {
      // Otherwise a suspension would leave the clinic with no route back to a
      // subscription — a denial with no recovery path.
      billingMode.isPaidMode.mockResolvedValue(true);
      featureFlags.getStates.mockResolvedValue(
        new Map([
          [
            FeatureKey.BILLING,
            {
              granted: false,
              suspended: true,
              source: FeatureFlagSource.PLATFORM_ADMIN,
            },
          ],
        ]),
      );
      expect((await service.resolve('t1', FeatureKey.BILLING)).allowed).toBe(
        true,
      );
    });
  });

  // ───────────────────────── Plan entitlement ────────────────────────────

  describe('plan entitlement', () => {
    beforeEach(() => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue(activeSub);
    });

    it('allows a capability with no plan restriction rows (available on all plans)', async () => {
      expect((await service.resolve('t1', FeatureKey.CRM)).allowed).toBe(true);
    });

    it('allows a capability the current plan is listed for', async () => {
      featurePlans.find.mockResolvedValue([
        { feature_key: FeatureKey.CAMPAIGNS, plan_id: 'plan-1' },
      ]);
      // `campaigns` is default-off, so an explicit grant switches it on; plan
      // inclusion is the separate question under test here.
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.CAMPAIGNS));
      const d = await service.resolve('t1', FeatureKey.CAMPAIGNS);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.ACTIVE_SUBSCRIPTION);
    });

    it('refuses a capability restricted to a different plan', async () => {
      featurePlans.find.mockResolvedValue([
        { feature_key: FeatureKey.CRM, plan_id: 'plan-OTHER' },
      ]);
      expect((await service.resolve('t1', FeatureKey.CRM)).allowed).toBe(false);
    });

    it('lets a super-admin grant cover a capability the plan excludes', async () => {
      featurePlans.find.mockResolvedValue([
        { feature_key: FeatureKey.CRM, plan_id: 'plan-OTHER' },
      ]);
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.CRM));
      const d = await service.resolve('t1', FeatureKey.CRM);
      expect(d.allowed).toBe(true);
      expect(d.source).toBe(AccessSource.FEATURE_OVERRIDE);
    });

    it('honours a catalog default of OFF for a paying tenant', async () => {
      definitions.find.mockResolvedValue([
        { feature_key: FeatureKey.CAMPAIGNS, default_enabled: false },
      ]);
      expect((await service.resolve('t1', FeatureKey.CAMPAIGNS)).allowed).toBe(
        false,
      );
    });
  });

  // ─────────────────────────── resolveAll ────────────────────────────────

  describe('resolveAll', () => {
    it('answers for every registry key from one set of reads', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));

      const all = await service.resolveAll('t1');

      expect(all.get(FeatureKey.WHATSAPP)?.allowed).toBe(true);
      expect(all.get(FeatureKey.CONVERSATIONS)?.allowed).toBe(true); // closure
      expect(all.get(FeatureKey.CAMPAIGNS)?.allowed).toBe(false);
      // One round of reads for the whole catalog, not one per key.
      expect(subscriptions.findOne).toHaveBeenCalledTimes(1);
      expect(definitions.find).toHaveBeenCalledTimes(1);
      expect(featurePlans.find).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────── isBillableAllowed (narrow gate) ──────────────────

  describe('isBillableAllowed (FND-031/T082)', () => {
    it('refuses once grace-expired (live-derived from an elapsed window)', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({
        ...activeSub,
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: longAgo,
      });
      expect(await service.isBillableAllowed('t1')).toBe(false);
    });

    it('refuses once the status column already says GRACE_EXPIRED', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({
        ...activeSub,
        status: SubscriptionStatus.GRACE_EXPIRED,
        ends_at: past,
      });
      expect(await service.isBillableAllowed('t1')).toBe(false);
    });

    it('allows during expired-in-grace — full capabilities unchanged', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({
        ...activeSub,
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: justNow,
      });
      expect(await service.isBillableAllowed('t1')).toBe(true);
    });

    it('allows for an active subscription', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue(activeSub);
      expect(await service.isBillableAllowed('t1')).toBe(true);
    });

    it('allows unconditionally under free mode and under an admin grant', async () => {
      billingMode.isPaidMode.mockResolvedValue(false);
      expect(await service.isBillableAllowed('t1')).toBe(true);

      billingMode.isPaidMode.mockResolvedValue(true);
      overrides.hasActive.mockResolvedValue(true);
      expect(await service.isBillableAllowed('t1')).toBe(true);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────── assertAccess ─────────────────────────────

  describe('assertAccess', () => {
    it('returns the decision when access is allowed', async () => {
      billingMode.isPaidMode.mockResolvedValue(false);
      await expect(service.assertAccess('t1')).resolves.toMatchObject({
        allowed: true,
      });
    });

    it('throws NO_ACTIVE_SUBSCRIPTION when denied', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      await expect(service.assertAccess('t1')).rejects.toMatchObject({
        code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
      });
    });

    it('passes for a capability held only through a super-admin grant', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      featureFlags.getStates.mockResolvedValue(
        granted(FeatureKey.AI_ASSISTANT),
      );
      await expect(
        service.assertAccess('t1', FeatureKey.AI_ASSISTANT),
      ).resolves.toMatchObject({ source: AccessSource.FEATURE_OVERRIDE });
    });

    it('never leaks the technical reason to the client', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue({
        ...activeSub,
        status: SubscriptionStatus.CANCELLED,
      });
      await expect(service.assertAccess('t1')).rejects.toMatchObject({
        // `publicContext` carries only the source; the status-naming reason
        // stays server-side in `internalContext`.
        publicContext: { source: AccessSource.DENIED },
      });
    });
  });

  // ───────────────────────────── isEnforced ──────────────────────────────

  describe('isEnforced', () => {
    it('is false under free mode and under an admin free-access grant', async () => {
      billingMode.isPaidMode.mockResolvedValue(false);
      expect(await service.isEnforced('t1')).toBe(false);

      billingMode.isPaidMode.mockResolvedValue(true);
      overrides.hasActive.mockResolvedValue(true);
      expect(await service.isEnforced('t1')).toBe(false);
    });

    it('is true in paid mode with no override', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      expect(await service.isEnforced('t1')).toBe(true);
    });

    /**
     * The 2026-08-13 regression: `POST /whatsapp/templates/:id/send` failed
     * with "No active subscription found for this tenant" — the guard admitted
     * the tenant via a feature override while the usage layer re-derived
     * enforcement without the feature and demanded a subscription.
     */
    it('is NOT enforced when a per-feature grant is what admitted the tenant', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));
      expect(
        await service.isEnforced('t1', undefined, [FeatureKey.WHATSAPP]),
      ).toBe(false);
    });

    it('STAYS enforced for a paying tenant whose flag is also on', async () => {
      // Otherwise enabling a flag would silently unmeter every payer.
      billingMode.isPaidMode.mockResolvedValue(true);
      subscriptions.findOne.mockResolvedValue(activeSub);
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));
      expect(
        await service.isEnforced('t1', undefined, [FeatureKey.WHATSAPP]),
      ).toBe(true);
    });

    it('does not let a grant for one capability unmeter another', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));
      expect(
        await service.isEnforced('t1', undefined, [FeatureKey.CAMPAIGNS]),
      ).toBe(true);
    });

    it('fails closed: denied tenants stay enforced', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      expect(
        await service.isEnforced('t1', undefined, [FeatureKey.WHATSAPP]),
      ).toBe(true);
    });

    /**
     * FND-047: reached from inside `UsageService.incrementIfWithinLimit`'s open
     * transaction, every nested read must reuse that connection instead of
     * borrowing a second one from the pool — the mechanism behind the FND-047
     * concurrency hang.
     */
    it('threads a supplied manager through every nested read', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      const managerRepo = createMockRepository();
      managerRepo.findOne.mockResolvedValue(null);
      managerRepo.find.mockResolvedValue([]);
      const manager = {
        getRepository: jest.fn().mockReturnValue(managerRepo),
      } as never;
      featureFlags.getStates.mockResolvedValue(granted(FeatureKey.WHATSAPP));

      expect(
        await service.isEnforced('t1', manager, [FeatureKey.WHATSAPP]),
      ).toBe(false);

      expect(billingMode.isPaidMode).toHaveBeenCalledWith(manager);
      expect(managerRepo.findOne).toHaveBeenCalled();
      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(featureFlags.getStates).toHaveBeenCalledWith('t1', manager);
    });

    it('skips the subscription read entirely on the tenant-wide fast path', async () => {
      billingMode.isPaidMode.mockResolvedValue(true);
      await service.isEnforced('t1');
      // PlatformUsageService calls this once PER TENANT across a listing.
      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(featureFlags.getStates).not.toHaveBeenCalled();
    });
  });
});
