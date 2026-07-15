import 'reflect-metadata';

import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RbacAuditController } from './rbac-audit.controller';
import { ROLE } from '../../rbac/rbac.constants';
import { ErrorCode } from '../../common/errors';
import { createMockExecutionContext } from '../../../test/utils/mock-factories';

/**
 * The audit surface is platform super-admin only. These tests pin the
 * authorization contract: the controller declares @Roles(super_admin), and
 * RolesGuard rejects tenant users / anonymous callers while admitting
 * super-admins.
 */
describe('RBAC audit authorization', () => {
  it('restricts the controller to the super_admin role', () => {
    const required = Reflect.getMetadata(ROLES_KEY, RbacAuditController);
    expect(required).toEqual([ROLE.SUPER_ADMIN]);
  });

  describe('RolesGuard enforcement (super_admin required)', () => {
    const reflector = {
      getAllAndOverride: () => [ROLE.SUPER_ADMIN],
    } as unknown as import('@nestjs/core').Reflector;
    const guard = new RolesGuard(reflector);

    const denialCode = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (err) {
        return (err as { code?: unknown }).code;
      }
      return undefined;
    };

    it('rejects a tenant user (e.g. clinic owner)', () => {
      const ctx = createMockExecutionContext({ user: { roles: [ROLE.OWNER], permissions: [] } });
      expect(denialCode(() => guard.canActivate(ctx))).toBe(ErrorCode.PERMISSION_DENIED);
    });

    it('rejects an anonymous request', () => {
      const ctx = createMockExecutionContext({});
      expect(denialCode(() => guard.canActivate(ctx))).toBe(ErrorCode.PERMISSION_DENIED);
    });

    it('admits a super-admin', () => {
      const ctx = createMockExecutionContext({ user: { roles: [ROLE.SUPER_ADMIN], permissions: [] } });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});
