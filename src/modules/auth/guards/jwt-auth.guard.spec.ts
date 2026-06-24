import { Reflector } from '@nestjs/core';

import { JwtAuthGuard } from './jwt-auth.guard';
import { ErrorCode } from '../../../common/errors';
import {
  createMockReflector,
  createMockExecutionContext,
} from '../../../../test/utils/mock-factories';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: ReturnType<typeof createMockReflector>;

  beforeEach(() => {
    reflector = createMockReflector();
    guard = new JwtAuthGuard(reflector as unknown as Reflector);
  });

  afterEach(() => jest.restoreAllMocks());

  it('bypasses authentication for @Public() routes', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(guard.canActivate(createMockExecutionContext())).toBe(true);
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
