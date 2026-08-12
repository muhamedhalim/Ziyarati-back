import { FeatureResolverService } from './feature-resolver.service';
import { AccessControlService } from './access-control.service';
import { SubscriptionService } from './subscription.service';
import { UsageService } from './usage.service';
import { AccessSource } from './platform-billing.constants';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

/**
 * Platform Feature Flags override vs. no-subscription gate — a super-admin
 * tenant override (`PUT /platform/feature-flags/tenants/:tenantId/features`,
 * stored via FeatureFlagService in the SAME `feature_flags` table this
 * resolver reads via `overrideMap`) used to be silently discarded here: the
 * `available` computation gated on `!access.allowed` BEFORE even looking at
 * the override, so an approved-but-unsubscribed tenant with an explicit
 * enabled override still got `blockedReason: 'subscription_inactive'` — and
 * FeatureGuard (which trusts `available` verbatim) refused the request even
 * after SubscriptionAccessGuard's own broad-gate bypass (see
 * AccessControlService.resolveAccess step 4 / access-control.service.spec.ts).
 * These tests pin the fix at the resolver level, since FeatureGuard is what
 * actually enforces route access using this exact output.
 */
describe('FeatureResolverService.resolveTenant — tenant feature-flag override precedence', () => {
  let resolver: FeatureResolverService;
  let definitions: MockRepository;
  let flags: MockRepository;
  let featurePlans: MockRepository;
  let dependencies: MockRepository;
  let access: { resolveAccess: jest.Mock; isEnforced: jest.Mock };
  let subscriptions: { getCurrent: jest.Mock };
  let usage: { getBreakdown: jest.Mock };

  const AI_DEF = {
    feature_key: 'ai',
    name: 'AI Assistant',
    category: 'AI',
    description: null,
    visibility: 'public',
    is_beta: false,
    is_deprecated: false,
    default_enabled: false,
    usage_metric: null,
  };
  const CAMPAIGNS_DEF = {
    feature_key: 'campaigns',
    name: 'Campaigns',
    category: 'Growth',
    description: null,
    visibility: 'public',
    is_beta: false,
    is_deprecated: false,
    default_enabled: false,
    usage_metric: null,
  };

  const NO_ACCESS = { allowed: false, source: AccessSource.NONE, reason: 'No active subscription' };

  beforeEach(() => {
    definitions = createMockRepository();
    flags = createMockRepository();
    featurePlans = createMockRepository();
    dependencies = createMockRepository();
    access = {
      resolveAccess: jest.fn().mockResolvedValue(NO_ACCESS),
      isEnforced: jest.fn().mockResolvedValue(true),
    };
    subscriptions = { getCurrent: jest.fn().mockRejectedValue(new Error('none')) };
    usage = { getBreakdown: jest.fn().mockRejectedValue(new Error('none')) };

    resolver = new FeatureResolverService(
      definitions as any,
      flags as any,
      featurePlans as any,
      dependencies as any,
      access as unknown as AccessControlService,
      subscriptions as unknown as SubscriptionService,
      usage as unknown as UsageService,
    );

    dependencies.find.mockResolvedValue([]);
    featurePlans.find.mockResolvedValue([]);
  });

  it('an enabled tenant override grants `available: true` despite no active subscription', async () => {
    definitions.find.mockResolvedValueOnce([AI_DEF]);
    flags.find.mockResolvedValueOnce([{ feature_key: 'ai', is_enabled: true }]);

    const { features, subscription } = await resolver.resolveTenant('t1');

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({ featureKey: 'ai', available: true, blockedReason: null, override: true });
    // The tenant-wide subscription summary is untouched — still correctly "inactive".
    expect(subscription.active).toBe(false);
  });

  it('a disabled (explicit false) override does NOT grant access — blocked the same as no override', async () => {
    definitions.find.mockResolvedValueOnce([AI_DEF]);
    flags.find.mockResolvedValueOnce([{ feature_key: 'ai', is_enabled: false }]);

    const { features } = await resolver.resolveTenant('t1');

    expect(features[0]).toMatchObject({ available: false, blockedReason: 'subscription_inactive', override: false });
  });

  it('no override at all still blocks with subscription_inactive (regression guard — unrelated features unaffected)', async () => {
    definitions.find.mockResolvedValueOnce([AI_DEF]);
    flags.find.mockResolvedValueOnce([]); // no row for this tenant/feature

    const { features } = await resolver.resolveTenant('t1');

    expect(features[0]).toMatchObject({ available: false, blockedReason: 'subscription_inactive', override: null });
  });

  it('an override on one feature does not leak availability to a different, non-overridden feature', async () => {
    definitions.find.mockResolvedValueOnce([AI_DEF, CAMPAIGNS_DEF]);
    flags.find.mockResolvedValueOnce([{ feature_key: 'ai', is_enabled: true }]); // only 'ai' overridden

    const { features } = await resolver.resolveTenant('t1');
    const ai = features.find((f) => f.featureKey === 'ai')!;
    const campaigns = features.find((f) => f.featureKey === 'campaigns')!;

    expect(ai.available).toBe(true);
    expect(campaigns.available).toBe(false);
    expect(campaigns.blockedReason).toBe('subscription_inactive');
  });

  it('the override also lifts plan-restriction gating for that feature (no plan exists to check against)', async () => {
    definitions.find.mockResolvedValueOnce([AI_DEF]);
    flags.find.mockResolvedValueOnce([{ feature_key: 'ai', is_enabled: true }]);
    // 'ai' is restricted to a specific plan the tenant (having no subscription) can't have.
    featurePlans.find.mockResolvedValueOnce([{ feature_key: 'ai', plan_id: 'pro-plan' }]);

    const { features } = await resolver.resolveTenant('t1');

    expect(features[0]).toMatchObject({ available: true, planIncluded: true, blockedReason: null });
  });

  it('usage quota enforcement is NOT bypassed by the override — normal limits are preserved', async () => {
    definitions.find.mockResolvedValueOnce([
      { ...AI_DEF, usage_metric: 'AI_TOKENS' },
    ]);
    flags.find.mockResolvedValueOnce([{ feature_key: 'ai', is_enabled: true }]);
    usage.getBreakdown.mockReset().mockResolvedValueOnce({
      planId: null,
      planName: null,
      metrics: {
        aiTokens: { used: 100, limit: 100, remaining: 0, percentUsed: 100, exceeded: true },
        whatsappMessages: { used: 0, limit: null, remaining: null, percentUsed: null, exceeded: false },
        appointments: { used: 0, limit: null, remaining: null, percentUsed: null, exceeded: false },
        campaigns: { used: 0, limit: null, remaining: null, percentUsed: null, exceeded: false },
      },
    });

    const { features } = await resolver.resolveTenant('t1');

    expect(features[0]).toMatchObject({ available: false, blockedReason: 'quota_exceeded' });
  });

  it('a missing (non-overridden) dependency still blocks the overridden feature', async () => {
    // 'ai' is overridden+enabled, but requires 'campaigns', which has neither
    // an override nor default_enabled — the override must not paper over a
    // genuinely unmet dependency belonging to a DIFFERENT feature.
    definitions.find.mockResolvedValueOnce([AI_DEF, CAMPAIGNS_DEF]);
    flags.find.mockResolvedValueOnce([{ feature_key: 'ai', is_enabled: true }]);
    dependencies.find.mockResolvedValueOnce([{ feature_key: 'ai', requires_key: 'campaigns' }]);

    const { features } = await resolver.resolveTenant('t1');
    const ai = features.find((f) => f.featureKey === 'ai')!;

    expect(ai.available).toBe(false);
    expect(ai.blockedReason).toBe('dependency_missing');
  });

  it('an active subscription still grants access normally — override is irrelevant/unused', async () => {
    access.resolveAccess.mockResolvedValueOnce({ allowed: true, source: AccessSource.SUBSCRIPTION, subscriptionId: 'sub-1' });
    definitions.find.mockResolvedValueOnce([AI_DEF]);
    flags.find.mockResolvedValueOnce([]); // no override needed

    const { features, subscription } = await resolver.resolveTenant('t1');

    // default_enabled is false and no override → still "disabled", not a
    // subscription problem; proves the subscription-active path is unchanged.
    expect(features[0]).toMatchObject({ available: false, blockedReason: 'disabled' });
    expect(subscription.active).toBe(true);
  });
});
