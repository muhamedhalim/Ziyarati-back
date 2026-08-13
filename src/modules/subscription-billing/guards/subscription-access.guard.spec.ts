import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SubscriptionAccessGuard } from './subscription-access.guard';
import { REQUIRE_ACTIVE_SUBSCRIPTION_KEY } from '../decorators/require-active-subscription.decorator';
import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { AccessControlService } from '../access-control.service';
import { FeatureKey } from '../feature-registry';
import {
  AccessSource,
  QuotaPolicy,
  TenantAccessDecision,
} from '../tenant-access-decision';
import { ErrorCode } from '../../../common/errors';

const ALLOWED: TenantAccessDecision = {
  allowed: true,
  tenantId: 't1',
  featureKey: null,
  source: AccessSource.ACTIVE_SUBSCRIPTION,
  quotaPolicy: QuotaPolicy.PLAN_ENFORCED,
};

const DENIED: TenantAccessDecision = {
  allowed: false,
  tenantId: 't1',
  featureKey: null,
  source: AccessSource.DENIED,
  quotaPolicy: QuotaPolicy.BLOCKED,
  reason: 'Subscription is not active (status: CANCELLED)',
};

/**
 * FND-031/T082 — the guard is the single global choke point for ~50
 * controllers' `@RequireActiveSubscription()`. It proves the write-specific
 * grace-expired refusal without touching any of those controllers.
 *
 * It also forwards the SAME route's `@RequireFeature()` key to the policy, so
 * a super-admin per-feature grant can substitute for a missing subscription on
 * that one route. `AccessControlService` owns the precedence; these tests only
 * prove the guard reads, forwards and enforces correctly.
 */
describe('SubscriptionAccessGuard', () => {
  let guard: SubscriptionAccessGuard;
  let access: { resolve: jest.Mock; isBillableAllowed: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };

  const contextFor = (method: string, tenantId: string | null = 't1') => {
    const request = { method, user: tenantId ? { tenantId } : undefined };
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  /** Routes carry the two metadata keys independently, like the real Reflector. */
  const mockReflector = (
    opts: { gated?: boolean; featureKey?: FeatureKey } = {},
  ) => {
    const { gated = true, featureKey = undefined } = opts;
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === REQUIRE_ACTIVE_SUBSCRIPTION_KEY) return gated;
      if (key === REQUIRE_FEATURE_KEY) return featureKey;
      return undefined;
    });
  };

  beforeEach(() => {
    access = {
      resolve: jest.fn().mockResolvedValue(ALLOWED),
      isBillableAllowed: jest.fn().mockResolvedValue(true),
    };
    reflector = { getAllAndOverride: jest.fn() };
    // Default: route IS gated, no @RequireFeature().
    mockReflector();
    guard = new SubscriptionAccessGuard(
      reflector as unknown as Reflector,
      access as unknown as AccessControlService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('allows a GET even when grace-expired (read access preserved)', async () => {
    access.isBillableAllowed.mockResolvedValueOnce(false);
    await expect(guard.canActivate(contextFor('GET'))).resolves.toBe(true);
    expect(access.isBillableAllowed).not.toHaveBeenCalled();
  });

  it('allows a DELETE even when grace-expired (never usage-increasing)', async () => {
    access.isBillableAllowed.mockResolvedValueOnce(false);
    await expect(guard.canActivate(contextFor('DELETE'))).resolves.toBe(true);
    expect(access.isBillableAllowed).not.toHaveBeenCalled();
  });

  it('refuses a POST once grace-expired', async () => {
    access.isBillableAllowed.mockResolvedValueOnce(false);
    await expect(guard.canActivate(contextFor('POST'))).rejects.toMatchObject({
      code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
    });
  });

  it('refuses a PATCH once grace-expired', async () => {
    access.isBillableAllowed.mockResolvedValueOnce(false);
    await expect(guard.canActivate(contextFor('PATCH'))).rejects.toMatchObject({
      code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
    });
  });

  it('allows a POST for a normal (not grace-expired) tenant', async () => {
    await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
    expect(access.isBillableAllowed).toHaveBeenCalledWith('t1');
  });

  it('refuses with NO_ACTIVE_SUBSCRIPTION when the policy denies', async () => {
    access.resolve.mockResolvedValueOnce(DENIED);
    await expect(guard.canActivate(contextFor('GET'))).rejects.toMatchObject({
      code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
    });
  });

  it('keeps the technical reason server-side', async () => {
    access.resolve.mockResolvedValueOnce(DENIED);
    await expect(guard.canActivate(contextFor('GET'))).rejects.toMatchObject({
      publicContext: { source: AccessSource.DENIED },
      internalContext: { reason: DENIED.reason },
    });
  });

  it('resolves the tenant-wide decision when the route names no capability', async () => {
    await guard.canActivate(contextFor('GET'));
    expect(access.resolve).toHaveBeenCalledWith('t1', null);
  });

  it('is a no-op when the route carries no @RequireActiveSubscription()', async () => {
    mockReflector({ gated: false });
    await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
    expect(access.resolve).not.toHaveBeenCalled();
  });

  it('bypasses super-admin / no-tenant callers entirely', async () => {
    await expect(guard.canActivate(contextFor('POST', null))).resolves.toBe(
      true,
    );
    expect(access.resolve).not.toHaveBeenCalled();
  });

  describe('per-feature grant passthrough (/platform/feature-flags)', () => {
    it("forwards the route's @RequireFeature() key to the policy", async () => {
      mockReflector({ featureKey: FeatureKey.AI_ASSISTANT });
      await guard.canActivate(contextFor('GET'));
      expect(access.resolve).toHaveBeenCalledWith(
        't1',
        FeatureKey.AI_ASSISTANT,
      );
    });

    it('still refuses when no grant covers that capability', async () => {
      mockReflector({ featureKey: FeatureKey.AI_ASSISTANT });
      access.resolve.mockResolvedValueOnce(DENIED);
      await expect(guard.canActivate(contextFor('GET'))).rejects.toMatchObject({
        code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
      });
    });

    it('a grant that admits the route still runs the billable-methods check', async () => {
      mockReflector({ featureKey: FeatureKey.AI_ASSISTANT });
      access.resolve.mockResolvedValueOnce({
        ...ALLOWED,
        source: AccessSource.FEATURE_OVERRIDE,
        quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
      });
      await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
      expect(access.isBillableAllowed).toHaveBeenCalledWith('t1');
    });
  });
});
