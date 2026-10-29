import { ConfigService } from '@nestjs/config';

import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';
import { ErrorCode } from '../../../common/errors';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let authService: {
    buildAuthenticatedUserWithTenant: jest.Mock;
    isSessionLive: jest.Mock;
  };
  const req = {} as any;

  beforeEach(() => {
    req.preloadedTenant = undefined;
    authService = {
      buildAuthenticatedUserWithTenant: jest.fn(),
      isSessionLive: jest.fn(),
    };
    strategy = new JwtStrategy(
      createMockConfigService({
        JWT_ACCESS_SECRET: 'test-secret',
      }) as unknown as ConfigService,
      authService as unknown as AuthService,
    );
  });

  it('resolves the LIVE principal for an access token (fresh roles/permissions)', async () => {
    const principal = {
      id: 'u1',
      tenantId: 't1',
      roles: ['owner'],
      permissions: [],
    };
    const tenant = { id: 't1', approval_status: 'approved', is_active: true };
    authService.buildAuthenticatedUserWithTenant.mockResolvedValueOnce({
      principal,
      tenant,
    });

    const result = await strategy.validate(req, {
      sub: 'u1',
      tenantId: 't1',
      type: 'access',
    } as any);

    expect(authService.buildAuthenticatedUserWithTenant).toHaveBeenCalledWith(
      'u1',
    );
    expect(result).toBe(principal);
    // Stashed for ActiveTenantGuard to reuse — never merged into the principal itself.
    expect(req.preloadedTenant).toBe(tenant);
    expect((result as any).tenant).toBeUndefined();
  });

  describe('session binding (SEC-02)', () => {
    const principal = {
      id: 'u1',
      tenantId: 't1',
      roles: ['owner'],
      permissions: [],
    };
    const sid = '44444444-4444-4444-8444-444444444444';

    beforeEach(() => {
      authService.buildAuthenticatedUserWithTenant.mockResolvedValue({
        principal,
        tenant: null,
      });
    });

    it('accepts a token whose session is still signed in', async () => {
      authService.isSessionLive.mockResolvedValueOnce(true);
      await expect(
        strategy.validate(req, {
          sub: 'u1',
          tenantId: 't1',
          type: 'access',
          sid,
        } as any),
      ).resolves.toBe(principal);
      expect(authService.isSessionLive).toHaveBeenCalledWith(sid);
    });

    it('refuses a signed, unexpired token once its session was logged out', async () => {
      authService.isSessionLive.mockResolvedValueOnce(false);
      await expect(
        strategy.validate(req, {
          sub: 'u1',
          tenantId: 't1',
          type: 'access',
          sid,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
      expect(req.preloadedTenant).toBeUndefined();
    });

    it('still honours a pre-SEC-02 token without sid until it expires', async () => {
      await expect(
        strategy.validate(req, {
          sub: 'u1',
          tenantId: 't1',
          type: 'access',
        } as any),
      ).resolves.toBe(principal);
      expect(authService.isSessionLive).not.toHaveBeenCalled();
    });
  });

  it('rejects a non-access token type (e.g. a patient/refresh token)', async () => {
    await expect(
      strategy.validate(req, { sub: 'p1', type: 'patient' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    expect(authService.buildAuthenticatedUserWithTenant).not.toHaveBeenCalled();
    expect(req.preloadedTenant).toBeUndefined();
  });
});
