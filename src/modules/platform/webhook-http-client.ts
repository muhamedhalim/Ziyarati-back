import * as http from 'node:http';
import * as https from 'node:https';

import { AppError } from '../../common/errors';
import { resolveSafeWebhookTarget, SsrfBlockedError, type PinnedWebhookTarget } from './webhook-url-guard';
import { classifyWebhookHttpOutcome } from './webhook-retry-policy';
import { WEBHOOK_RESPONSE_READ_CAP_BYTES } from './webhook.constants';

export interface WebhookDeliveryAttemptResult {
  ok: boolean;
  transient: boolean;
  httpStatus?: number;
  bodyPreview?: string;
  error?: string;
}

/**
 * Delivers one signed webhook POST using a DNS-pinned, redirect-disabled raw
 * HTTP(S) request — deliberately NOT the codebase's usual native-fetch
 * convention (see MetaWhatsappProvider.dispatch()). This is the one delivery
 * path that needs socket-level control fetch/undici doesn't expose without
 * deeper coupling: connecting to a pre-validated, pinned IP address (closing
 * the DNS-rebinding TOCTOU window — see webhook-url-guard.ts's
 * `resolveSafeWebhookTarget`) while still sending the correct `Host` header /
 * TLS SNI for the tenant's original hostname, and never automatically
 * following a receiver-supplied redirect (an unfollowed 3xx is classified as
 * a permanent failure by webhook-retry-policy.ts, not retried).
 *
 * Re-validates AND re-resolves the target on EVERY call — the initial send,
 * every automatic retry, and manual replay all funnel through here, never
 * only through a one-time check at endpoint create/update time.
 */
export async function deliverWebhookRequest(
  targetUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebhookDeliveryAttemptResult> {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { ok: false, transient: false, error: 'Webhook URL is not a valid URL' };
  }

  let pinned: PinnedWebhookTarget;
  try {
    pinned = await resolveSafeWebhookTarget(url);
  } catch (err) {
    if (err instanceof SsrfBlockedError || err instanceof AppError) {
      // Never confirm *which* address/range was blocked to the caller — that
      // would be a probing oracle. Permanent: retrying changes nothing.
      return { ok: false, transient: false, error: 'Delivery blocked: target address is not allowed' };
    }
    // DNS resolution failure (NXDOMAIN, resolver timeout, ...) — the resolver
    // or network may simply be temporarily unavailable. Transient.
    return { ok: false, transient: true, error: (err as Error)?.message ?? 'DNS resolution failed' };
  }

  return requestOnce(url, pinned, body, headers, timeoutMs);
}

function requestOnce(
  url: URL,
  pinned: PinnedWebhookTarget,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebhookDeliveryAttemptResult> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

    const requestOptions: https.RequestOptions = {
      // Connect to the pinned, pre-validated literal address — NOT `url.hostname`.
      // Node performs no DNS lookup of its own for a literal IP `hostname`, so
      // this is the pin: there is no second resolution to be rebound against.
      hostname: pinned.address,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        Host: url.host,
        ...headers,
      },
      timeout: timeoutMs,
      // Redirects are never followed by http.request/https.request — a 3xx
      // response is classified as a permanent failure (see webhook-retry-policy.ts).
    };
    if (isHttps) requestOptions.servername = url.hostname; // correct TLS SNI + certificate hostname check against the ORIGINAL host, not the pinned IP.

    let settled = false;
    const finish = (result: WebhookDeliveryAttemptResult) => {
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
        if (bytesRead > WEBHOOK_RESPONSE_READ_CAP_BYTES) {
          // Enough for a truncated preview — stop reading the rest of a
          // large/slow body from a malicious or misbehaving receiver.
          const status = res.statusCode ?? 0;
          const bodyPreview = Buffer.concat(chunks).toString('utf8').slice(0, 500);
          const outcome = classifyWebhookHttpOutcome(status);
          finish(
            outcome === 'success'
              ? { ok: true, transient: false, httpStatus: status, bodyPreview }
              : { ok: false, transient: outcome === 'retryable', httpStatus: status, bodyPreview, error: `HTTP ${status}` },
          );
          res.destroy();
          req.destroy();
        }
      });
      res.on('end', () => {
        if (settled) return;
        const status = res.statusCode ?? 0;
        const bodyPreview = Buffer.concat(chunks).toString('utf8').slice(0, 500);
        const outcome = classifyWebhookHttpOutcome(status);
        finish(
          outcome === 'success'
            ? { ok: true, transient: false, httpStatus: status, bodyPreview }
            : { ok: false, transient: outcome === 'retryable', httpStatus: status, bodyPreview, error: `HTTP ${status}` },
        );
      });
      res.on('error', (err) => {
        finish({ ok: false, transient: true, error: err.message || 'Response stream error' });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Delivery timed out'));
    });
    req.on('error', (err) => {
      finish({ ok: false, transient: true, error: err?.message || 'network error' });
    });

    req.write(body);
    req.end();
  });
}
