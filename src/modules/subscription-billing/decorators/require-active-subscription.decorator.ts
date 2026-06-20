import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ACTIVE_SUBSCRIPTION_KEY = 'requireActiveSubscription';

/**
 * Gates a route on the tenant having platform access, resolved through the full
 * priority chain (global mode → free override → paid subscription). Enforced by
 * SubscriptionAccessGuard — a denial returns 403.
 *
 * Adoption is one line on any protected route in any module:
 *
 *   @RequireActiveSubscription()
 *   @UseGuards(SubscriptionAccessGuard)
 *   @Post('appointments') ...
 *
 * Under FREE platform mode or an active override the guard always allows, so a
 * route can carry this annotation permanently and it simply becomes a no-op when
 * the platform is free.
 */
export const RequireActiveSubscription = () =>
  SetMetadata(REQUIRE_ACTIVE_SUBSCRIPTION_KEY, true);
