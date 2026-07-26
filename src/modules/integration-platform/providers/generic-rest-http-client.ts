import * as http from 'node:http';
import * as https from 'node:https';

import { AppError } from '../../../common/errors';
import {
  resolveSafeIntegrationTarget,
  SsrfBlockedError,
  type PinnedIntegrationTarget,
} from './integration-url-guard';

export interface GenericRestRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Fully assembled absolute URL (base + resource path + query string). */
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface GenericRestResponse {
  /** True only for a 2xx response. */
  ok: boolean;
  status?: number;
  bodyText?: string;
  /** Whether a retry might succeed (network/5xx) vs a permanent failure (blocked/4xx/malformed). */
  transient: boolean;
  error?: string;
}

/**
 * Executes ONE outbound Generic REST request using a DNS-pinned,
 * redirect-disabled raw HTTP(S) request — the same socket-level-safe pattern
 * as `modules/platform/webhook-http-client.ts`, adapted for GET/POST/PUT/PATCH
 * against a tenant-configured Generic REST connection (health check,
 * test-connection, and pull/push sync all funnel through here).
 *
 * Re-validates AND re-resolves the target on EVERY call (never only once at
 * connection save time), pins the connection to the resolved literal address
 * (closing the DNS-rebinding TOCTOU window), and NEVER follows a 3xx redirect
 * — an unfollowed redirect is reported as a failure, not silently chased to a
 * potentially unsafe host.
 */
export async function performGenericRestRequest(opts: GenericRestRequestOptions): Promise<GenericRestResponse> {
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    return { ok: false, transient: false, error: 'Constructed request URL is invalid' };
  }

  let pinned: PinnedIntegrationTarget;
  try {
    pinned = await resolveSafeIntegrationTarget(url);
  } catch (err) {
    if (err instanceof SsrfBlockedError || err instanceof AppError) {
      // Never confirm which range/host was blocked — that would be a probing oracle.
      return { ok: false, transient: false, error: 'Blocked: target address is not allowed' };
    }
    return { ok: false, transient: true, error: (err as Error)?.message ?? 'DNS resolution failed' };
  }

  return requestOnce(url, pinned, opts);
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
          transient: !ok && status >= 500,
          error: ok ? undefined : `HTTP ${status}`,
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
