import { ExecutionContext } from '@nestjs/common';

import { MaintenanceGuard } from './maintenance.guard';
import { AppError, ErrorCode } from '../../../common/errors';
import { ROLE } from '../../../rbac/rbac.constants';

function ctx(user?: { roles: string[] }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guard(maintenance: boolean) {
  return new MaintenanceGuard({
    getTyped: jest.fn().mockResolvedValue(maintenance),
  } as never);
}

describe('MaintenanceGuard', () => {
  it('lets everyone through when maintenance mode is off', async () => {
    await expect(guard(false).canActivate(ctx({ roles: [ROLE.OWNER] }))).resolves.toBe(true);
  });

  it('lets public (unauthenticated) routes and super-admins through during maintenance', async () => {
    await expect(guard(true).canActivate(ctx(undefined))).resolves.toBe(true);
    await expect(guard(true).canActivate(ctx({ roles: [ROLE.SUPER_ADMIN] }))).resolves.toBe(true);
  });

  it('refuses a clinic user with the dedicated MAINTENANCE_MODE code, not the generic 503 (CR-04)', async () => {
    const attempt = guard(true).canActivate(ctx({ roles: [ROLE.OWNER] }));
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      code: ErrorCode.MAINTENANCE_MODE,
      statusCode: 503,
    });
  });
});
