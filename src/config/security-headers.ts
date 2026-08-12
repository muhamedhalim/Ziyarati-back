import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/**
 * ZT-003 / ZT-H07 — the single, importable registration for every header
 * (and the one disclosure setting) Express applies to every response it
 * serves (`/api/v1/*`, inbound webhooks, the raw `/` and `/api/v1/health`
 * handlers, and error responses). Follows the `mountApiDocs` /
 * `src/config/api-docs.ts` extraction pattern this codebase already
 * established for ZT-001: called from both `main.ts`'s `bootstrap()` and
 * the e2e application factory (`test/utils/whatsapp-e2e-app.ts`), so a
 * header assertion in a test suite exercises the exact same registration
 * production uses (FR-007) rather than passing vacuously — `X-Powered-By`
 * disabling lives here rather than as a separate call in `main.ts` for the
 * same reason: it belongs to the contract's one "Emitted headers" table
 * (contracts/backend-api-headers.md), and a second, easy-to-forget call site
 * is exactly the vacuous-in-tests gap FR-007 exists to close.
 *
 * Pure Express middleware — no `helmet`, no new npm dependency (research.md
 * R5: helmet's default CSP would create a second, independently-evolving
 * content policy on JSON responses, exactly what FR-002 forbids).
 */

/**
 * HSTS `max-age`, in seconds — a **source constant**, not an environment
 * variable. This is a security policy value, not an operational tuning
 * knob; a new env var would add a Joi schema entry, a deployment value and
 * a failure mode for no benefit (research.md R6). One year, the
 * conventional value for an established HTTPS application.
 */
export const HSTS_MAX_AGE_SECONDS = 31536000; // 365 days

/**
 * The API-tier content policy: the correct policy for a response that
 * loads nothing, and a different response class from the document policy
 * `proxy.ts` owns — no conflict with FR-002 (contracts/backend-api-headers.md).
 */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * True only when the current request arrived over HTTPS. Reads the
 * forwarded-protocol REQUEST HEADER directly rather than Express's
 * `req.secure` / `trust proxy` — enabling `trust proxy` would change 009's
 * throttle key derivation (FR-058; research.md R6). `x-forwarded-proto` is
 * read raw and compared case-insensitively; it is never trusted as an
 * authentication or authorization signal, only as a hint for a
 * defence-in-depth transport header.
 */
function isHttpsRequest(req: Request): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return typeof value === 'string' && value.toLowerCase().split(',')[0].trim() === 'https';
}

/**
 * Registers the API/webhook security header middleware. Must be called
 * **early** in the middleware chain — before the raw `/` and
 * `/api/v1/health` handlers in `main.ts` — so every response is covered,
 * including 404s and the exception filter's output. Does not interfere
 * with CORS, compression, cookie parsing, the exception filter, or the
 * global guard chain; it only writes response headers.
 *
 * ---------------------------------------------------------------------
 * Intentional exception (O2, RESOLVED): the Socket.IO handshake.
 * ---------------------------------------------------------------------
 * Engine.io attaches to the underlying HTTP server and answers
 * `/socket.io/` — including the HTTP 101 upgrade — **before** Express
 * routing runs, so this `app.use()` middleware never sees that request.
 * This is an accepted, intentional exception, not an unclosed gap, and the
 * handshake pipeline must never be modified to force these headers onto
 * it, for four reasons (contracts/backend-api-headers.md O2):
 *   1. CSP governs browser documents, not the WebSocket transport itself —
 *      what actually gates the connection is the document's `connect-src`,
 *      enforced by the browser at connection time (owned by
 *      contracts/frontend-document-headers.md), not anything on the 101.
 *   2. `X-Frame-Options`/`Permissions-Policy`/`frame-ancestors` are document
 *      and browser-capability controls; an upgrade response is never framed
 *      or rendered and grants no capability, so they have no subject here.
 *   3. Intercepting engine.io to attach headers that govern nothing risks
 *      breaking transport negotiation for zero security gain.
 *   4. WebSocket security already lives in handshake auth
 *      (`ws-auth.service.ts`), tenant isolation, and payload controls —
 *      not in response headers.
 * The compensating control is the document's `connect-src`, which must
 * allow the configured WebSocket origin in both `wss:` and `https:` forms
 * (see csp-production.md) — verified by the realtime browser journey
 * (quickstart §4 journey 8, T139).
 */
export function registerSecurityHeaders(app: INestApplication): void {
  // ---------------- Framework disclosure (ZT-H07) ----------------
  // An app-level Express setting checked at response-send time, not a
  // middleware in the request chain — so, unlike the headers below, it has
  // no ordering dependency on where in bootstrap() this function is called.
  // Not relied on edge/CDN stripping (FR-006).
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    // HSTS — production AND HTTPS only (D2). Never in development or over
    // plain HTTP: a NODE_ENV-only gate would pin a developer's or CI's
    // `http://localhost` origin to HTTPS for the header's full lifetime, an
    // outage that survives reverting the code (research.md R6). No
    // `includeSubDomains`, no `preload` (D2 — both excluded from 010).
    if (process.env.NODE_ENV === 'production' && isHttpsRequest(req)) {
      res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}`);
    }

    next();
  });
}
