import { SetMetadata } from '@nestjs/common';

export const REQUIRE_FEATURE_KEY = 'requireFeature';

/**
 * Gates a route on a per-tenant feature flag. Enforced by FeatureGuard:
 * the caller's tenant must have the feature enabled, else 403.
 *
 *   @RequireFeature('ai.assistant')
 *   @Post('ai/chat') ...
 */
export const RequireFeature = (featureKey: string) =>
  SetMetadata(REQUIRE_FEATURE_KEY, featureKey);
