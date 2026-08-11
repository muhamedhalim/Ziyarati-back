/**
 * Same pattern as the other 009 abuse-bound env-setup files: low bounds +
 * the schema's own window floor, set BEFORE AppModule is ever imported in
 * this test file's module registry. Neither bound is relaxed by
 * `NODE_ENV === 'test'` — this endpoint's dedicated e2e suite is the only
 * caller of `POST /auth/register-owner` in the whole repository (confirmed
 * by grep before writing this suite), so there is nothing for a relaxation
 * to protect.
 *
 * `AUTH_REGISTER_OWNER_MAX_PER_IDENTITY` matches the documented PRODUCTION
 * default (plan.md) rather than an arbitrary test-only value, so the
 * identity-layer tests exercise the same shape a real deployment would see.
 * `AUTH_REGISTER_OWNER_WINDOW_SECONDS` is the schema's own floor (60,
 * env.validation.ts: `.min(60)`) — cannot go lower.
 *
 * `EMAIL_SYNC=true` — same reason as forgot-password's env-setup file:
 * `registerOwner` dispatches a welcome email (best-effort) on every
 * successful registration, and this suite's degraded-mode tests genuinely
 * stop Redis while creating real tenants, so email must not go through the
 * Redis-backed BullMQ producer during that window (redis.config.ts's
 * pre-existing, out-of-scope `enableOfflineQueue: true` / no
 * `commandTimeout` retry policy would otherwise eventually crash the test
 * process against a genuinely stopped Redis).
 */
process.env.AUTH_REGISTER_OWNER_MAX_PER_IDENTITY = '3';
process.env.AUTH_REGISTER_OWNER_ENDPOINT_CEILING = '8';
process.env.AUTH_REGISTER_OWNER_WINDOW_SECONDS = '60';
process.env.AUTH_ABUSE_DEGRADED_FACTOR = '0.5';
process.env.AUTH_ABUSE_FALLBACK_WIDTH = '4096';
process.env.EMAIL_SYNC = 'true';

export {};
