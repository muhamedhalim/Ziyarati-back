import { Reflector } from '@nestjs/core';

import { IntegrationMeController } from './integration-me.controller';
import type { ApiKeyService } from '../platform/api-key.service';
import type { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ErrorCode } from '../../common/errors';
import { REQUIRE_SCOPES_KEY } from '../platform/decorators/require-scopes.decorator';
import { IntegrationScopeGuard } from '../platform/guards/integration-scope.guard';

const TENANT = 't1';

function build(opts: { tenantName?: string | null } = {}) {
  const keys = {
    describeOwn: jest.fn().mockResolvedValue({
      keyId: 'k1',
      keyPrefix: 'zk_abc',
      name: 'ERP',
      scopes: ['integration.services.read'],
      expiresAt: null,
      lastUsedAt: null,
    }),
  };
  const ctx = {
    requireTenantId: jest.fn().mockReturnValue(TENANT),
    getTenant: jest
      .fn()
      .mockReturnValue(
        opts.tenantName === null
          ? null
          : { name: opts.tenantName ?? 'Sunrise Clinic' },
      ),
  };
  const controller = new IntegrationMeController(
    keys as unknown as ApiKeyService,
    ctx as unknown as TenantContextService,
  );
  return { controller, keys, ctx };
}

const principal = (id: string): AuthenticatedUser => ({
  id,
  tenantId: TENANT,
  email: null,
  roles: [],
  permissions: [],
});

describe('IntegrationMeController', () => {
  it("describes the CALLER's own key, using the key id from the principal and the tenant from context", async () => {
    const { controller, keys } = build();
    const me = await controller.me(principal('apikey:k1'));
    expect(keys.describeOwn).toHaveBeenCalledWith(TENANT, 'k1');
    expect(me).toEqual({
      keyId: 'k1',
      keyPrefix: 'zk_abc',
      name: 'ERP',
      scopes: ['integration.services.read'],
      expiresAt: null,
      lastUsedAt: null,
      tenantName: 'Sunrise Clinic',
    });
  });

  it('never exposes the tenant id or any key material', async () => {
    const { controller } = build();
    const json = JSON.stringify(await controller.me(principal('apikey:k1')));
    expect(json).not.toContain(TENANT);
    expect(json).not.toMatch(/hash|secret/i);
  });

  it('reports a null clinic name rather than failing when the tenant is not cached', async () => {
    const { controller } = build({ tenantName: null });
    expect((await controller.me(principal('apikey:k1'))).tenantName).toBeNull();
  });

  it('refuses a principal that is not an API key (a dashboard JWT user has no key to describe)', async () => {
    const { controller, keys } = build();
    await expect(controller.me(principal('user-uuid'))).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    expect(keys.describeOwn).not.toHaveBeenCalled();
  });

  it('needs a valid key but NO particular scope: every key can describe itself', () => {
    const handler = IntegrationMeController.prototype.me;
    const required = Reflect.getMetadata(REQUIRE_SCOPES_KEY, handler);
    expect(required).toEqual([]);

    const guard = new IntegrationScopeGuard(new Reflector());
    const ctxFor = (permissions: string[]) => ({
      getHandler: () => handler,
      getClass: () => IntegrationMeController,
      switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
    });
    expect(guard.canActivate(ctxFor([]) as never)).toBe(true);
    expect(
      guard.canActivate(ctxFor(['integration.customers.write']) as never),
    ).toBe(true);
  });
});
