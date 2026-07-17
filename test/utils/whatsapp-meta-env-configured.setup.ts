/**
 * Zero-dependency side-effect module: sets deterministic Meta test env vars.
 *
 * MUST be the FIRST import in any e2e spec that needs Meta "configured" —
 * before anything that transitively imports AppModule. `ConfigModule.forRoot()`
 * reads `process.env` (merged with `.env`) SYNCHRONOUSLY the moment
 * `app.module.ts` is `require()`'d, and caches the result (`cache: true`).
 * Setting `process.env` any later has no effect on an already-compiled
 * ConfigService. This file has no imports of its own so requiring it can
 * never accidentally pull AppModule in ahead of itself.
 */
export const TEST_META_ENV = {
  META_APP_ID: 'test-app-id',
  META_APP_SECRET: 'test-app-secret',
  META_EMBEDDED_SIGNUP_CONFIG_ID: 'test-config-id',
  META_GRAPH_API_VERSION: 'v21.0',
  META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
};

Object.assign(process.env, TEST_META_ENV);
process.env.CREDENTIALS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.JWT_ACCESS_SECRET ??= 'dev-access-secret';
