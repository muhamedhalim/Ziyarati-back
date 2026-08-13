import { SetMetadata } from '@nestjs/common';

import { FeatureKey } from '../feature-registry';

export const REQUIRE_FEATURE_KEY = 'requireFeature';

/**
 * Declares which platform capability a route belongs to. Enforced by
 * `FeatureGuard`, and read by `SubscriptionAccessGuard` so a super-admin
 * per-feature grant can stand in for a missing subscription on exactly this
 * route.
 *
 *   @RequireFeature(FeatureKey.AI_ASSISTANT)
 *   @Controller('ai/agents') …
 *
 * The parameter is `FeatureKey`, not `string`, on purpose: the previous
 * free-form signature let 10 controllers gate on `'ai'` while the catalog only
 * ever published `'ai.assistant'`, so the toggle a super-admin could reach was
 * not the key any route checked — and nothing failed until a request 403'd in
 * production. That mismatch is now a compile error.
 */
export const RequireFeature = (featureKey: FeatureKey) =>
  SetMetadata(REQUIRE_FEATURE_KEY, featureKey);
