import type { IncomingHttpHeaders } from 'node:http';

/**
 * Server-side admission policy for the Socket.IO / WebSocket handshake — the
 * CSWSH (cross-site WebSocket hijacking) defence.
 *
 * WHY THIS EXISTS. A WebSocket is not subject to CORS: the browser will open a
 * cross-origin socket and attach every cookie its SameSite rules allow, and only
 * the SERVER can refuse it. The gateway's `cors` option does not do that — the
 * `cors` package used by engine.io only decides which response headers to send,
 * so it protects the long-polling transport (the browser refuses to read a
 * response without `Access-Control-Allow-Origin`) and is invisible to the
 * WebSocket upgrade. The gateway authenticates with the visitor's own
 * `access_token` / `guest_token` cookies, so without this check the only thing
 * standing between another site and a credentialed socket was cookie
 * configuration (`SameSite=Lax`, host-only scoping) — which is incidental, and
 * disappears under `SameSite=None` or a shared `COOKIE_DOMAIN`.
 *
 * PRIMARY DEFENCE — the `Origin` header. Browsers always send it on a WebSocket
 * handshake and a page cannot forge or omit it, so an exact match against the
 * SAME allow-list REST CORS uses (`parseAllowedOrigins(FRONTEND_ORIGIN)`) is the
 * decision:
 *
 *  - present and in the list                 → admitted
 *  - present and `null`                      → refused (sandboxed iframe, `data:`
 *                                              and `file:` documents — never a
 *                                              legitimate first-party client)
 *  - present and anywhere else               → refused
 *  - absent, request carries a `Cookie`      → refused. A browser sends `Origin`
 *                                              on every WebSocket handshake, so a
 *                                              cookie-bearing request with none is
 *                                              not one — and cookies are exactly
 *                                              the ambient credential CSWSH abuses.
 *  - absent, no `Cookie`                     → admitted. Native, server-side and
 *                                              test clients authenticate with an
 *                                              EXPLICIT `handshake.auth.token`,
 *                                              which a hostile page has no way to
 *                                              obtain — there is nothing ambient
 *                                              to hijack. (`handshake.auth` only
 *                                              arrives in the namespace CONNECT
 *                                              packet, after this point, so it
 *                                              cannot be inspected here; the
 *                                              absence of a cookie is what makes
 *                                              admission safe.)
 *
 * A same-origin browser long-polling GET carries cookies but no `Origin` (the
 * browser omits it on same-origin GETs), so it is refused as well. Nothing in
 * this deployment dials the socket same-origin — the Next.js rewrite cannot
 * proxy an upgrade, and the clients dial `NEXT_PUBLIC_WS_URL` — and a client
 * that ever did would still get through on the WebSocket transport, which
 * always sends `Origin`.
 *
 * DEFENCE IN DEPTH — Fetch Metadata. `Sec-Fetch-Site` is set by the browser and
 * cannot be overridden by page script. `cross-site` is refused when present. A
 * MISSING header is never treated as hostile (older browsers and every
 * non-browser client omit it), and `same-site` — a sibling subdomain — is left
 * to the `Origin` allow-list, because a sibling such as `book.` legitimately
 * dials `api.` while `evil.` is refused there. This is a second lock, never a
 * substitute for the first.
 *
 * Deliberately NOT in the policy: SameSite, CORS response headers, or anything
 * read from the token. Those are independent layers; this one must hold when
 * they are misconfigured.
 */
export type WsRejectReason =
  | 'origin_null'
  | 'origin_not_allowed'
  | 'origin_missing_with_cookie'
  | 'fetch_metadata_cross_site';

export type WsAdmissionVerdict =
  | { allowed: true }
  | { allowed: false; reason: WsRejectReason };

/**
 * What the peer is told. Fixed strings per reason — never anything derived from
 * the request, so a refusal cannot be used to reflect attacker-controlled text
 * into a response or a log.
 */
export const WS_REJECT_MESSAGE: Record<WsRejectReason, string> = {
  origin_null: 'Origin not allowed',
  origin_not_allowed: 'Origin not allowed',
  origin_missing_with_cookie: 'Origin required',
  fetch_metadata_cross_site: 'Cross-site request not allowed',
};

/** Node joins duplicate `Origin`/`Sec-Fetch-Site` headers with ", " — never a match. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Pure and O(1): one `Set` lookup and two header reads. No I/O, so it is safe to
 * run on every handshake before any socket state exists.
 *
 * `allowedOrigins` must already be normalised (`parseAllowedOrigins`); the
 * comparison is exact string equality against the header as the browser sent it
 * — no `startsWith`, no suffix or substring match, no wildcards.
 */
export function evaluateWsHandshake(
  headers: IncomingHttpHeaders,
  allowedOrigins: ReadonlySet<string>,
): WsAdmissionVerdict {
  const origin = single(headers.origin);

  if (origin !== undefined) {
    // Checked before the allow-list so a `FRONTEND_ORIGIN=null` typo in a
    // development file can never admit an opaque origin.
    if (origin === 'null') return { allowed: false, reason: 'origin_null' };
    if (!allowedOrigins.has(origin)) {
      return { allowed: false, reason: 'origin_not_allowed' };
    }
  } else if (single(headers.cookie)) {
    return { allowed: false, reason: 'origin_missing_with_cookie' };
  }

  const site = single(headers['sec-fetch-site'])?.trim().toLowerCase();
  if (site === 'cross-site') {
    return { allowed: false, reason: 'fetch_metadata_cross_site' };
  }

  return { allowed: true };
}

/**
 * Makes an attacker-controlled header safe to put in a log line: printable
 * ASCII only, bounded. (Node already refuses control characters in header
 * values; this is the belt to that braces.)
 */
export function sanitizeForLog(value: string | undefined, max = 120): string {
  if (value === undefined) return '(absent)';
  const printable = value.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > max ? `${printable.slice(0, max)}…` : printable;
}

/**
 * Throttles refusal logging. A hostile page can open handshakes as fast as it
 * likes, and an unthrottled `warn` per refusal would turn the defence into a
 * log-flood primitive. The first refusal of each reason is logged immediately;
 * the rest within the window are counted and reported with the next line.
 */
export class WsRejectionLog {
  private readonly state = new Map<
    WsRejectReason,
    { lastLoggedAt: number; suppressed: number }
  >();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns how many refusals were suppressed since the last line, or `null` to stay quiet. */
  shouldLog(reason: WsRejectReason): { suppressed: number } | null {
    const at = this.now();
    const entry = this.state.get(reason);
    if (!entry) {
      this.state.set(reason, { lastLoggedAt: at, suppressed: 0 });
      return { suppressed: 0 };
    }
    if (at - entry.lastLoggedAt >= this.windowMs) {
      const suppressed = entry.suppressed;
      entry.lastLoggedAt = at;
      entry.suppressed = 0;
      return { suppressed };
    }
    entry.suppressed += 1;
    return null;
  }
}
