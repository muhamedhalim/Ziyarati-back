import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SubscriptionAccessGuard } from './subscription-access.guard';
import { AccessControlService } from '../access-control.service';
import { ErrorCode } from '../../../common/errors';

/**
 * FND-031/T082 — the guard is the single global choke point for ~50
 * controllers' `@RequireActiveSubscription()`. This proves the write-specific
 * grace-expired refusal without touching any of those controllers.
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

  beforeEach(() => {
    access = {
      assertUsable: jest.fn().mockResolvedValue(undefined),
      isBillableAllowed: jest.fn().mockResolvedValue(true),
    };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) }; // route IS gated
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
    expect(access.assertUsable).toHaveBeenCalledWith('t1');
  });

  it('is a no-op when the route carries no @RequireActiveSubscription()', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(undefined);
    await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
    expect(access.assertUsable).not.toHaveBeenCalled();
  });

  it('bypasses super-admin / no-tenant callers entirely', async () => {
    await expect(guard.canActivate(contextFor('POST', null))).resolves.toBe(true);
    expect(access.assertUsable).not.toHaveBeenCalled();
  });
});
