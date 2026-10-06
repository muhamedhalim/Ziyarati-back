import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import type { CookieOptions, Response } from 'express';
import { ttlToMs } from '../../common/utils/ttl';

/**
 * Centralises all auth cookie handling so the controller never hand-rolls
 * cookie attributes. Three cookies are issued:
 *
 *  - access_token  : HttpOnly, root-scoped (`/`), short-lived. Must reach the
 *                    Socket.IO gateway's handshake at /socket.io/, which sits
 *                    outside the Nest global prefix — a narrower path would
 *                    silently never be sent there (mirrors guest_token).
 *  - refresh_token : HttpOnly, scoped to /api/v1/auth ONLY (so it is sent to
 *                    the refresh/logout endpoints and nowhere else).
 *  - csrf_token    : NON-HttpOnly (readable by the SPA) for the double-submit
 *                    CSRF defence. It carries no authority on its own.
 *
 * Attributes are environment-driven: Secure in production, SameSite/domain
 * configurable. No `domain` is set by default → host-only cookies, which work
 * unchanged whether the SPA talks to the API cross-origin (localhost:3000 →
 * :3001) or same-origin via a Next.js rewrite.
 */
@Injectable()
export class CookieService {
  static readonly ACCESS_COOKIE = 'access_token';
  static readonly REFRESH_COOKIE = 'refresh_token';
  static readonly CSRF_COOKIE = 'csrf_token';

  private static readonly AUTH_PATH = '/api/v1/auth';

  constructor(private readonly config: ConfigService) {}

  private get secure(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  private get sameSite(): CookieOptions['sameSite'] {
    return this.config.get<string>(
      'COOKIE_SAMESITE',
      'lax',
    ) as CookieOptions['sameSite'];
  }

  private get domain(): string | undefined {
    return this.config.get<string>('COOKIE_DOMAIN') || undefined;
  }

  /**
   * Scope of the readable `csrf_token` / session-presence cookie ONLY.
   *
   * Falls back to `COOKIE_DOMAIN`, so a deployment that sets neither (or only
   * `COOKIE_DOMAIN`) behaves exactly as before. It exists for direct API routing
   * (residency plan P9): the SPA, on the app host, must be able to read this
   * cookie (to echo it as `X-CSRF-Token` and for the route gate in `proxy.ts`),
   * so it has to be scoped to the parent domain. The access/refresh cookies do
   * NOT have to be — left host-only on the API host they are never sent to the
   * app host, so the page-serving tier (Vercel) does not receive a bearer
   * credential on every document request. `COOKIE_DOMAIN` would widen all three
   * together; this splits the one cookie that has no authority from the two
   * that do.
   */
  private get csrfDomain(): string | undefined {
    return this.config.get<string>('CSRF_COOKIE_DOMAIN') || this.domain;
  }

  /** Shared options for the HttpOnly auth cookies. */
  private httpOnlyBase(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: this.sameSite,
      domain: this.domain,
    };
  }

  /** Sets the HttpOnly access + refresh cookies, lifetimes matching the JWTs. */
  setAuthCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ): void {
    res.cookie(CookieService.ACCESS_COOKIE, tokens.accessToken, {
      ...this.httpOnlyBase(),
      path: '/',
      maxAge: ttlToMs(this.config.get<string>('JWT_ACCESS_TTL', '15m')),
    });

    res.cookie(CookieService.REFRESH_COOKIE, tokens.refreshToken, {
      ...this.httpOnlyBase(),
      path: CookieService.AUTH_PATH,
      maxAge: ttlToMs(this.config.get<string>('JWT_REFRESH_TTL', '7d')),
    });
  }

  /**
   * Issues a fresh double-submit CSRF token. Readable by JS so the SPA can echo
   * it in the `X-CSRF-Token` header; the guard compares header vs cookie.
   * Returns the value (handy for tests / immediate use).
   */
  setCsrfCookie(res: Response): string {
    const token = randomBytes(32).toString('hex');
    res.cookie(CookieService.CSRF_COOKIE, token, {
      httpOnly: false,
      secure: this.secure,
      sameSite: this.sameSite,
      domain: this.csrfDomain,
      path: '/',
      maxAge: ttlToMs(this.config.get<string>('JWT_REFRESH_TTL', '7d')),
    });
    return token;
  }

  /** Clears all auth cookies. Path/options MUST match how they were set. */
  clearAuthCookies(res: Response): void {
    res.clearCookie(CookieService.ACCESS_COOKIE, {
      ...this.httpOnlyBase(),
      path: '/',
    });
    res.clearCookie(CookieService.REFRESH_COOKIE, {
      ...this.httpOnlyBase(),
      path: CookieService.AUTH_PATH,
    });
    res.clearCookie(CookieService.CSRF_COOKIE, {
      httpOnly: false,
      secure: this.secure,
      sameSite: this.sameSite,
      domain: this.csrfDomain,
      path: '/',
    });
  }
}
