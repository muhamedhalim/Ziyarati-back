import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { FeatureGuard } from './feature.guard';
import { BillingModeService } from '../billing-mode.service';
import { FeatureResolverService } from '../feature-resolver.service';

/**
 * FND-033 — the route-level guard used to check ONLY the raw per-tenant
 * `feature_flags` row (`FeatureFlagService.assertEnabled`) — a SEPARATE,
 * simpler mechanism from `FeatureResolverService`'s plan/dependency/quota
 * resolution (the "/effective" view). Since `PUT /feature-flags` lets any
 * caller holding `featureflag.manage` set that SAME raw flag for their OWN
 * tenant with zero plan check, a tenant on a plan that does NOT include a
 * feature could self-enable it at the route level. FR-B009: route gating
 * MUST use the SAME resolution chain as the effective-feature view.
 *
 * RED recorded verbatim (temporary probe against the unmodified pre-fix
 * class, deleted immediately after — the fix below changes the constructor
 * signature, so the vulnerable shape can't coexist with the fixed tests in
 * this same file): given `features.assertEnabled` resolving (raw flag says
 * enabled) and NO plan check anywhere in the guard,
 * `guard.canActivate(context)` for a `'ai'`-gated route returned `true` —
 * console output: `RESULT (true = bug confirmed, plan restriction never
 * checked): true`. Confirms the route was admitted regardless of plan
 * inclusion. GREEN below, using the fixed (resolver-based) constructor.
 */
describe('FeatureGuard (FND-033 — must agree with the effective-feature view)', () => {
  let guard: FeatureGuard;
  let resolver: { resolveTenant: jest.Mock };
  let billingMode: { isPaidMode: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };

  const contextFor = (tenantId: string | null = 't1'): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: tenantId ? { tenantId } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    resolver = { resolveTenant: jest.fn() };
    billingMode = { isPaidMode: jest.fn().mockResolvedValue(true) };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue('ai') }; // route gated on 'ai'
    guard = new FeatureGuard(
      reflector as unknown as Reflector,
      billingMode as unknown as BillingModeService,
      resolver as unknown as FeatureResolverService,
    );
  });

  it('refuses a plan-restricted feature even when the tenant has self-enabled the raw flag (the actual exploit)', async () => {
    // A tenant on a plan that does NOT include 'ai' called PUT /feature-flags
    // {featureKey:'ai', isEnabled:true} — the raw flag says enabled, but the
    // EFFECTIVE resolution (same as GET /feature-flags/effective) correctly
    // reports it as plan_restricted.
    resolver.resolveTenant.mockResolvedValueOnce({
      subscription: { active: true, enforced: true, status: 'ACTIVE', source: 'SUBSCRIPTION', planId: 'p1', planName: 'Starter', expiresAt: null },
      features: [
        { featureKey: 'ai', enabled: true, planIncluded: false, dependenciesSatisfied: true, available: false, blockedReason: 'plan_restricted' },
      ],
    });

    await expect(guard.canActivate(contextFor())).rejects.toThrow();
  });

  it('allows a feature the plan genuinely includes', async () => {
    resolver.resolveTenant.mockResolvedValueOnce({
      subscription: { active: true, enforced: true, status: 'ACTIVE', source: 'SUBSCRIPTION', planId: 'p1', planName: 'Pro', expiresAt: null },
      features: [
        { featureKey: 'ai', enabled: true, planIncluded: true, dependenciesSatisfied: true, available: true, blockedReason: null },
      ],
    });

    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
  });

  it('is a no-op when the route carries no @RequireFeature()', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(undefined);
    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    expect(resolver.resolveTenant).not.toHaveBeenCalled();
  });

  it('bypasses super-admin / no-tenant callers entirely', async () => {
    await expect(guard.canActivate(contextFor(null))).resolves.toBe(true);
    expect(resolver.resolveTenant).not.toHaveBeenCalled();
  });

  it('allows everyone under global FREE platform mode (unchanged behavior)', async () => {
    billingMode.isPaidMode.mockResolvedValueOnce(false);
    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    expect(resolver.resolveTenant).not.toHaveBeenCalled();
  });
});
