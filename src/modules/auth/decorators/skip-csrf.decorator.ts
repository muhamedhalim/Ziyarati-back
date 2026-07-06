import { SetMetadata } from '@nestjs/common';

export const IS_SKIP_CSRF_KEY = 'isSkipCsrf';

/**
 * Exempts a route from the double-submit CSRF check (see `CsrfGuard`).
 *
 * Use ONLY on session-genesis endpoints that never read an incoming auth
 * cookie to authorize the action (login, registration, forgot/reset
 * password) — they exclusively ISSUE new credentials for whatever
 * identity the request body proves, so a stale `access_token`/
 * `refresh_token` cookie left over from a previous/expired session (sent
 * automatically by the browser because its path overlaps `/api/v1/auth/*`)
 * is not a real CSRF surface, just accidental cookie-path overlap.
 *
 * Endpoints that DO read the incoming auth cookie to act on an existing
 * session (`/auth/refresh`, `/auth/logout`) must keep CSRF enforced and
 * must NOT use this decorator.
 */
export const SkipCsrf = () => SetMetadata(IS_SKIP_CSRF_KEY, true);
