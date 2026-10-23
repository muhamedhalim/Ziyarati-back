/**
 * Forces every e2e test file onto the migrations-built `ziyarati_e2e` database
 * (see setup-e2e-db.js) instead of whatever `.env` happens to point at.
 *
 * ROOT CAUSE this closes: `.env` points at the shared dev DB with
 * `TYPEORM_SYNCHRONIZE=true`. Synchronize DROPS every index it cannot derive
 * from entity metadata — including the partial unique indexes
 * (`UQ_integration_sync_active`, `UQ_integration_inbound_events_replay`, ...)
 * that the integration platform's duplicate-prevention relies on. Running e2e
 * against that DB doesn't fail loudly: the app boots fine and the assertions
 * that depend on those indexes just silently observe the wrong (permissive)
 * behavior (e.g. a second concurrent sync start returns 200 instead of 409).
 *
 * `setupFiles` runs once per test file, before the test file's own imports —
 * so these assignments land in `process.env` before `ConfigModule.forRoot()`
 * (or any `dotenv/config` import) runs. dotenv only fills in keys that are NOT
 * already set, so these values win over `.env` without needing `override: true`.
 *
 * Run `node test/setup-e2e-db.js` (or `npm run pretest:e2e`) at least once
 * before this suite to create/migrate the target database.
 */
require('dotenv/config');
const HOST = process.env.DB_HOST || 'localhost';
const PORT = process.env.DB_PORT || '5432';
const USER = process.env.DB_USERNAME || 'postgres';
const PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.E2E_DB_NAME || 'ziyarati_e2e';

process.env.DB_NAME = DB_NAME;
process.env.DATABASE_URL = `postgres://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${DB_NAME}`;
process.env.TYPEORM_SYNCHRONIZE = 'false';

/**
 * Same rationale as the DB override above, for Redis (009-auth-abuse-
 * resistance, FR-058): `.env`'s `REDIS_URL` targets whatever Redis the
 * developer runs locally for day-to-day work — on this machine, a
 * long-lived, always-up `ziyaratech-redis` container. Several e2e specs
 * (auth-abuse-redis-degradation, login-protection, auth-abuse-forgot-
 * password) deliberately `docker stop`/`start` a Redis container mid-run to
 * prove degraded-mode and recovery behaviour — see
 * test/utils/docker-redis-control.ts. That helper targets a dedicated
 * disposable container (`zt-e2e-redis`, default port 63790 per
 * specs/009-auth-abuse-resistance/quickstart.md §0), never the shared dev
 * one. Without this override, `REDIS_URL` from `.env` would still point the
 * app under test at the shared dev Redis while the test stops a DIFFERENT,
 * unrelated container — silently turning every "Redis unavailable" scenario
 * into a no-op against a Redis that never actually went down (observed
 * directly: T065/T067 in auth-abuse-forgot-password.e2e-spec.ts passed with
 * healthy-mode budgets instead of degraded ones until this fix landed).
 * `ZT_E2E_REDIS_URL` mirrors docker-redis-control.ts's own
 * `ZT_E2E_REDIS_CONTAINER` override pattern for whoever maps the container
 * to a non-default port.
 */
process.env.REDIS_URL = process.env.ZT_E2E_REDIS_URL || 'redis://127.0.0.1:63790';

