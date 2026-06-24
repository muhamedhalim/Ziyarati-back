import { ForbiddenException } from '@nestjs/common';

import { CsrfGuard } from './csrf.guard';
import { CookieService } from '../cookie.service';
import { createMockExecutionContext } from '../../../../test/utils/mock-factories';

describe('CsrfGuard (double-submit cookie)', () => {
  let guard: CsrfGuard;

  beforeEach(() => {
    guard = new CsrfGuard();
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

  it('rejects a cookie-authed mutation with a mismatched CSRF token', () => {
    const req = ctx({
      method: 'POST',
      cookies: { [CookieService.ACCESS_COOKIE]: 'access', [CookieService.CSRF_COOKIE]: 'tok-123' },
      headers: { 'x-csrf-token': 'attacker' },
    });
    expect(() => guard.canActivate(req)).toThrow(ForbiddenException);
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
});
