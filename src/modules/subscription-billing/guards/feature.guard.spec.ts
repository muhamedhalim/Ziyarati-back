import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { FeatureGuard } from './feature.guard';
import { AccessControlService } from '../access-control.service';
import { FeatureKey } from '../feature-registry';
import {
  AccessSource,
  QuotaPolicy,
  TenantAccessDecision,
} from '../tenant-access-decision';
import { ErrorCode } from '../../../common/errors';

const allow = (
  over: Partial<TenantAccessDecision> = {},
): TenantAccessDecision => ({
  allowed: true,
  tenantId: 't1',
  featureKey: FeatureKey.AI_ASSISTANT,
  source: AccessSource.ACTIVE_SUBSCRIPTION,
  quotaPolicy: QuotaPolicy.PLAN_ENFORCED,
  ...over,
});

const deny = (reason = 'nope'): TenantAccessDecision => ({
  allowed: false,
  tenantId: 't1',
  featureKey: FeatureKey.AI_ASSISTANT,
  source: AccessSource.DENIED,
  quotaPolicy: QuotaPolicy.BLOCKED,
  reason,
});

/**
 * FND-033 — route gating and the effective-feature view MUST agree. They now
 * agree BY CONSTRUCTION: both read `AccessControlService`, so there is no
 * second chain to drift. The exploit this guards against is unchanged — a
 * tenant self-enabling a raw `feature_flags` row for a capability its plan
 * excludes — but it is now neutralised inside the policy (tenant-written rows
 * are not authoritative), and this guard simply enforces the verdict.
 */
describe('FeatureGuard', () => {
  let guard: FeatureGuard;
  let access: { resolve: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };

  const contextFor = (tenantId: string | null = 't1') => {
    const request = { user: tenantId ? { tenantId } : undefined };
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    access = { resolve: jest.fn() };
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(FeatureKey.AI_ASSISTANT),
    };
    guard = new FeatureGuard(
      reflector as unknown as Reflector,
      access as unknown as AccessControlService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('allows a capability the policy grants', async () => {
    access.resolve.mockResolvedValueOnce(allow());
    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
  });

  it('refuses a capability the policy denies', async () => {
    access.resolve
      .mockResolvedValueOnce(deny('plan does not include it'))
      // The follow-up tenant-wide check: this tenant DOES have access, it just
      // lacks this capability.
      .mockResolvedValueOnce(allow({ featureKey: null }));

    await expect(guard.canActivate(contextFor())).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('reports a billing problem as NO_ACTIVE_SUBSCRIPTION, not a generic 403', async () => {
    // A tenant with no access path at all needs the "choose a plan" remedy;
    // telling them the FEATURE is unavailable would send them to the wrong place.
    access.resolve
      .mockResolvedValueOnce(deny('no subscription'))
      .mockResolvedValueOnce({ ...deny(), featureKey: null });

    await expect(guard.canActivate(contextFor())).rejects.toMatchObject({
      code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
    });
  });

  it('never leaks the technical reason to the client', async () => {
    access.resolve
      .mockResolvedValueOnce(
        deny('Subscription is not active (status: CANCELLED)'),
      )
      .mockResolvedValueOnce(allow({ featureKey: null }));

    await expect(guard.canActivate(contextFor())).rejects.toMatchObject({
      publicContext: { featureKey: FeatureKey.AI_ASSISTANT },
    });
  });

  it('is a no-op when the route carries no @RequireFeature()', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(undefined);
    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    expect(access.resolve).not.toHaveBeenCalled();
  });

  it('bypasses super-admin / no-tenant callers entirely', async () => {
    await expect(guard.canActivate(contextFor(null))).resolves.toBe(true);
    expect(access.resolve).not.toHaveBeenCalled();
  });

  it('allows everyone under global FREE platform mode', async () => {
    // The guard no longer short-circuits on billing mode itself — the policy
    // reports PLATFORM_FREE_MODE, which keeps FREE mode subject to the one
    // thing that must still apply there: an administrative suspension.
    access.resolve.mockResolvedValueOnce(
      allow({
        source: AccessSource.PLATFORM_FREE_MODE,
        quotaPolicy: QuotaPolicy.UNMETERED_PLATFORM_FREE,
      }),
    );
    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
  });

  it('resolves the decision only ONCE per request across both guards', async () => {
    const context = contextFor();
    access.resolve.mockResolvedValue(allow());

    await guard.canActivate(context);
    await guard.canActivate(context);

    // The per-request memo is what removed the duplicate 8-query resolution
    // that used to run on every gated route.
    expect(access.resolve).toHaveBeenCalledTimes(1);
  });
});
