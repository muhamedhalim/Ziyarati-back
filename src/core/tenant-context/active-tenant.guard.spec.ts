import { Reflector } from '@nestjs/core';

import { ActiveTenantGuard } from './active-tenant.guard';
import { TenantContextService } from './tenant-context.service';
import { TenantLookupService } from './tenant-lookup.service';
import { TenantApprovalStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockReflector,
  createMockExecutionContext,
} from '../../../test/utils/mock-factories';

describe('ActiveTenantGuard', () => {
  let guard: ActiveTenantGuard;
  let reflector: ReturnType<typeof createMockReflector>;
  let lookup: { findById: jest.Mock };
  let context: TenantContextService;

  beforeEach(() => {
    reflector = createMockReflector();
    lookup = { findById: jest.fn() };
    context = new TenantContextService();
    guard = new ActiveTenantGuard(
      reflector as unknown as Reflector,
      lookup as unknown as TenantLookupService,
      context,
    );
  });

  const run = (request: any) =>
    context.run(() => guard.canActivate(createMockExecutionContext(request)));

  it('bypasses when @AllowInactiveTenant() is set', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(run({ user: { tenantId: 't1' } })).resolves.toBe(true);
  });

  it('bypasses when there is no authenticated principal', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    await expect(run({})).resolves.toBe(true);
  });

  it('bypasses platform principals with no tenant', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    await expect(run({ user: { tenantId: null } })).resolves.toBe(true);
  });

  it('throws TENANT_NOT_FOUND when the tenant is missing', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    lookup.findById.mockResolvedValueOnce(null);
    await expect(run({ user: { tenantId: 't1' } })).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_FOUND });
  });

  it('throws FORBIDDEN when the tenant is not approved/active', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    lookup.findById.mockResolvedValueOnce({ approval_status: TenantApprovalStatus.SUSPENDED, is_active: false });
    await expect(run({ user: { tenantId: 't1' } })).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('allows and caches an approved, active tenant', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const tenant = { id: 't1', approval_status: TenantApprovalStatus.APPROVED, is_active: true };
    lookup.findById.mockResolvedValueOnce(tenant);
    const req: any = { user: { tenantId: 't1' } };
    await context.run(async () => {
      const ok = await guard.canActivate(createMockExecutionContext(req));
      expect(ok).toBe(true);
      expect(req.tenant).toBe(tenant); // cached on request
      expect(context.getTenant()).toBe(tenant);
    });
  });
});
