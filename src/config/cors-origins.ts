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
