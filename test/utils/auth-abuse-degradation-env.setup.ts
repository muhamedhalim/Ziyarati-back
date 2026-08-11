/**
 * Same pattern as login-protection-env.setup.ts, extended with the degraded-
 * mode factor: a low threshold + short TTL so the degradation suite runs
 * fast, and an explicit (default-matching) degraded factor so the expected
 * degraded threshold (`ceil(3 * 0.5) = 2`) is stated, not just inherited.
 * MUST be imported before `createE2eApp` (see that file's own docstring for
 * why — ConfigModule.forRoot() snapshots process.env synchronously on
 * AppModule's first import in this test file's module registry).
 */
process.env.AUTH_LOGIN_MAX_FAILED_ATTEMPTS = '3';
process.env.AUTH_LOGIN_LOCKOUT_TTL_SECONDS = '2';
process.env.AUTH_ABUSE_DEGRADED_FACTOR = '0.5';
process.env.AUTH_ABUSE_FALLBACK_WIDTH = '4096';

export {};
