/**
 * A simulated EXTERNAL clinic system (a "PMS"/"EMR") for end-to-end tests.
 *
 * It plays the partner's side of the integration contract using ONLY what the
 * public documentation promises — deliberately NOT importing any of the
 * platform's own signing/verification helpers, so a mistake shared by the
 * platform and its tests cannot hide:
 *
 *  • RECEIVER — a real HTTP server the platform delivers outbound webhooks to.
 *    It verifies `X-Webhook-Signature` = `sha256=HMAC(secret, "{ts}.{rawBody}")`
 *    with a constant-time compare, rejects a stale timestamp, and dedupes on
 *    `X-Webhook-Id` (delivery is at-least-once). Its reply is scriptable
 *    (500-then-200, 400, a 302 redirect, a slow reply) so retry / permanent-failure
 *    handling can be driven from the test.
 *
 *  • SIGNER — builds correctly signed inbound deliveries (v1 and v2) exactly the
 *    way a partner integrating from the docs would.
 *
 * Listens on 127.0.0.1 on an ephemeral port. The platform's SSRF guard blocks
 * loopback by design, so a spec that delivers to this receiver mocks that guard
 * for ITS OWN FILE only (see integration-outbound-simulation.e2e-spec.ts) and
 * proves the real guard separately.
 */
import * as http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// ── Signer (partner → platform) ─────────────────────────────────────────────

export const nowSeconds = (): string => String(Math.floor(Date.now() / 1000));

/** v1 (legacy): HMAC over "{ts}.{rawBody}". */
export function signInboundV1(
  secret: string,
  ts: string,
  rawBody: string,
): string {
  return `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
}

/** v2: HMAC over "{ts}\n{eventId}\n{eventType}\n{rawBody}" — event id and type are signed. */
export function signInboundV2(
  secret: string,
  ts: string,
  eventId: string,
  eventType: string,
  rawBody: string,
): string {
  return `sha256=${createHmac('sha256', secret)
    .update([ts, eventId, eventType, rawBody].join('\n'))
    .digest('hex')}`;
}

/** The four headers a v2 delivery carries, correctly signed. */
export function v2Headers(
  secret: string,
  eventId: string,
  rawBody: string,
  eventType = 'customer.upserted',
  ts: string = nowSeconds(),
): Record<string, string> {
  return {
    'X-Ziyarati-Timestamp': ts,
    'X-Ziyarati-Event-Id': eventId,
    'X-Ziyarati-Event': eventType,
    'X-Ziyarati-Signature': signInboundV2(
      secret,
      ts,
      eventId,
      eventType,
      rawBody,
    ),
  };
}

// ── Receiver (platform → partner) ───────────────────────────────────────────

export type ReceiverVerdict =
  | 'valid'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'missing_headers';

export interface ReceivedHook {
  path: string;
  id: string | undefined;
  event: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  /** v2 signature (also covers the delivery id and event type). */
  signatureV2?: string;
  /** Stable event identity: equal on retries AND on manual replays. */
  originalId?: string;
  rawBody: string;
  /** What the partner's own verification concluded. */
  verdict: ReceiverVerdict;
  /** True when this X-Webhook-Id had already been processed (the partner ignores it). */
  duplicate: boolean;
  /** HTTP status the simulator answered with. */
  respondedWith: number;
}

export interface ScriptedReply {
  status: number;
  headers?: Record<string, string>;
  /** Delay before replying, ms (to model a slow partner). */
  delayMs?: number;
  body?: string;
}

/** Replay tolerance a careful receiver applies to the signed timestamp. */
const RECEIVER_TOLERANCE_SECONDS = 300;

export class PartnerReceiver {
  private server?: http.Server;
  private secrets = new Map<string, string>();
  private scripts = new Map<string, ScriptedReply[]>();
  private fallback = new Map<string, ScriptedReply>();

  /** Every request the receiver saw, in order. */
  readonly received: ReceivedHook[] = [];
  /** X-Webhook-Ids the partner has already PROCESSED (its own dedupe store). */
  readonly processedIds = new Set<string>();
  baseUrl = '';

  /** Register the signing secret the partner holds for a path (each endpoint has its own). */
  setSecret(path: string, secret: string): void {
    this.secrets.set(path, secret);
  }

  /**
   * Script the replies for a path: each incoming request consumes the next entry;
   * once exhausted the last entry repeats. Default is `200`.
   */
  reply(path: string, ...replies: ScriptedReply[]): void {
    this.scripts.set(path, [...replies]);
    if (replies.length) this.fallback.set(path, replies[replies.length - 1]);
  }

  hooksFor(path: string): ReceivedHook[] {
    return this.received.filter((r) => r.path === path);
  }

  /** Deliveries the partner actually ACTED on: verified, not a repeat, and acknowledged with a 2xx. */
  processedFor(path: string): ReceivedHook[] {
    return this.hooksFor(path).filter(
      (r) =>
        r.verdict === 'valid' &&
        !r.duplicate &&
        r.respondedWith >= 200 &&
        r.respondedWith < 300,
    );
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () =>
        this.handle(req, res, Buffer.concat(chunks).toString('utf8')),
      );
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // keep-alive sockets would otherwise hold close() open
      (
        server as http.Server & { closeAllConnections?: () => void }
      ).closeAllConnections?.();
    });
  }

  private verify(
    path: string,
    ts?: string,
    sig?: string,
    rawBody = '',
  ): ReceiverVerdict {
    if (!ts || !sig) return 'missing_headers';
    const secret = this.secrets.get(path);
    if (!secret) return 'bad_signature';
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
    if (!Number.isFinite(age) || age > RECEIVER_TOLERANCE_SECONDS)
      return 'stale_timestamp';
    const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b)
      ? 'valid'
      : 'bad_signature';
  }

  private handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawBody: string,
  ): void {
    const path = req.url ?? '/';
    const h = (n: string) => req.headers[n.toLowerCase()] as string | undefined;
    const id = h('x-webhook-id');
    const verdict = this.verify(
      path,
      h('x-webhook-timestamp'),
      h('x-webhook-signature'),
      rawBody,
    );

    const queue = this.scripts.get(path);
    const scripted =
      (queue && queue.length ? queue.shift() : undefined) ??
      this.fallback.get(path);
    const reply: ScriptedReply = scripted ?? { status: 200 };

    // A careful partner only acts on a VERIFIED, not-yet-seen delivery.
    let duplicate = false;
    if (verdict === 'valid' && id) {
      duplicate = this.processedIds.has(id);
      if (!duplicate && reply.status >= 200 && reply.status < 300)
        this.processedIds.add(id);
    }

    this.received.push({
      path,
      id,
      event: h('x-webhook-event'),
      timestamp: h('x-webhook-timestamp'),
      signature: h('x-webhook-signature'),
      signatureV2: h('x-webhook-signature-v2'),
      originalId: h('x-webhook-original-id'),
      rawBody,
      verdict,
      duplicate,
      respondedWith: reply.status,
    });

    const send = () => {
      res.writeHead(reply.status, {
        'Content-Type': 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(reply.body ?? JSON.stringify({ ok: reply.status < 400 }));
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  }
}
