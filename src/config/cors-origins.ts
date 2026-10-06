/**
 * The single parser for `FRONTEND_ORIGIN`, shared by the two places that
 * enforce it: `main.ts`'s `app.enableCors` (REST) and
 * `ai-realtime.gateway.ts`'s `@WebSocketGateway({ cors })` (Socket.IO
 * polling). Both used to hand-roll the same `split/trim/filter`, which the
 * gateway's own comment asks to keep identical — one function is how that
 * stops being a convention.
 *
 * WHY NORMALIZATION, NOT JUST SPLITTING. The `cors` package compares the
 * browser's `Origin` **header** against these entries by exact string
 * equality, and that header is always a bare origin — scheme + host +
 * optional port, never a trailing slash and never a path. `env.validation.ts`
 * only checks each entry with `new URL()`, which happily accepts
 * `https://app.example.com/` and `https://app.example.com/dashboard`. Both
 * pass validation, the API boots, REST through a same-origin proxy keeps
 * working (it never triggers CORS) — and every genuinely cross-origin browser
 * request is refused with no `Access-Control-Allow-Origin`, silently. The
 * signature of that state, seen on a real deployment: preflights answer 204
 * with allow-methods and allow-headers but no allow-origin, for every origin
 * tried.
 *
 * `URL.origin` collapses all of those to the one form the header can actually
 * match, so a trailing slash stops being the difference between a working and
 * a dead realtime fallback.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? 'http://localhost:3000')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        // `new URL('https://a.example/').origin` → `'https://a.example'`.
        return new URL(entry).origin;
      } catch {
        // Unparseable entries are kept verbatim rather than dropped: production
        // already refuses to boot on them (env.validation.ts), and in
        // development this keeps the allow-list exactly as permissive as the
        // hand-rolled parse it replaces — normalization must never be able to
        // remove an origin that used to work.
        return entry;
      }
    });
}

/**
 * Response headers a cross-origin browser client may READ. A browser hides every
 * response header except the CORS-safelisted ones unless the server lists it in
 * `Access-Control-Expose-Headers`.
 *
 * This list was irrelevant while every REST call went through the same-origin
 * Next.js rewrite (a same-origin response exposes all its headers). It becomes
 * load-bearing once the browser calls the API host directly (residency plan P9):
 *   - `X-Request-Id`        the SPA reads it to show a support reference on an
 *                           error (`axiosInstance` → `setLastRequestId`);
 *   - `Content-Disposition` the report/CSV download path derives the filename
 *                           from it (`report-export.ts`).
 * Omitting either is silent — the call succeeds and the header is just `undefined`.
 */
export const CORS_EXPOSED_HEADERS = ['X-Request-Id', 'Content-Disposition'];

/**
 * How long a browser may cache a preflight answer, in seconds. Every mutating
 * call from the SPA carries `X-CSRF-Token` (a non-safelisted header) and so
 * triggers an `OPTIONS` round trip; direct API routing makes that a real
 * cross-origin cost where the same-origin proxy had none. Ten minutes is a
 * conservative ceiling — Chromium caps this at 2 h and Firefox at 24 h anyway.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * The one CORS configuration for REST. Credentialed (cookie auth), restricted to
 * the `FRONTEND_ORIGIN` allow-list — never a wildcard, which is invalid with
 * credentials and unsafe. Allowed REQUEST headers are deliberately left to the
 * `cors` default (reflect `Access-Control-Request-Headers`) so adding a request
 * header never needs a coordinated backend change; the origin check is what
 * gates access.
 */
export function buildCorsOptions(allowedOrigins: string[]): {
  origin: string[];
  credentials: true;
  exposedHeaders: string[];
  maxAge: number;
} {
  return {
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}
