import { Reflector } from '@nestjs/core';

import { RolesGuard } from './roles.guard';
import { ErrorCode } from '../../../common/errors';
import { ROLE } from '../../../rbac/rbac.constants';
import {
  createMockReflector,
  createMockExecutionContext,
} from '../../../../test/utils/mock-factories';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: ReturnType<typeof createMockReflector>;

  beforeEach(() => {
    reflector = createMockReflector();
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  const ctxWithUser = (user: unknown) => createMockExecutionContext({ user });

  it('allows routes with no required roles', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(ctxWithUser({ roles: [] }))).toBe(true);
  });

  it('denies when no principal is present', () => {
    reflector.getAllAndOverride.mockReturnValue([ROLE.OWNER]);
    expect(() => guard.canActivate(ctxWithUser(undefined))).toThrow(
      expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
    );
  });

  it('allows when the user holds at least one required role', () => {
    reflector.getAllAndOverride.mockReturnValue([ROLE.OWNER, ROLE.MANAGER]);
    expect(guard.canActivate(ctxWithUser({ roles: [ROLE.MANAGER] }))).toBe(true);
  });

  it('denies when the user holds none of the required roles', () => {
    reflector.getAllAndOverride.mockReturnValue([ROLE.OWNER]);
    expect(() => guard.canActivate(ctxWithUser({ roles: [ROLE.RECEPTIONIST] }))).toThrow(
      expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
    );
  });
});
