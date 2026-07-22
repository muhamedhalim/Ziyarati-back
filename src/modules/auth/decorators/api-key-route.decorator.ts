import { SetMetadata } from '@nestjs/common';

export const IS_API_KEY_ROUTE_KEY = 'isApiKeyRoute';

/**
 * Marks a `@Public()` route as authenticated by an API key rather than being
 * genuinely open. JwtAuthGuard (global) checks this marker BEFORE returning
 * for a public route: if set, it resolves the API key right there — so
 * `request.user` is already populated by the time later global guards
 * (MaintenanceGuard, and anything else reading `request.user`) run. Without
 * this, a route-level-only API-key guard would run AFTER those global guards
 * and they would silently treat the request as unauthenticated/public.
 *
 * Applied internally by `@ApiKeyProtected()` — routes should use that
 * decorator rather than this marker directly.
 */
export const ApiKeyRoute = () => SetMetadata(IS_API_KEY_ROUTE_KEY, true);
