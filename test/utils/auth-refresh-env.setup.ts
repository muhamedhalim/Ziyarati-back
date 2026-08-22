/**
 * Shortens the refresh-token RETRY WINDOW before AppModule is imported, so the
 * regression suite can exercise both sides of the boundary — a retry inside the
 * window (served from the recorded successor) and one outside it (treated as
 * token reuse) — without a 10-second sleep per assertion.
 *
 * Why this must be a separate file imported FIRST: `ConfigModule.forRoot()`
 * runs synchronously inside AppModule's `@Module({...})` decorator, which
 * executes the one time AppModule is first `require()`d in this Jest file's
 * module registry. Setting the value in `beforeAll` — after `createE2eApp` has
 * already pulled AppModule in — arrives too late: the validated config snapshot
 * is frozen and the suite silently runs at the production default. Same
 * mechanism, and same rationale, as `login-protection-env.setup.ts`.
 *
 * The RETRY BUDGET is deliberately left at its production default (3): the
 * bound being tested is the real one, only the clock is compressed.
 */
// 5s, not 2s: the retry BUDGET test needs room for (maxRetries + 1) retries that
// each clear the 500ms min-age floor (~2.6s total) while the TIME window is
// still open, so that it is provably the budget — not the clock — that stops
// the last one.
process.env.AUTH_REFRESH_RETRY_WINDOW_SECONDS = '5';

export {};
