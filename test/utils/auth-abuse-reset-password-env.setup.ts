/**
 * Same pattern as auth-abuse-forgot-password-env.setup.ts: low bounds + the
 * schema's own window floor, set BEFORE AppModule is ever imported in this
 * test file's module registry.
 *
 * Neither `AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT` nor
 * `AUTH_RESET_PASSWORD_INVALID_CEILING` is relaxed by `NODE_ENV === 'test'`
 * — same reasoning as forgot-password's own env-setup file: this endpoint's
 * dedicated e2e suite exists specifically to exercise the real threshold,
 * and no other spec in this repo calls `POST /auth/reset-password` through
 * a live `AuthService` (confirmed by grep before writing this suite; the one
 * other hit, platform-staff.service.spec.ts, only asserts against a mocked
 * URL STRING containing the substring "reset-password", never touching this
 * service or endpoint).
 *
 * `AUTH_RESET_PASSWORD_WINDOW_SECONDS` is set to the schema's own floor (60,
 * `env.validation.ts`: `.min(60)`) — cannot go lower, same constraint as
 * forgot-password's window.
 */
process.env.AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT = '5';
process.env.AUTH_RESET_PASSWORD_INVALID_CEILING = '20';
process.env.AUTH_RESET_PASSWORD_WINDOW_SECONDS = '60';
process.env.AUTH_ABUSE_DEGRADED_FACTOR = '0.5';
process.env.AUTH_ABUSE_FALLBACK_WIDTH = '4096';

export {};
