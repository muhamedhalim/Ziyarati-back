import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';

import { TenantController } from './tenant.controller';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ROLE } from '../../rbac/rbac.constants';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * VER-006 (REQ-TEN-014, P1) — "get arbitrary tenant" (`GET /tenants/:id`,
 * `TenantController.findOne` → `tenantService.findById(id)`, with NO tenant
 * filter applied in the query itself) is a genuinely PLATFORM-ONLY route by
 * design (the controller's own docstring: "PLATFORM admin (super_admin):
 * ... inspect ... ANY tenant"). `RolesGuard` (the sole protection — the
 * service method itself applies no scoping) is the ENTIRE security boundary.
 * Exercises the REAL `RolesGuard` + the REAL `@Roles` metadata attached to
 * the REAL `findOne` handler (only the HTTP transport is skipped — Nest's
 * route dispatch is well-tested, out-of-scope framework internals, not the
 * authorization logic under test here).
 */
function contextFor(handler: Function, user: { roles: string[] } | undefined) {
  return {
    getHandler: () => handler,
    getClass: () => TenantController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenantController.findOne — platform-only authorization (VER-006)', () => {
  const guard = new RolesGuard(new Reflector());

  it('carries the @Roles(SUPER_ADMIN) metadata on the actual findOne handler', () => {
    const required = new Reflector().get(ROLES_KEY, TenantController.prototype.findOne);
    expect(required).toEqual([ROLE.SUPER_ADMIN]);
  });

  it('REJECTS a tenant-scoped caller (owner) — cannot read an arbitrary tenant', () => {
    const ctx = contextFor(TenantController.prototype.findOne, { roles: [ROLE.OWNER] });
    expect(() => guard.canActivate(ctx)).toThrow(AppError);
    try {
      guard.canActivate(ctx);
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
    }
  });

  it('REJECTS a tenant-scoped caller (manager) — same platform-only boundary', () => {
    const ctx = contextFor(TenantController.prototype.findOne, { roles: [ROLE.MANAGER] });
    expect(() => guard.canActivate(ctx)).toThrow(AppError);
  });

  it('REJECTS an unauthenticated request (no user on the request at all)', () => {
    const ctx = contextFor(TenantController.prototype.findOne, undefined);
    expect(() => guard.canActivate(ctx)).toThrow(AppError);
  });

  it('a caller holding SEVERAL roles but NOT super_admin is still rejected (no accidental OR-in via an unrelated role)', () => {
    const ctx = contextFor(TenantController.prototype.findOne, { roles: [ROLE.OWNER, ROLE.MANAGER, ROLE.DOCTOR] });
    expect(() => guard.canActivate(ctx)).toThrow(AppError);
  });

  it('ADMITS the platform operator (super_admin)', () => {
    const ctx = contextFor(TenantController.prototype.findOne, { roles: [ROLE.SUPER_ADMIN] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('the service method the route actually calls applies no tenant filter of its own — RolesGuard is the WHOLE boundary, and it holds', () => {
    // findOne(id) => this.tenantService.findById(id) — a single, unscoped
    // by-id lookup (verified by reading tenant.controller.ts:371-372). This
    // is CORRECT for a genuine platform-wide "any tenant" endpoint, not a
    // gap — but it means there is exactly one enforcement layer, so its
    // correctness (proven above) is load-bearing, not defense-in-depth.
    const controller = TenantController.prototype;
    expect(controller.findOne.toString()).toContain('findById');
  });
});
