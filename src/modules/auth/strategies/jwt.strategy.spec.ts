import { ConfigService } from '@nestjs/config';

import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';
import { ErrorCode } from '../../../common/errors';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let authService: { buildAuthenticatedUser: jest.Mock };

  beforeEach(() => {
    authService = { buildAuthenticatedUser: jest.fn() };
    strategy = new JwtStrategy(
      createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as unknown as ConfigService,
      authService as unknown as AuthService,
    );
  });

  it('resolves the LIVE principal for an access token (fresh roles/permissions)', async () => {
    const principal = { id: 'u1', tenantId: 't1', roles: ['owner'], permissions: [] };
    authService.buildAuthenticatedUser.mockResolvedValueOnce(principal);

    const result = await strategy.validate({ sub: 'u1', tenantId: 't1', type: 'access' } as any);

    expect(authService.buildAuthenticatedUser).toHaveBeenCalledWith('u1');
    expect(result).toBe(principal);
  });

  it('rejects a non-access token type (e.g. a patient/refresh token)', async () => {
    await expect(
      strategy.validate({ sub: 'p1', type: 'patient' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    expect(authService.buildAuthenticatedUser).not.toHaveBeenCalled();
  });
});
