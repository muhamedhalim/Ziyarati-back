import { FeatureResolverService } from './feature-resolver.service';
import { AccessControlService } from './access-control.service';
import { SubscriptionService } from './subscription.service';
import { UsageService } from './usage.service';
import { FeatureKey } from './feature-registry';
import {
  AccessSource,
  QuotaPolicy,
  TenantAccessDecision,
} from './tenant-access-decision';
import { FeatureFlagSource } from '../../entities/SaaS-Core/FeatureFlag';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const def = (key: FeatureKey, over: Record<string, unknown> = {}) => ({
  feature_key: key,
  name: key,
  category: 'Test',
  description: null,
  visibility: 'public',
  is_beta: false,
  is_deprecated: false,
  default_enabled: false,
  usage_metric: null,
  ...over,
});

const allowed = (
  key: FeatureKey,
  over: Partial<TenantAccessDecision> = {},
): TenantAccessDecision => ({
  allowed: true,
  tenantId: 't1',
  featureKey: key,
  source: AccessSource.FEATURE_OVERRIDE,
  quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
  ...over,
});

const refused = (key: FeatureKey): TenantAccessDecision => ({
  allowed: false,
  tenantId: 't1',
  featureKey: key,
  source: AccessSource.DENIED,
  quotaPolicy: QuotaPolicy.BLOCKED,
  reason: 'No active subscription',
});

const BASE_DENIED: TenantAccessDecision = {
  allowed: false,
  tenantId: 't1',
  featureKey: null,
  source: AccessSource.DENIED,
  quotaPolicy: QuotaPolicy.BLOCKED,
};

/**
 * The resolver is the PRESENTATION view of the policy. Its job is to report
 * what `AccessControlService` decided — never to decide anything itself.
 *
 * Historically it ran its own chain (calling `resolveAccess` WITHOUT a feature
 * key, then hand-rescuing per-feature overrides), which is exactly the
 * duplicated entitlement logic that let route gating and the effective-feature
 * view drift apart. These tests pin the composition.
 */
