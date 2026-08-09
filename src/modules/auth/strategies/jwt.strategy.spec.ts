import { ConfigService } from '@nestjs/config';

import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';
import { ErrorCode } from '../../../common/errors';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let authService: { buildAuthenticatedUserWithTenant: jest.Mock };
  const req = {} as any;

  beforeEach(() => {
    req.preloadedTenant = undefined;
    authService = { buildAuthenticatedUserWithTenant: jest.fn() };
    strategy = new JwtStrategy(
      createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as unknown as ConfigService,
      authService as unknown as AuthService,
    );
  });

  it('resolves the LIVE principal for an access token (fresh roles/permissions)', async () => {
    const principal = { id: 'u1', tenantId: 't1', roles: ['owner'], permissions: [] };
    const tenant = { id: 't1', approval_status: 'approved', is_active: true };
    authService.buildAuthenticatedUserWithTenant.mockResolvedValueOnce({ principal, tenant });

    const result = await strategy.validate(req, { sub: 'u1', tenantId: 't1', type: 'access' } as any);

    expect(authService.buildAuthenticatedUserWithTenant).toHaveBeenCalledWith('u1');
    expect(result).toBe(principal);
    // Stashed for ActiveTenantGuard to reuse — never merged into the principal itself.
    expect(req.preloadedTenant).toBe(tenant);
    expect((result as any).tenant).toBeUndefined();
  });

  it('rejects a non-access token type (e.g. a patient/refresh token)', async () => {
    await expect(
      strategy.validate(req, { sub: 'p1', type: 'patient' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    expect(authService.buildAuthenticatedUserWithTenant).not.toHaveBeenCalled();
    expect(req.preloadedTenant).toBeUndefined();
  });
});
