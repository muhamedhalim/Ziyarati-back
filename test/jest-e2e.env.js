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