describe('FeatureResolverService.resolveTenant', () => {
  let resolver: FeatureResolverService;
  let definitions: MockRepository;
  let flags: MockRepository;
  let featurePlans: MockRepository;
  let dependencies: MockRepository;
  let access: { resolveAll: jest.Mock; resolve: jest.Mock };
  let subscriptions: { getCurrent: jest.Mock };
  let usage: { getBreakdown: jest.Mock };

  beforeEach(() => {
    definitions = createMockRepository();
    flags = createMockRepository();
    featurePlans = createMockRepository();
    dependencies = createMockRepository();

    definitions.find.mockResolvedValue([
      def(FeatureKey.WHATSAPP),
      def(FeatureKey.CAMPAIGNS),
    ]);
    flags.find.mockResolvedValue([]);
    featurePlans.find.mockResolvedValue([]);
    dependencies.find.mockResolvedValue([]);

    access = {
      resolveAll: jest.fn().mockResolvedValue(new Map()),
      resolve: jest.fn().mockResolvedValue(BASE_DENIED),
    };
    subscriptions = {
      getCurrent: jest.fn().mockRejectedValue(new Error('none')),
    };
    usage = { getBreakdown: jest.fn().mockRejectedValue(new Error('none')) };

    resolver = new FeatureResolverService(
      definitions as never,
      flags as never,
      featurePlans as never,
      dependencies as never,
      access as unknown as AccessControlService,
      subscriptions as unknown as SubscriptionService,
      usage as unknown as UsageService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  const featureFor = async (key: FeatureKey) => {
    const { features } = await resolver.resolveTenant('t1');
    return features.find((f) => f.featureKey === key)!;
  };

  it('reports `available` verbatim from the policy', async () => {
    access.resolveAll.mockResolvedValue(
      new Map([
        [FeatureKey.WHATSAPP, allowed(FeatureKey.WHATSAPP)],
        [FeatureKey.CAMPAIGNS, refused(FeatureKey.CAMPAIGNS)],
      ]),
    );

    expect((await featureFor(FeatureKey.WHATSAPP)).available).toBe(true);
    expect((await featureFor(FeatureKey.CAMPAIGNS)).available).toBe(false);
  });

  it('surfaces the capability that a grant came through', async () => {
    access.resolveAll.mockResolvedValue(
      new Map([
        [
          FeatureKey.WHATSAPP,
          allowed(FeatureKey.WHATSAPP, {
            grantedVia: {
              directly: false,
              viaDependencyOf: FeatureKey.CAMPAIGNS,
            },
          }),
        ],
      ]),
    );
    expect((await featureFor(FeatureKey.WHATSAPP)).grantedVia).toBe(
      FeatureKey.CAMPAIGNS,
    );
  });

  it('shows only AUTHORITATIVE rows as overrides', async () => {
    // A tenant-written row grants nothing, so presenting it as an override
    // would tell an operator the clinic had been given something it had not.
    flags.find.mockResolvedValue([
      {
        feature_key: FeatureKey.WHATSAPP,
        is_enabled: true,
        is_suspended: false,
        source: FeatureFlagSource.TENANT,
      },
      {
        feature_key: FeatureKey.CAMPAIGNS,
        is_enabled: true,
        is_suspended: false,
        source: FeatureFlagSource.PLATFORM_ADMIN,
      },
    ]);
    access.resolveAll.mockResolvedValue(
      new Map([
        [FeatureKey.WHATSAPP, refused(FeatureKey.WHATSAPP)],
        [FeatureKey.CAMPAIGNS, allowed(FeatureKey.CAMPAIGNS)],
      ]),
    );

    expect((await featureFor(FeatureKey.WHATSAPP)).override).toBeNull();
    expect((await featureFor(FeatureKey.WHATSAPP)).overrideSource).toBe(
      FeatureFlagSource.TENANT,
    );
    expect((await featureFor(FeatureKey.CAMPAIGNS)).override).toBe(true);
  });

  describe('adminState — the Super Admin three-way control', () => {
    /**
     * `enabled` is `override ?? default_enabled`, so it reports `true` for a
     * default-on capability nobody has granted. The console bound its toggle to
     * that field, which is how a clinic could be shown "Branches: on" while
     * `feature_flags` held no row and every branch route answered
     * NO_ACTIVE_SUBSCRIPTION. `adminState` is the field that can tell the two
     * apart, and it is what the console binds to now.
     */
    it('reports `inherit` for a DEFAULT-ON capability with no grant', async () => {
      definitions.find.mockResolvedValue([
        def(FeatureKey.WHATSAPP, { default_enabled: true }),
      ]);
      access.resolveAll.mockResolvedValue(
        new Map([[FeatureKey.WHATSAPP, refused(FeatureKey.WHATSAPP)]]),
      );

      const row = await featureFor(FeatureKey.WHATSAPP);
      expect(row.enabled).toBe(true); // the misleading value…
      expect(row.adminState).toBe('inherit'); // …and the honest one
      expect(row.available).toBe(false);
    });

    it('reports `granted` only for an authoritative enabled row', async () => {
      flags.find.mockResolvedValue([
        {
          feature_key: FeatureKey.WHATSAPP,
          is_enabled: true,
          is_suspended: false,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
        {
          // Same shape, tenant-written — records a preference, grants nothing.
          feature_key: FeatureKey.CAMPAIGNS,
          is_enabled: true,
          is_suspended: false,
          source: FeatureFlagSource.TENANT,
        },
      ]);
      access.resolveAll.mockResolvedValue(
        new Map([[FeatureKey.WHATSAPP, allowed(FeatureKey.WHATSAPP)]]),
      );

      expect((await featureFor(FeatureKey.WHATSAPP)).adminState).toBe(
        'granted',
      );
      expect((await featureFor(FeatureKey.CAMPAIGNS)).adminState).toBe(
        'inherit',
      );
    });

    it('reports `suspended` even when a grant is also stored', async () => {
      // Suspending leaves the grant in place so the prior state survives the
      // block; the reported state must be the one the policy will act on.
      flags.find.mockResolvedValue([
        {
          feature_key: FeatureKey.WHATSAPP,
          is_enabled: true,
          is_suspended: true,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
      ]);
      access.resolveAll.mockResolvedValue(
        new Map([[FeatureKey.WHATSAPP, refused(FeatureKey.WHATSAPP)]]),
      );
      expect((await featureFor(FeatureKey.WHATSAPP)).adminState).toBe(
        'suspended',
      );
    });

    it('flags always-on capabilities so the console can disable the control', async () => {
      definitions.find.mockResolvedValue([
        def(FeatureKey.BILLING),
        def(FeatureKey.WHATSAPP),
      ]);
      expect((await featureFor(FeatureKey.BILLING)).alwaysOn).toBe(true);
      expect((await featureFor(FeatureKey.WHATSAPP)).alwaysOn).toBe(false);
    });

    it('does not treat an unknown legacy row as always-on', async () => {
      definitions.find.mockResolvedValue([
        { ...def(FeatureKey.WHATSAPP), feature_key: 'legacy.removed' },
      ]);
      const { features } = await resolver.resolveTenant('t1');
      expect(features[0].alwaysOn).toBe(false);
      expect(features[0].adminState).toBe('inherit');
    });
  });

  it('labels a suspension as such, not as a generic subscription problem', async () => {
    flags.find.mockResolvedValue([
      {
        feature_key: FeatureKey.WHATSAPP,
        is_enabled: true,
        is_suspended: true,
        source: FeatureFlagSource.PLATFORM_ADMIN,
      },
    ]);
    access.resolveAll.mockResolvedValue(
      new Map([[FeatureKey.WHATSAPP, refused(FeatureKey.WHATSAPP)]]),
    );

    const row = await featureFor(FeatureKey.WHATSAPP);
    expect(row.suspended).toBe(true);
    expect(row.blockedReason).toBe('suspended');
  });

  it('reports subscription_inactive when the tenant simply has no access', async () => {
    definitions.find.mockResolvedValue([
      def(FeatureKey.WHATSAPP, { default_enabled: true }),
    ]);
    access.resolveAll.mockResolvedValue(
      new Map([[FeatureKey.WHATSAPP, refused(FeatureKey.WHATSAPP)]]),
    );
    expect((await featureFor(FeatureKey.WHATSAPP)).blockedReason).toBe(
      'subscription_inactive',
    );
  });

  it('treats a dependency as satisfied when the POLICY grants it', async () => {
    // Judging dependencies from raw catalog state (as this used to) reported
    // them missing for tenants who in fact held them through a grant closure.
    dependencies.find.mockResolvedValue([
      { feature_key: FeatureKey.CAMPAIGNS, requires_key: FeatureKey.WHATSAPP },
    ]);
    access.resolveAll.mockResolvedValue(
      new Map([
        [FeatureKey.WHATSAPP, allowed(FeatureKey.WHATSAPP)],
        [FeatureKey.CAMPAIGNS, allowed(FeatureKey.CAMPAIGNS)],
      ]),
    );

    const row = await featureFor(FeatureKey.CAMPAIGNS);
    expect(row.dependenciesSatisfied).toBe(true);
    expect(row.missingDependencies).toEqual([]);
  });

  it('reports a dependency the policy refuses as missing', async () => {
    dependencies.find.mockResolvedValue([
      { feature_key: FeatureKey.CAMPAIGNS, requires_key: FeatureKey.WHATSAPP },
    ]);
    access.resolveAll.mockResolvedValue(
      new Map([
        [FeatureKey.WHATSAPP, refused(FeatureKey.WHATSAPP)],
        [FeatureKey.CAMPAIGNS, refused(FeatureKey.CAMPAIGNS)],
      ]),
    );

    const row = await featureFor(FeatureKey.CAMPAIGNS);
    expect(row.missingDependencies).toEqual([FeatureKey.WHATSAPP]);
  });

  it('fails closed for a catalog row with no registry entry', async () => {
    definitions.find.mockResolvedValue([def('legacy.key' as FeatureKey)]);
    access.resolveAll.mockResolvedValue(new Map());

    const { features } = await resolver.resolveTenant('t1');
    expect(features[0].available).toBe(false);
  });

  describe('subscription summary', () => {
    it('derives enforcement from the quota policy', async () => {
      access.resolve.mockResolvedValue({
        ...BASE_DENIED,
        allowed: true,
        source: AccessSource.ACTIVE_SUBSCRIPTION,
        quotaPolicy: QuotaPolicy.PLAN_ENFORCED,
        planId: 'plan-1',
      });
      const { subscription } = await resolver.resolveTenant('t1');
      expect(subscription.enforced).toBe(true);
      expect(subscription.planId).toBe('plan-1');
    });

    it('reports FREE for a free platform instead of NONE', async () => {
      // The previous version compared the uppercase member NAMES against the
      // lowercase enum values, so both branches were dead and every
      // subscription-less tenant reported NONE.
      access.resolve.mockResolvedValue({
        ...BASE_DENIED,
        allowed: true,
        source: AccessSource.PLATFORM_FREE_MODE,
        quotaPolicy: QuotaPolicy.UNMETERED_PLATFORM_FREE,
      });
      const { subscription } = await resolver.resolveTenant('t1');
      expect(subscription.status).toBe('FREE');
      expect(subscription.enforced).toBe(false);
    });

    it('reports OVERRIDE for a tenant-wide admin grant', async () => {
      access.resolve.mockResolvedValue({
        ...BASE_DENIED,
        allowed: true,
        source: AccessSource.ADMIN_FREE_ACCESS,
        quotaPolicy: QuotaPolicy.UNMETERED_ADMIN_GRANT,
      });
      const { subscription } = await resolver.resolveTenant('t1');
      expect(subscription.status).toBe('OVERRIDE');
    });
  });
});
