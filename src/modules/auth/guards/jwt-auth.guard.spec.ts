import { Reflector } from '@nestjs/core';

import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyAuthGuard } from '../../platform/guards/api-key-auth.guard';
import { ErrorCode } from '../../../common/errors';
import {
  createMockReflector,
  createMockExecutionContext,
} from '../../../../test/utils/mock-factories';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: ReturnType<typeof createMockReflector>;
  let apiKeyAuth: { canActivate: jest.Mock };

  beforeEach(() => {
    reflector = createMockReflector();
    apiKeyAuth = { canActivate: jest.fn() };
    guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      apiKeyAuth as unknown as ApiKeyAuthGuard,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('bypasses authentication for @Public() routes not marked as API-key routes', () => {
    // isPublic -> true, isApiKeyRoute -> false
    reflector.getAllAndOverride.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(guard.canActivate(createMockExecutionContext())).toBe(true);
    expect(apiKeyAuth.canActivate).not.toHaveBeenCalled();
  });

  it('delegates to ApiKeyAuthGuard for @Public() routes marked as API-key routes', async () => {
    // isPublic -> true, isApiKeyRoute -> true
    reflector.getAllAndOverride.mockReturnValueOnce(true).mockReturnValueOnce(true);
    apiKeyAuth.canActivate.mockResolvedValue(true);
    const ctx = createMockExecutionContext();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(apiKeyAuth.canActivate).toHaveBeenCalledWith(ctx);
  });

  it('propagates ApiKeyAuthGuard rejection for a bad API key', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true).mockReturnValueOnce(true);
    apiKeyAuth.canActivate.mockRejectedValue(
      Object.assign(new Error('bad key'), { code: ErrorCode.UNAUTHORIZED }),
    );

    await expect(guard.canActivate(createMockExecutionContext())).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('delegates to passport for non-public routes', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const superProto = Object.getPrototypeOf(JwtAuthGuard.prototype);
    const superSpy = jest.spyOn(superProto, 'canActivate').mockReturnValue(true);

    expect(guard.canActivate(createMockExecutionContext())).toBe(true);
    expect(superSpy).toHaveBeenCalled();
  });

  describe('handleRequest', () => {
    it('returns the authenticated principal', () => {
      const user = { id: 'u1' };
      expect(guard.handleRequest(null, user)).toBe(user);
    });

    it('throws UNAUTHORIZED when passport errored', () => {
      expect(() => guard.handleRequest(new Error('bad'), null)).toThrow(
        expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
      );
    });

    it('throws UNAUTHORIZED when no user was resolved', () => {
      expect(() => guard.handleRequest(null, null)).toThrow(
        expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
      );
    });
  });
});
