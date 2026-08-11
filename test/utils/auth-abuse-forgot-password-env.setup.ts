/**
 * Same pattern as login-protection-env.setup.ts: a low budget + short window
 * so this suite can exercise real threshold/degraded/expiry behaviour
 * quickly, set BEFORE AppModule is ever imported in this test file's module
 * registry (ConfigModule.forRoot() snapshots process.env synchronously on
 * first import — see that file's docstring for the full explanation).
 *
 * `AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW` is NOT relaxed by
 * `NODE_ENV === 'test'` (see auth.service.ts's own comment on why this
 * bound, unlike PUBLIC_WEBHOOK_THROTTLE, carries no such multiplier) — this
 * is the one and only way to get a fast, real threshold in an e2e suite.
 *
 * `AUTH_FORGOT_PASSWORD_WINDOW_SECONDS` is set to 60 — the schema's own
 * floor (env.validation.ts: `.min(60)`), not a smaller "fast test" value;
 * unlike the login-protection suite's TTL, this one cannot go lower. The
 * "normal use is never refused" test that needs the window to actually
 * elapse (T063) pays for this with a real ~61s sleep and a longer timeout.
 */
process.env.AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW = '5';
process.env.AUTH_FORGOT_PASSWORD_WINDOW_SECONDS = '60';
process.env.AUTH_ABUSE_DEGRADED_FACTOR = '0.5';
process.env.AUTH_ABUSE_FALLBACK_WIDTH = '4096';

/**
 * Degraded-mode tests in this suite deliberately stop Redis while sending
 * WITHIN-budget requests, which correctly proceed to a real email dispatch
 * (FR-062 — degraded mode suppresses only OVER-threshold requests). Without
 * this, that dispatch goes through the BullMQ PRODUCER connection
 * (producer-queues.ts), which is also Redis-backed and — by pre-existing,
 * out-of-scope design (redis.config.ts: `enableOfflineQueue: true`, no
 * commandTimeout) — buffers rather than fails fast, eventually exhausting
 * its default retry budget against a genuinely stopped Redis and crashing
 * the test process. EMAIL_SYNC routes dispatch through EmailDeliveryService
 * instead (Postgres-backed idempotency claim + direct provider call, see
 * email-delivery.service.ts) — no Redis/BullMQ involvement at all — so this
 * suite can exercise real degraded-mode email-dispatch behaviour without
 * tripping an unrelated queue-infrastructure retry policy this feature does
 * not own. EMAIL_ENABLED stays unset (defaults OFF outside production), so
 * the NOOP provider is used either way — no real provider call is made.
 */
process.env.EMAIL_SYNC = 'true';

export {};
