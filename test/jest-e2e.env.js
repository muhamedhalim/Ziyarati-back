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
