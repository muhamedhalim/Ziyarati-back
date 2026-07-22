/**
 * Sets a LOW per-key rate limit BEFORE AppModule is ever imported in this
 * process/test file.
 *
 * Why this has to be a separate file, imported FIRST: `ConfigModule.forRoot()`
 * runs synchronously as part of AppModule's `@Module({...})` decorator, which
 * executes the ONE time AppModule is first `require()`'d in this Jest test
 * file's module registry — not per `Test.createTestingModule().compile()`
 * call. Jest gives each `*.e2e-spec.ts` file its own fresh module registry, so
 * this snapshot only affects app instances built within THIS file, never other
 * e2e files. See whatsapp-meta-env-configured.setup.ts for the same pattern
 * applied to Meta env config.
 */
process.env.INTEGRATION_API_RATE_LIMIT_PER_MINUTE = '2';

export {};
