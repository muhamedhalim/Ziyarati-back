/**
 * Shared constants for the authentication abuse-resistance limiters
 * (009-auth-abuse-resistance, ZT-002 / ZT-006). No magic value — scope name,
 * key namespace fragment, or test-environment relaxation multiplier — may
 * appear directly in a service; everything lives here so the six limiter
 * scopes stay a single closed enum shared by the limiter, the metrics label
 * set and every test.
 */

/**
 * Closed enum of every limiter this feature defines. Mirrors the
 * `auth_abuse_limiter_events_total{limiter,...}` metric label set in
 * MetricsService exactly — the two must never drift apart.
 */
export const AUTH_ABUSE_LIMITER_SCOPE = {
  LOGIN: 'login',
  FORGOT: 'forgot',
  RESET_ACCOUNT: 'reset_account',
  RESET_INVALID: 'reset_invalid',
  REGISTER_IDENTITY: 'register_identity',
  REGISTER_ENDPOINT: 'register_endpoint',
} as const;

export type AuthAbuseLimiterScope =
  (typeof AUTH_ABUSE_LIMITER_SCOPE)[keyof typeof AUTH_ABUSE_LIMITER_SCOPE];

export const AUTH_ABUSE_LIMITER_SCOPES: AuthAbuseLimiterScope[] = Object.values(
  AUTH_ABUSE_LIMITER_SCOPE,
);

/**
 * Namespace fragment every key this feature's limiters build starts with —
 * keeps them out of the throttler/cache/login-lockout key spaces. Full key
 * shape (data-model.md §1): `{cacheKeyPrefix()}auth:abuse:{scope}:{window}:{digest}`.
 */
export const AUTH_ABUSE_KEY_NAMESPACE = 'auth:abuse:';

/**
 * Endpoint-wide (non-identifier-keyed) limiter subjects use this literal
 * instead of a hashed value — `reset_invalid` and `register_endpoint` have no
 * per-caller subject to hash; the ceiling applies to everyone alike.
 */
export const AUTH_ABUSE_ENDPOINT_WIDE_SUBJECT = 'all';

/**
 * Multiplies every configured limit under `NODE_ENV=test`, mirroring
 * `PUBLIC_WEBHOOK_THROTTLE`'s `NODE_ENV === 'test' ? 1_000_000 : ...` shape
 * (whatsapp-webhook.controller.ts:52-54). Load-bearing: without it, the
 * existing e2e suites' request bursts — which land in one shared
 * test-process bucket — would trip these bounds instead of the assertions
 * they exist to prove (FR-021).
 */
export const AUTH_ABUSE_TEST_RELAXED_LIMIT = 1_000_000;

export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test';
}

/** Applies the test-environment relaxation to a configured limit. */
export function relaxedLimit(configuredLimit: number): number {
  return isTestEnvironment() ? AUTH_ABUSE_TEST_RELAXED_LIMIT : configuredLimit;
}
