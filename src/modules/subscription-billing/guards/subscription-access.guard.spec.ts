import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SubscriptionAccessGuard } from './subscription-access.guard';
import { REQUIRE_ACTIVE_SUBSCRIPTION_KEY } from '../decorators/require-active-subscription.decorator';
import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { AccessControlService } from '../access-control.service';
import { ErrorCode } from '../../../common/errors';

/**
 * FND-031/T082 — the guard is the single global choke point for ~50
 * controllers' `@RequireActiveSubscription()`. This proves the write-specific
 * grace-expired refusal without touching any of those controllers.
 *
 * Feature Flags override (platform/feature-flags) — the guard also reads the
 * SAME route's `@RequireFeature()` key and threads it through to
 * `assertUsable`, so a tenant-specific feature-flag override can substitute
 * for a missing subscription on that one route (AccessControlService owns
 * the actual precedence; this only proves the guard reads and forwards the
 * key correctly).
 */
describe('SubscriptionAccessGuard', () => {
  let guard: SubscriptionAccessGuard;
  let access: { assertUsable: jest.Mock; isBillableAllowed: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };

  const contextFor = (method: string, tenantId: string | null = 't1'): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ method, user: tenantId ? { tenantId } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  /** Routes REQUIRE_ACTIVE_SUBSCRIPTION_KEY/REQUIRE_FEATURE_KEY independently, like the real Reflector. */
  const mockReflector = (opts: { gated?: boolean; featureKey?: string } = {}) => {
    const { gated = true, featureKey = undefined } = opts;
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === REQUIRE_ACTIVE_SUBSCRIPTION_KEY) return gated;
      if (key === REQUIRE_FEATURE_KEY) return featureKey;
      return undefined;
    });
  };

  beforeEach(() => {
    access = {
      assertUsable: jest.fn().mockResolvedValue(undefined),
      isBillableAllowed: jest.fn().mockResolvedValue(true),
    };
    reflector = { getAllAndOverride: jest.fn() };
    // Default: route IS gated, no @RequireFeature() — matches most of the
    // ~50 @RequireActiveSubscription()-only controllers.
    mockReflector();
    guard = new SubscriptionAccessGuard(
      reflector as unknown as Reflector,
      access as unknown as AccessControlService,
    );
  });

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

  it('always checks the broad assertUsable gate first, regardless of method', async () => {
    await guard.canActivate(contextFor('GET'));
    expect(access.assertUsable).toHaveBeenCalledWith('t1', undefined);
  });

  it('is a no-op when the route carries no @RequireActiveSubscription()', async () => {
    mockReflector({ gated: false });
    await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
    expect(access.assertUsable).not.toHaveBeenCalled();
  });

  it('bypasses super-admin / no-tenant callers entirely', async () => {
    await expect(guard.canActivate(contextFor('POST', null))).resolves.toBe(true);
    expect(access.assertUsable).not.toHaveBeenCalled();
  });

  describe('feature-flag override passthrough (platform/feature-flags)', () => {
    it('passes the route\'s @RequireFeature() key through to assertUsable', async () => {
      mockReflector({ featureKey: 'ai' });
      await guard.canActivate(contextFor('GET'));
      expect(access.assertUsable).toHaveBeenCalledWith('t1', 'ai');
    });

    it('passes undefined when the route carries no @RequireFeature() (unaffected — normal subscription gating)', async () => {
      mockReflector(); // gated=true, no featureKey
      await guard.canActivate(contextFor('GET'));
      expect(access.assertUsable).toHaveBeenCalledWith('t1', undefined);
    });

    it('propagates NO_ACTIVE_SUBSCRIPTION when assertUsable rejects even with a featureKey present (no override set)', async () => {
      mockReflector({ featureKey: 'ai' });
      access.assertUsable.mockRejectedValueOnce(
        Object.assign(new Error('no access'), { code: ErrorCode.NO_ACTIVE_SUBSCRIPTION }),
      );
      await expect(guard.canActivate(contextFor('GET'))).rejects.toMatchObject({
        code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
      });
    });

    it('a feature override that satisfies assertUsable still runs the billable-methods check on write', async () => {
      mockReflector({ featureKey: 'ai' });
      await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
      expect(access.assertUsable).toHaveBeenCalledWith('t1', 'ai');
      expect(access.isBillableAllowed).toHaveBeenCalledWith('t1');
    });
  });
});
