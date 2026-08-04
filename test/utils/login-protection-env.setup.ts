/**
 * Sets a LOW failed-attempt threshold and a SHORT protection window BEFORE
 * AppModule is ever imported in this process/test file, so the container-
 * backed concurrency/TTL suite can exercise both the threshold and the
 * expiry quickly.
 *
 * Why this has to be a separate file, imported FIRST: `ConfigModule.forRoot()`
 * runs synchronously as part of AppModule's `@Module({...})` decorator, which
 * executes the ONE time AppModule is first `require()`'d in this Jest test
 * file's module registry — not per `Test.createTestingModule().compile()`
 * call. A value set in `beforeAll` (after `createE2eApp` — and therefore
 * AppModule — was already imported) arrives too late: the validated config
 * snapshot is already frozen, and the suite would silently run at the
 * production default (5 attempts / 900s) instead. See
 * `integration-rate-limit-env.setup.ts` for the identical pattern applied to
 * the integration-API rate limit.
 */
process.env.AUTH_LOGIN_MAX_FAILED_ATTEMPTS = '3';
process.env.AUTH_LOGIN_LOCKOUT_TTL_SECONDS = '2';

export {};
