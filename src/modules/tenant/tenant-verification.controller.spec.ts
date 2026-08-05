import { Reflector } from '@nestjs/core';

import { TenantVerificationController } from './tenant-verification.controller';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * VER-001…VER-005 (REQ-TEN-001/002/003/004/006) — controller-level proof.
 * Service-level behavior (submit/submitForReview/getFileUrl/listForTenant/
 * listAudit) is proven directly in `tenant-verification.service.spec.ts`;
 * this file covers what only exists at the controller: the `@Roles` gate on
 * each route, and `getFileUrl`'s scope-derivation ternary (super_admin → any
 * tenant; everyone else → their own, via `TenantContextService`), which is
 * controller logic no service-level test can see.
 */
describe('TenantVerificationController — route authorization (VER-001…005)', () => {
  const reflector = new Reflector();
  const rolesOf = (handler: Function) => reflector.get(ROLES_KEY, handler);

  it('VER-001 submit (POST me): owner only', () => {
    expect(rolesOf(TenantVerificationController.prototype.submit)).toEqual([ROLE.OWNER]);
  });

  it('VER-002 submitForReview (POST me/submit): owner only', () => {
    expect(rolesOf(TenantVerificationController.prototype.submitForReview)).toEqual([ROLE.OWNER]);
  });

  it('VER-003 getFileUrl (GET :documentId/file-url): owner, manager, or super_admin', () => {
    expect(rolesOf(TenantVerificationController.prototype.getFileUrl)).toEqual(
      expect.arrayContaining([ROLE.OWNER, ROLE.MANAGER, ROLE.SUPER_ADMIN]),
    );
  });

  it('VER-004 listMine (GET me): owner or manager', () => {
    expect(rolesOf(TenantVerificationController.prototype.listMine)).toEqual(
      expect.arrayContaining([ROLE.OWNER, ROLE.MANAGER]),
    );
  });

  it('VER-005 listAudit (GET tenants/:tenantId/audit): super_admin only — never a tenant-scoped role', () => {
    const roles = rolesOf(TenantVerificationController.prototype.listAudit);
    expect(roles).toEqual([ROLE.SUPER_ADMIN]);
    expect(roles).not.toContain(ROLE.OWNER);
    expect(roles).not.toContain(ROLE.MANAGER);
  });

  it('the admin listForTenant (GET tenants/:tenantId): super_admin only', () => {
    expect(rolesOf(TenantVerificationController.prototype.listForTenant)).toEqual([ROLE.SUPER_ADMIN]);
  });
});

describe('TenantVerificationController.getFileUrl — scope derivation (VER-003)', () => {
  function build(isSuperAdmin: boolean, tenantId = 'tenant-1') {
    const verification = { getFileUrl: jest.fn().mockResolvedValue({ url: 'https://x' }) };
    const ctx = {
      isSuperAdmin: jest.fn().mockReturnValue(isSuperAdmin),
      requireTenantId: jest.fn().mockReturnValue(tenantId),
      getUser: jest.fn().mockReturnValue({ roles: [isSuperAdmin ? ROLE.SUPER_ADMIN : ROLE.OWNER] }),
    };
    const controller = new TenantVerificationController(verification as any, ctx as any);
    return { controller, verification, ctx };
  }

  it('a super_admin caller passes scope=null — the service resolves ANY tenant\'s document', async () => {
    const { controller, verification, ctx } = build(true);
    await controller.getFileUrl('doc-1', 'admin-1', '1.2.3.4', 'jest');
    expect(verification.getFileUrl).toHaveBeenCalledWith('doc-1', null, expect.any(Object));
    expect(ctx.requireTenantId).not.toHaveBeenCalled();
  });

  it('a non-super_admin caller passes their OWN tenantId as scope — never null, never a client-supplied value', async () => {
    const { controller, verification } = build(false, 'tenant-owner-1');
    await controller.getFileUrl('doc-1', 'owner-1', '1.2.3.4', 'jest');
    expect(verification.getFileUrl).toHaveBeenCalledWith('doc-1', 'tenant-owner-1', expect.any(Object));
  });
});
