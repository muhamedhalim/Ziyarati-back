import { Reflector } from '@nestjs/core';

import { IntegrationScopeGuard } from './integration-scope.guard';
import { INTEGRATION_SCOPE } from '../integration-scopes.constants';
import { ErrorCode } from '../../../common/errors';
import {
  createMockReflector,
  createMockExecutionContext,
} from '../../../../test/utils/mock-factories';

describe('IntegrationScopeGuard', () => {
  let guard: IntegrationScopeGuard;
  let reflector: ReturnType<typeof createMockReflector>;

  beforeEach(() => {
    reflector = createMockReflector();
    guard = new IntegrationScopeGuard(reflector as unknown as Reflector);
  });

  it('allows a route with no @RequireScopes metadata', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(
      guard.canActivate(createMockExecutionContext({ user: undefined })),
    ).toBe(true);
  });

  it('throws UNAUTHORIZED when no principal is present', () => {
    reflector.getAllAndOverride.mockReturnValue([INTEGRATION_SCOPE.SERVICES_READ]);
    expect(() => guard.canActivate(createMockExecutionContext({ user: undefined }))).toThrow(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('allows a key that carries every required scope', () => {
    reflector.getAllAndOverride.mockReturnValue([INTEGRATION_SCOPE.SERVICES_READ]);
    const ctx = createMockExecutionContext({
      user: { id: 'apikey:k1', tenantId: 't1', roles: [], permissions: [INTEGRATION_SCOPE.SERVICES_READ] },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a key missing a required scope', () => {
    reflector.getAllAndOverride.mockReturnValue([INTEGRATION_SCOPE.CUSTOMERS_READ]);
    const ctx = createMockExecutionContext({
      user: { id: 'apikey:k1', tenantId: 't1', roles: [], permissions: [INTEGRATION_SCOPE.SERVICES_READ] },
    });
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({ code: ErrorCode.FORBIDDEN }),
    );
  });

  it('requires ALL scopes when multiple are declared', () => {
    reflector.getAllAndOverride.mockReturnValue([
      INTEGRATION_SCOPE.SERVICES_READ,
      INTEGRATION_SCOPE.STAFF_READ,
    ]);
    const ctx = createMockExecutionContext({
      user: { id: 'apikey:k1', tenantId: 't1', roles: [], permissions: [INTEGRATION_SCOPE.SERVICES_READ] },
    });
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({ code: ErrorCode.FORBIDDEN }),
    );
  });
});
