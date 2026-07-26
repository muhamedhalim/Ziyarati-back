import 'reflect-metadata';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { BillingUpgradeController } from './billing-upgrade.controller';
import { PlatformBillingUpgradeController } from './platform-billing-upgrade.controller';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';
import { ErrorCode } from '../../common/errors';
import { createMockExecutionContext } from '../../../test/utils/mock-factories';

/**
 * Pins the authorization contract for both surfaces:
 *  - Owner endpoints require `billing_upgrade.read`/`billing_upgrade.manage`.
 *  - The platform endpoint is restricted to `super_admin` (RolesGuard).
 */
describe('Billing upgrade requests — authorization', () => {
  describe('Owner controller (PermissionsGuard)', () => {
    const required = (method: keyof BillingUpgradeController) =>
      Reflect.getMetadata(PERMISSIONS_KEY, BillingUpgradeController.prototype[method]);

    it('requires billing_upgrade.manage to create', () => {
      expect(required('create')).toEqual([PERMISSION.BILLING_UPGRADE_MANAGE]);
    });

    it('requires billing_upgrade.read to list', () => {
      expect(required('list')).toEqual([PERMISSION.BILLING_UPGRADE_READ]);
    });

    it('requires billing_upgrade.read to get', () => {
      expect(required('get')).toEqual([PERMISSION.BILLING_UPGRADE_READ]);
    });

    it('requires billing_upgrade.manage to cancel', () => {
      expect(required('cancel')).toEqual([PERMISSION.BILLING_UPGRADE_MANAGE]);
    });

    it('requires billing_upgrade.manage to accept', () => {
      expect(required('accept')).toEqual([PERMISSION.BILLING_UPGRADE_MANAGE]);
    });

    const reflector = { getAllAndOverride: () => [PERMISSION.BILLING_UPGRADE_MANAGE] } as unknown as import('@nestjs/core').Reflector;
    const guard = new PermissionsGuard(reflector);
    const denialCode = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (err) {
        return (err as { code?: unknown }).code;
      }
      return undefined;
    };

    it('rejects a manager without billing_upgrade.manage (owner-only action)', () => {
      const ctx = createMockExecutionContext({ user: { roles: [ROLE.MANAGER], permissions: [PERMISSION.BILLING_UPGRADE_READ] } });
      expect(denialCode(() => guard.canActivate(ctx))).toBe(ErrorCode.PERMISSION_DENIED);
    });

    it('admits an owner holding billing_upgrade.manage', () => {
      const ctx = createMockExecutionContext({ user: { roles: [ROLE.OWNER], permissions: [PERMISSION.BILLING_UPGRADE_MANAGE] } });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('super_admin bypasses the permission check', () => {
      const ctx = createMockExecutionContext({ user: { roles: [ROLE.SUPER_ADMIN], permissions: [] } });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('Platform controller (RolesGuard)', () => {
    it('restricts the controller to the super_admin role', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, PlatformBillingUpgradeController);
      expect(roles).toEqual([ROLE.SUPER_ADMIN]);
    });

    const reflector = { getAllAndOverride: () => [ROLE.SUPER_ADMIN] } as unknown as import('@nestjs/core').Reflector;
    const guard = new RolesGuard(reflector);
    const denialCode = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (err) {
        return (err as { code?: unknown }).code;
      }
      return undefined;
    };

    it('rejects a clinic owner', () => {
      const ctx = createMockExecutionContext({ user: { roles: [ROLE.OWNER], permissions: [] } });
      expect(denialCode(() => guard.canActivate(ctx))).toBe(ErrorCode.PERMISSION_DENIED);
    });

    it('admits a super admin', () => {
      const ctx = createMockExecutionContext({ user: { roles: [ROLE.SUPER_ADMIN], permissions: [] } });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});
