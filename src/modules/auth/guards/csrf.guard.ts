import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CookieService } from '../cookie.service';
import { IS_SKIP_CSRF_KEY } from '../decorators/skip-csrf.decorator';

/**
 * Double-submit-cookie CSRF guard for cookie-based auth.
 *
 * CSRF risk only exists when the browser AUTO-ATTACHES the auth cookie, so this
 * guard enforces a token check *only* on:
 *   - state-changing methods (not GET/HEAD/OPTIONS), AND
 *   - requests that actually carry the `access_token` cookie.
 *
 * This naturally exempts:
 *   - safe/idempotent reads,
 *   - unauthenticated calls (login, register, password reset, provider
 *     webhooks) — they have no auth cookie, hence no CSRF surface,
 *   - header-bearer clients (Swagger/dev) — no cookie, so no check.
 *
 * The check itself: the SPA-readable `csrf_token` cookie must equal the
 * `X-CSRF-Token` request header. An attacker's cross-site request cannot read
 * the victim's cookie to forge the header (same-origin policy), so it fails.
 *
 * Cookie SCOPING nuance: `access_token` is scoped to `/api/v1` and
 * `refresh_token` to `/api/v1/auth`, so the browser still attaches them to
 * `/api/v1/auth/*` requests — including login/register — whenever a stale
 * cookie from a previous/expired session happens to still be present. Those
 * genesis endpoints never read the incoming cookie to authorize anything (they
 * only issue brand-new credentials for whatever the request body proves), so
 * that stale cookie is not a real CSRF signal there. `@SkipCsrf()` opts a
 * handler out of this check for exactly that reason — see its docstring.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private static readonly SAFE_METHODS = new Set([
    'GET',
    'HEAD',
    'OPTIONS',
  ]);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (CsrfGuard.SAFE_METHODS.has(req.method)) return true;

    const skipCsrf = this.reflector.getAllAndOverride<boolean>(
      IS_SKIP_CSRF_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skipCsrf) return true;

    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;

    // No auth cookie → not a cookie-authenticated request → no CSRF surface.
      const hasAuthCookie =
        cookies[CookieService.ACCESS_COOKIE] ||
        cookies[CookieService.REFRESH_COOKIE];

      if (!hasAuthCookie) {
        return true;
      }
      
    const cookieToken = cookies[CookieService.CSRF_COOKIE];
    const headerToken = req.headers['x-csrf-token'];
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (cookieToken && headerValue && cookieToken === headerValue) {
      return true;
    }

    throw new ForbiddenException('CSRF token missing or invalid');
  }
}
