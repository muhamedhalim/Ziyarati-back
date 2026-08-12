import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CsrfGuard } from './csrf.guard';
import { CookieService } from '../cookie.service';
import * as constantTimeUtil from '../../../common/utils/constant-time.util';
import {
  createMockExecutionContext,
  createMockReflector,
} from '../../../../test/utils/mock-factories';

describe('CsrfGuard (double-submit cookie)', () => {
  let guard: CsrfGuard;
  let reflector: ReturnType<typeof createMockReflector>;

  beforeEach(() => {
    reflector = createMockReflector();
    reflector.getAllAndOverride.mockReturnValue(false);
    guard = new CsrfGuard(reflector as unknown as Reflector);
  });

  const ctx = (req: {
    method: string;
    cookies?: Record<string, string>;
    headers?: Record<string, string | string[]>;
  }) => createMockExecutionContext({ headers: {}, cookies: {}, ...req });

  it.each(['GET', 'HEAD', 'OPTIONS'])('allows safe method %s without checks', (method) => {
    expect(guard.canActivate(ctx({ method }))).toBe(true);
  });

  it('allows a state-changing request that carries no auth cookie (bearer/webhook)', () => {
    expect(guard.canActivate(ctx({ method: 'POST', cookies: {}, headers: {} }))).toBe(true);
  });

  it('allows when the CSRF header matches the CSRF cookie', () => {
    const req = ctx({
      method: 'POST',
      cookies: {
        [CookieService.ACCESS_COOKIE]: 'access',
        [CookieService.CSRF_COOKIE]: 'tok-123',
      },
      headers: { 'x-csrf-token': 'tok-123' },
    });
    expect(guard.canActivate(req)).toBe(true);
  });

  it('rejects a cookie-authed mutation with a missing CSRF header', () => {
    const req = ctx({
      method: 'POST',
      cookies: { [CookieService.ACCESS_COOKIE]: 'access', [CookieService.CSRF_COOKIE]: 'tok-123' },
      headers: {},
    });
    expect(() => guard.canActivate(req)).toThrow(ForbiddenException);
  });

  it('rejects a cookie-authed mutation with a mismatched, different-length CSRF token', () => {
    const req = ctx({
      method: 'POST',
      cookies: { [CookieService.ACCESS_COOKIE]: 'access', [CookieService.CSRF_COOKIE]: 'tok-123' },
      headers: { 'x-csrf-token': 'attacker' },
    });
    expect(() => guard.canActivate(req)).toThrow(ForbiddenException);
  });

  it('rejects a cookie-authed mutation with a mismatched, SAME-length CSRF token (ZT-H01)', () => {
    const req = ctx({
      method: 'POST',
      cookies: { [CookieService.ACCESS_COOKIE]: 'access', [CookieService.CSRF_COOKIE]: 'tok-123' },
      headers: { 'x-csrf-token': 'tok-456' }, // same length as 'tok-123', different content
    });
    expect(() => guard.canActivate(req)).toThrow(ForbiddenException);
  });

  it('uses the shared constant-time primitive for the comparison, with no direct equality on the token remaining (ZT-H01/FR-039 structural check)', () => {
    const spy = jest.spyOn(constantTimeUtil, 'constantTimeEqual');
    const req = ctx({
      method: 'POST',
      cookies: { [CookieService.ACCESS_COOKIE]: 'access', [CookieService.CSRF_COOKIE]: 'tok-123' },
      headers: { 'x-csrf-token': 'tok-123' },
    });
    expect(guard.canActivate(req)).toBe(true);
    expect(spy).toHaveBeenCalledWith('tok-123', 'tok-123');
    spy.mockRestore();

    const guardSource: string = CsrfGuard.toString();
    expect(guardSource).not.toMatch(/cookieToken\s*===\s*headerValue/);
  });

  it('accepts the first value when the CSRF header arrives as an array', () => {
    const req = ctx({
      method: 'PUT',
      cookies: { [CookieService.ACCESS_COOKIE]: 'access', [CookieService.CSRF_COOKIE]: 'tok-123' },
      headers: { 'x-csrf-token': ['tok-123', 'second'] },
    });
    expect(guard.canActivate(req)).toBe(true);
  });

  it('enforces CSRF when only the refresh cookie is present', () => {
    const req = ctx({
      method: 'POST',
      cookies: { [CookieService.REFRESH_COOKIE]: 'refresh' },
      headers: {},
    });
    expect(() => guard.canActivate(req)).toThrow(ForbiddenException);
  });

  it('allows a @SkipCsrf() route (e.g. login) even with a stale auth cookie and no CSRF header', () => {
    // Reproduces the real bug: browser still carries a stale access_token
    // cookie (path overlap with /api/v1/auth/*) from an expired session, and
    // the readable csrf_token cookie was cleared client-side — login must
    // still succeed because the handler never reads that stale cookie.
    reflector.getAllAndOverride.mockReturnValue(true);
    const req = ctx({
      method: 'POST',
      cookies: { [CookieService.ACCESS_COOKIE]: 'stale-access-token' },
      headers: {},
    });
    expect(guard.canActivate(req)).toBe(true);
  });
});
