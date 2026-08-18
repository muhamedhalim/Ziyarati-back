/**
 * T146 — anonymous flooding: unbounded session minting + sustained guest
 * turns (FR-070, FR-072, FR-110).
 *
 * Two parts, mirroring the two ways an anonymous client actually touches the
 * AI surface:
 *
 *  1. `POST /public/guest/session` (E3, `@Public()`, HTTP) minted repeatedly —
 *     same transport as T145's REST flood, so the SAME global `ThrottlerGuard`
 *     bucket is the only candidate control (T144 §2/§3). Expect the same
 *     "no refusal within a bounded flood, under NODE_ENV=test relaxation"
 *     observation as T145 — this is the useful comparison point.
 *
 *  2. Sustained `ai:message` turns over a REAL `socket.io-client` connection
 *     (E2, the WS transport) using a minted guest token — this is how a
 *     guest actually drives AI turns, since a guest token is REJECTED on
 *     every REST AI route (HARNESS_GUIDE gotcha #7 /
 *     `ai-w2-auth-boundary.spec.ts`). Per T144 §4, NO guard of any kind
 *     (global or local) is wired to `AiRealtimeGateway`, so this part proves
 *     — at runtime, not just by static trace — that the WS transport has
 *     STRICTLY LESS protection than the authenticated REST transport: not
 *     "the same generous limit", but no limit-shaped control at all (no
 *     `X-RateLimit-*` equivalent exists on the wire either, since there is no
 *     HTTP response to carry headers on a socket frame).
 *
 * Real listening HTTP server (`app.listen(0)`) + real `socket.io-client`,
 * exactly the pattern already proven in `test/realtime-parser-upgrade.e2e-spec.ts`
 * (that file's own docstring: a `FakeSocket` double, as `ai-guest-isolation.e2e-spec.ts`
 * uses, deliberately does NOT exercise transport-level behavior — this task
 * needs the real transport specifically because the finding IS about the
 * transport).
 */
import request from 'supertest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { AI_EVENT } from '../../src/modules/ai-realtime/ai-events.constants';

describe('AI abuse — anonymous session minting + sustained guest turns (T146)', () => {
  let harness: AiAuditHarness;
  let baseUrl: string;

  const SESSION_ROUTE = '/api/v1/public/guest/session';
  const MINT_COUNT = 30;
  const TURN_COUNT = 30;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    await harness.app.listen(0);
    const address = harness.app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  }, 60_000);

  async function mintGuestCookie(): Promise<string> {
    const res = await request(harness.app.getHttpServer())
      .post(SESSION_ROUTE)
      .send({})
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const guestCookie = cookies.find((c) => c.startsWith('guest_token='));
    if (!guestCookie) throw new Error('guest_token cookie was not issued');
    return guestCookie.split(';')[0];
  }

  it(`mints ${MINT_COUNT} guest sessions back to back and records the first refusal, if any`, async () => {
    let firstRefusalAt: number | null = null;
    const statuses: number[] = [];
    let sawRateLimitHeader = false;

    for (let i = 0; i < MINT_COUNT; i += 1) {
      const res = await request(harness.app.getHttpServer())
        .post(SESSION_ROUTE)
        .send({});
      statuses.push(res.status);
      if (res.headers['x-ratelimit-limit'] !== undefined) sawRateLimitHeader = true;
      if (res.status === 429 && firstRefusalAt === null) firstRefusalAt = i;
    }

    process.stdout.write('\n===T146-MINT-RESULT-START===\n');
    process.stdout.write(
      JSON.stringify({ mintCount: MINT_COUNT, statusCounts: statuses.reduce<Record<string, number>>((a, s) => { a[s] = (a[s] ?? 0) + 1; return a; }, {}), firstRefusalAt, sawRateLimitHeader }, null, 2),
    );
    process.stdout.write('\n===T146-MINT-RESULT-END===\n');

    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(sawRateLimitHeader).toBe(true); // same global ThrottlerGuard bucket as T145 — proves it ran
    expect(firstRefusalAt).toBeNull(); // same NODE_ENV=test relaxation as T145 (app.module.ts:113)
  }, 60_000);

  it(`[PROMOTED, RTP row 20, AI-015/AI-028/T112-T114] sustains ${TURN_COUNT} real WS turns as ONE guest over ONE socket.io connection — a refusal now appears at the configured guest threshold, not zero refusals across all 30`, async () => {
    const guestCookie = await mintGuestCookie();
    const guestTokenValue = decodeURIComponent(guestCookie.split('=').slice(1).join('='));

    const client: ClientSocket = ioClient(`${baseUrl}/ai`, {
      auth: { token: guestTokenValue },
      transports: ['websocket'],
      forceNew: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ai:connected')), 10_000);
        client.on(AI_EVENT.CONNECTED, () => { clearTimeout(timer); resolve(); });
        client.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
      });

      let aiConversationId: string | undefined;
      let firstRefusalAt: number | null = null;
      const outcomes: Array<'done' | 'error'> = [];

      for (let i = 0; i < TURN_COUNT; i += 1) {
        const outcome = await new Promise<'done' | 'error'>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ai:done/ai:error on turn ${i}`)), 15_000);
          const onDone = (payload: { aiConversationId: string }) => {
            clearTimeout(timer);
            client.off(AI_EVENT.ERROR, onError);
            aiConversationId = payload.aiConversationId;
            resolve('done');
          };
          const onError = () => {
            clearTimeout(timer);
            client.off(AI_EVENT.DONE, onDone);
            resolve('error');
          };
          client.once(AI_EVENT.DONE, onDone);
          client.once(AI_EVENT.ERROR, onError);
          client.emit(AI_EVENT.MESSAGE, {
            content: `guest flood turn ${i}`,
            channel: 'WEBSITE',
            aiConversationId,
          });
        });
        outcomes.push(outcome);
        if (outcome === 'error' && firstRefusalAt === null) firstRefusalAt = i;
      }

      process.stdout.write('\n===T146-WS-TURN-RESULT-START===\n');
      process.stdout.write(
        JSON.stringify({ turnCount: TURN_COUNT, doneCount: outcomes.filter((o) => o === 'done').length, errorCount: outcomes.filter((o) => o === 'error').length, firstRefusalAt }, null, 2),
      );
      process.stdout.write('\n===T146-WS-TURN-RESULT-END===\n');

      // [PROMOTED, RTP row 20] a refusal now appears at the configured guest
      // threshold (AI_WS_RATE_LIMIT_GUEST_MAX_TURNS, default 15) — the
      // (previously absent) rate limit is real, keyed to this one guest
      // identity, PD-5's own mechanism-not-blocked requirement. The guest's
      // unmetered subscription-quota admission (FR-078, untouched) is a
      // SEPARATE control from this connection/time-window one — both can be
      // true at once, which is exactly the point (FR-054).
      const GUEST_MAX_TURNS = 15; // AI_WS_RATE_LIMIT_GUEST_MAX_TURNS's default
      expect(firstRefusalAt).toBe(GUEST_MAX_TURNS);
      expect(outcomes.filter((o) => o === 'done').length).toBe(GUEST_MAX_TURNS);
      expect(outcomes.filter((o) => o === 'error').length).toBe(TURN_COUNT - GUEST_MAX_TURNS);
    } finally {
      if (client.connected) client.disconnect();
    }
  }, 120_000);
});
