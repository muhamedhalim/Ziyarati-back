import { Reflector } from '@nestjs/core';

import { PermissionsGuard } from './permissions.guard';
import { ErrorCode } from '../../../common/errors';
import { ROLE, PERMISSION } from '../../../rbac/rbac.constants';
import {
  createMockReflector,
  createMockExecutionContext,
} from '../../../../test/utils/mock-factories';

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let reflector: ReturnType<typeof createMockReflector>;

  beforeEach(() => {
    reflector = createMockReflector();
    guard = new PermissionsGuard(reflector as unknown as Reflector);
  });

  const ctxWithUser = (user: unknown) => createMockExecutionContext({ user });

  it('allows routes with no required permissions', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(ctxWithUser({ permissions: [] }))).toBe(true);
  });

  it('allows routes with an empty required-permission array', () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    expect(guard.canActivate(ctxWithUser({ permissions: [] }))).toBe(true);
  });

  it('denies when no principal is present', () => {
    reflector.getAllAndOverride.mockReturnValue([PERMISSION.APPOINTMENTS_READ]);
    expect(() => guard.canActivate(ctxWithUser(undefined))).toThrow(
      expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
    );
  });

  it('short-circuits for super_admin regardless of granted permissions', () => {
    reflector.getAllAndOverride.mockReturnValue([PERMISSION.PLATFORM_SETTINGS_MANAGE]);
    const ctx = ctxWithUser({ roles: [ROLE.SUPER_ADMIN], permissions: [] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when the user holds EVERY required permission', () => {
    reflector.getAllAndOverride.mockReturnValue([
      PERMISSION.APPOINTMENTS_READ,
      PERMISSION.APPOINTMENTS_CREATE,
    ]);
    const ctx = ctxWithUser({
      roles: [ROLE.OWNER],
      permissions: [
        PERMISSION.APPOINTMENTS_READ,
        PERMISSION.APPOINTMENTS_CREATE,
        PERMISSION.CUSTOMERS_READ,
      ],
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies when the user is missing any required permission', () => {
    reflector.getAllAndOverride.mockReturnValue([
      PERMISSION.APPOINTMENTS_READ,
      PERMISSION.APPOINTMENTS_CANCEL,
    ]);
    const ctx = ctxWithUser({ roles: [ROLE.RECEPTIONIST], permissions: [PERMISSION.APPOINTMENTS_READ] });
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
    );
  });
});
