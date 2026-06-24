import { ConfigService } from '@nestjs/config';

import { CookieService } from './cookie.service';
import { createMockConfigService } from '../../../test/utils/mock-factories';

describe('CookieService', () => {
  const buildRes = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });

  const build = (overrides: Record<string, unknown> = {}) =>
    new CookieService(createMockConfigService(overrides) as unknown as ConfigService);

  describe('setAuthCookies', () => {
    it('sets HttpOnly access + refresh cookies scoped to their paths', () => {
      const res = buildRes();
      build().setAuthCookies(res as any, { accessToken: 'AT', refreshToken: 'RT' });

      expect(res.cookie).toHaveBeenCalledWith(
        CookieService.ACCESS_COOKIE,
        'AT',
        expect.objectContaining({ httpOnly: true, path: '/api/v1', maxAge: expect.any(Number) }),
      );
      // Refresh cookie is restricted to the auth path only.
      expect(res.cookie).toHaveBeenCalledWith(
        CookieService.REFRESH_COOKIE,
        'RT',
        expect.objectContaining({ httpOnly: true, path: '/api/v1/auth' }),
      );
    });

    it('marks cookies Secure in production', () => {
      const res = buildRes();
      build({ NODE_ENV: 'production' }).setAuthCookies(res as any, {
        accessToken: 'AT',
        refreshToken: 'RT',
      });
      expect(res.cookie).toHaveBeenCalledWith(
        CookieService.ACCESS_COOKIE,
        'AT',
        expect.objectContaining({ secure: true }),
      );
    });

    it('leaves cookies non-Secure outside production', () => {
      const res = buildRes();
      build({ NODE_ENV: 'development' }).setAuthCookies(res as any, {
        accessToken: 'AT',
        refreshToken: 'RT',
      });
      expect(res.cookie).toHaveBeenCalledWith(
        CookieService.ACCESS_COOKIE,
        'AT',
        expect.objectContaining({ secure: false }),
      );
    });
  });

  describe('setCsrfCookie', () => {
    it('issues a NON-HttpOnly, root-path CSRF token and returns it', () => {
      const res = buildRes();
      const token = build().setCsrfCookie(res as any);

      expect(token).toEqual(expect.any(String));
      expect(token.length).toBeGreaterThan(0);
      expect(res.cookie).toHaveBeenCalledWith(
        CookieService.CSRF_COOKIE,
        token,
        expect.objectContaining({ httpOnly: false, path: '/' }),
      );
    });
  });

  describe('configurable attributes', () => {
    it('honours an explicit SameSite override and cookie domain', () => {
      const res = buildRes();
      build({ COOKIE_SAMESITE: 'strict', COOKIE_DOMAIN: '.clinic.app' }).setAuthCookies(
        res as any,
        { accessToken: 'AT', refreshToken: 'RT' },
      );
      expect(res.cookie).toHaveBeenCalledWith(
        CookieService.ACCESS_COOKIE,
        'AT',
        expect.objectContaining({ sameSite: 'strict', domain: '.clinic.app' }),
      );
    });
  });

  describe('clearAuthCookies', () => {
    it('clears all three cookies with matching paths', () => {
      const res = buildRes();
      build().clearAuthCookies(res as any);

      expect(res.clearCookie).toHaveBeenCalledWith(
        CookieService.ACCESS_COOKIE,
        expect.objectContaining({ path: '/api/v1' }),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        CookieService.REFRESH_COOKIE,
        expect.objectContaining({ path: '/api/v1/auth' }),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        CookieService.CSRF_COOKIE,
        expect.objectContaining({ path: '/' }),
      );
    });
  });
});