/**
 * ZT-FINAL-001 — per-test-file Redis key namespace.
 *
 * ROOT CAUSE this closes: every auth-abuse limiter key is built as
 * `${cacheKeyPrefix()}auth:abuse:{scope}:{window}:{subject}`
 * (`fixed-window-limiter.service.ts:179`) or
 * `${cacheKeyPrefix()}auth:login:fail:{hash}`
 * (`login-protection.service.ts:197`). With one shared Redis and one shared
 * prefix, that state OUTLIVES the test file that created it.
 *
 * The `FORGOT` limiter deliberately has NO `NODE_ENV=test` relaxation
 * (auth.service.ts — its own comment explains why, and that decision is
 * load-bearing: relaxing it would delete the coverage the suite exists to
 * provide). So its budget is genuinely consumed across sibling suites —
 * including `auth-abuse-redis-degradation`, which stops and starts Redis
 * mid-run. `auth-abuse-forgot-password`'s T061 compares a burst against a
 * REGISTERED address with a burst against an UNREGISTERED one and asserts
 * they are identical at every position; that comparison is only meaningful
 * when both identities start from the same budget. Whether they do depended
 * on which files ran first — the test passed alone (18/18) and in the full
 * 33-suite ordering (315/315) but failed when a 5-suite subset ran together.
 *
 * `setupFiles` runs ONCE PER TEST FILE, before that file's imports, so a
 * value generated here is stable within a file and distinct across files —
 * exactly the isolation boundary needed.
 *
 * `QUEUE_ENV_PREFIX` is an EXISTING PRODUCTION MECHANISM (queue.constants.ts
 * `bullPrefix()`/`cacheKeyPrefix()`), designed for exactly this — namespacing
 * one environment's queue and cache keys away from another's sharing a Redis.
 * Using it here means:
 *   - zero production code change,
 *   - zero change to any limiter's thresholds, windows or semantics,
 *   - no `NODE_ENV=test` bypass anywhere,
 *   - no key deletion: nothing is flushed, so a shared or developer Redis
 *     can never be damaged by running the suite.
 * Each file simply writes to its own namespace and ignores every other one.
 *
 * Set `ZT_E2E_QUEUE_PREFIX` to pin a fixed prefix (e.g. to inspect keys after
 * a run); doing so deliberately re-shares state across files.
 */
process.env.QUEUE_ENV_PREFIX =
  process.env.ZT_E2E_QUEUE_PREFIX ||
  `e2e${Date.now().toString(36)}${require('node:crypto').randomBytes(4).toString('hex')}`;

/**
 * ZT-FINAL-002 — the e2e suite must never reach a live email provider.
 *
 * ROOT CAUSE this closes: a developer or CI runner whose `.env` carries
 * live email settings made REAL outbound calls during e2e (observed as a
 * provider quota error for synthetic `@example.test` recipients). If those
 * credentials are shared with production, an e2e run can exhaust the real
 * password-reset delivery quota and silently degrade account recovery.
 *
 * Amazon SES is the only provider and is selected purely by
 * `EMAIL_ENABLED`, so:
 *   1. `EMAIL_ENABLED=false` — `EmailProviderFactory.resolve()` returns the
 *      NoopEmailProvider no matter which region/credentials are inherited.
 *   2. `RESEND_API_KEY=''` — the retired provider's key is never carried into
 *      a test process (nothing reads it any more; this keeps a stale live
 *      secret out of the environment).
 *
 * Production and development behaviour are untouched: this file is loaded
 * ONLY by `test/jest-e2e.json` / `jest-e2e-integration-platform.json`.
 * `test/security/e2e-env-invariants.spec.ts` asserts both of these.
 */
process.env.EMAIL_ENABLED = 'false';
process.env.RESEND_API_KEY = '';

/**
 * CR-55 — the e2e / security / AI-audit suites must never reach a live provider.
 *
 * ROOT CAUSE this closes: only email was blanked (above). A developer's `.env` also carries a live
 * OPENAI_API_KEY, Tap secret keys, an S3 bucket and AWS credentials, and the suites inherited all of
 * them: specs wrote to a REAL S3 bucket, and the CI run (no `.env`) failed the same specs because
 * they silently depended on those values. Blank them HERE so a local run and CI see the same,
 * credential-free environment, and anything that genuinely needs a provider uses a scripted fake.
 *
 * Empty string, not `delete`: dotenv only fills keys that are NOT set, so a deleted key would be
 * re-populated from `.env` when ConfigModule loads it; an empty value stays and every consumer
 * treats it as "not configured" (the Joi schema allows '' for all of these).
 *
 * Deliberately NOT blanked: META_APP_ID / META_APP_SECRET / CREDENTIALS_ENCRYPTION_KEY. Specs that
 * build the Meta config or store encrypted provider credentials need a value to exist; CI supplies
 * inert placeholders and no Meta host is reachable with them.
 */
for (const key of [
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'TAP_TEST_SECRET_KEY',
  'TAP_LIVE_SECRET_KEY',
  'S3_BUCKET',
  'S3_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
]) {
  process.env[key] = '';
}
