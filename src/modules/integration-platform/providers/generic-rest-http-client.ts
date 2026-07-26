import * as http from 'node:http';
import * as https from 'node:https';

import { AppError } from '../../../common/errors';
import {
  resolveSafeIntegrationTarget,
  SsrfBlockedError,
  type PinnedIntegrationTarget,
} from './integration-url-guard';

export interface GenericRestRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Fully assembled absolute URL (base + resource path + query string). */
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  /** Total attempts including the first (default 2 — one retry). Capped at 3. Only a transient failure or 429 triggers a retry. */
  maxAttempts?: number;
}

export interface GenericRestResponse {
  /** True only for a 2xx response. */
  ok: boolean;
  status?: number;
  bodyText?: string;
  /** Whether a retry might succeed (network/5xx/429) vs a permanent failure (blocked/4xx/malformed). */
  transient: boolean;
  error?: string;
  /** Server-requested delay before retrying a 429, parsed from `Retry-After` (capped). */
  retryAfterMs?: number;
  /** How many attempts were actually made. */
  attempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CEILING = 3;
/** Upper bound on ANY single retry delay — a provider's Retry-After must never stall a worker indefinitely. */
const MAX_RETRY_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential-ish backoff for a transient failure with no server-supplied delay. */
function backoffMs(attempt: number): number {
  return Math.min(300 * attempt, MAX_RETRY_DELAY_MS);
}

/** Parses `Retry-After` (seconds, or an HTTP-date) into a capped millisecond delay. Unparseable/absent → null. */
function parseRetryAfterMs(headerValue: string | undefined): number | null {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.min(asSeconds * 1000, MAX_RETRY_DELAY_MS);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return Math.min(Math.max(delta, 0), MAX_RETRY_DELAY_MS);
  }
  return null;
}

/**
 * Executes ONE outbound Generic REST request using a DNS-pinned,
 * redirect-disabled raw HTTP(S) request — the same socket-level-safe pattern
 * as `modules/platform/webhook-http-client.ts`, adapted for GET/POST/PUT/PATCH/DELETE
 * against a tenant-configured Generic REST connection (health check,
 * test-connection, and pull/push sync all funnel through here).
 *
 * Re-validates AND re-resolves the target on EVERY attempt — never only once at
 * connection save time and never reused across a retry — pins the connection to
 * the resolved literal address (closing the DNS-rebinding TOCTOU window), and
 * NEVER follows a 3xx redirect — an unfollowed redirect is reported as a
 * failure, not silently chased to a potentially unsafe host.
 *
 * Retries ONLY a transient outcome (network error, 5xx, or 429) — a blocked
 * target, a 4xx other than 429, or a malformed response is never retried. A
 * 429's `Retry-After` is honoured (capped); otherwise a short fixed backoff is
 * used. The total attempt count is bounded so a slow/misbehaving provider can
 * never stall a worker indefinitely.
 */
export async function performGenericRestRequest(opts: GenericRestRequestOptions): Promise<GenericRestResponse> {
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    return { ok: false, transient: false, error: 'Constructed request URL is invalid', attempts: 0 };
  }

  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_CEILING));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let pinned: PinnedIntegrationTarget;
    try {
      pinned = await resolveSafeIntegrationTarget(url);
    } catch (err) {
      if (err instanceof SsrfBlockedError || err instanceof AppError) {
        // Never confirm which range/host was blocked — that would be a probing oracle.
        return { ok: false, transient: false, error: 'Blocked: target address is not allowed', attempts: attempt };
      }
      if (attempt >= maxAttempts) {
        return { ok: false, transient: true, error: (err as Error)?.message ?? 'DNS resolution failed', attempts: attempt };
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    const result = await requestOnce(url, pinned, opts);
    const willRetry = attempt < maxAttempts && (result.transient || result.status === 429);
    if (!willRetry) return { ...result, attempts: attempt };

    await sleep(result.status === 429 ? (result.retryAfterMs ?? backoffMs(attempt)) : backoffMs(attempt));
  }

  // Unreachable (the loop above always returns by its last iteration), but keeps the compiler happy.
  return { ok: false, transient: true, error: 'Request failed', attempts: maxAttempts };
}

function requestOnce(
  url: URL,
  pinned: PinnedIntegrationTarget,
  opts: GenericRestRequestOptions,
): Promise<GenericRestResponse> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const bodyBuffer = opts.body !== undefined ? Buffer.from(opts.body, 'utf8') : undefined;

    const requestOptions: https.RequestOptions = {
      // Connect to the pinned, pre-validated literal address — NOT `url.hostname`.
      hostname: pinned.address,
      port,
      path: `${url.pathname}${url.search}`,
      method: opts.method,
      headers: {
        Accept: 'application/json',
        ...(bodyBuffer
          ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuffer.length }
          : {}),
        Host: url.host,
        ...opts.headers,
      },
      timeout: opts.timeoutMs,
      // http.request/https.request never follow redirects automatically — a
      // 3xx response below is surfaced as a plain non-2xx result.
    };
    if (isHttps) requestOptions.servername = url.hostname; // correct TLS SNI / cert hostname check against the ORIGINAL host.

    let settled = false;
    const finish = (result: GenericRestResponse) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let bytesRead = 0;

      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytesRead += chunk.length;
        chunks.push(chunk);
        if (bytesRead > opts.maxResponseBytes) {
          const status = res.statusCode ?? 0;
          finish({
            ok: status >= 200 && status < 300,
            status,
            bodyText: Buffer.concat(chunks).toString('utf8'),
            transient: false,
            error: 'Response exceeded the maximum allowed size',
          });
          res.destroy();
          req.destroy();
        }
      });
      res.on('end', () => {
        if (settled) return;
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        finish({
          ok,
          status,
          bodyText: Buffer.concat(chunks).toString('utf8'),
          transient: !ok && (status >= 500 || status === 429),
          error: ok ? undefined : `HTTP ${status}`,
          retryAfterMs: status === 429 ? parseRetryAfterMs(res.headers['retry-after']) ?? undefined : undefined,
        });
      });
      res.on('error', (err) => {
        finish({ ok: false, transient: true, error: err.message || 'Response stream error' });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', (err) => {
      finish({ ok: false, transient: true, error: err?.message || 'Network error' });
    });

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}
