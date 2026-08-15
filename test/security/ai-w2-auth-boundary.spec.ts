/**
 * T037 — authentication-boundary reproduction tests (FR-025, FR-029, FR-104).
 *
 * Forged / expired / malformed / absent tokens against (a) the REST AI
 * orchestrator route and (b) the `/ai` WebSocket handshake (`WsAuthService`
 * directly — the same real authentication code path
 * `AiRealtimeGateway.handleConnection` calls, per the established pattern in
 * `test/ai-guest-isolation.e2e-spec.ts`'s `mintGuest()`: a synthetic
 * handshake object carrying real headers, never a hand-built principal), plus
 * a valid guest token presented where a fully-authenticated principal is
 * required.
 *
 * Every case asserts an HTTP status or a thrown error/rejection reason —
 * never response wording (FR-086). Findings referencing this file are
 * back-annotated with `AI-###` at T163 — see `w2-http-auth.md` (T029) and
 * `w2-ws-auth.md` (T030) for the source trace this reproduces.
 */
import request from 'supertest';
import type { Socket } from 'socket.io';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { WsAuthService } from '../../src/modules/ai-realtime/ws-auth.service';

function fakeHandshake(cookieHeader?: string, bearer?: string) {
  return {
    handshake: {
      auth: {},
      headers: {
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      query: {},
    },
  } as unknown as Socket;
}

describe('AI auth boundary — REST orchestrator + /ai WebSocket handshake (T037)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let wsAuth: WsAuthService;
  let accessSecret: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    wsAuth = harness.app.get(WsAuthService);
    accessSecret = harness.config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  const ORCHESTRATOR_ROUTE = '/api/v1/ai/orchestrator/message';

  describe('AI-w2-auth — REST: POST /ai/orchestrator/message', () => {
    it('rejects an absent token — 401', async () => {
      const res = await request(harness.app.getHttpServer())
        .post(ORCHESTRATOR_ROUTE)
        .send({ channel: 'DASHBOARD', content: 'hi' });
      expect(res.status).toBe(401);
    });

    it('rejects a malformed/garbage token — 401', async () => {
      const res = await request(harness.app.getHttpServer())
        .post(ORCHESTRATOR_ROUTE)
        .set('Authorization', 'Bearer not-a-real-jwt.at.all')
        .send({ channel: 'DASHBOARD', content: 'hi' });
      expect(res.status).toBe(401);
    });

    it('rejects a token signed with the WRONG secret (forged) — 401', async () => {
      const forged = await harness.jwt.signAsync(
        { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
        { secret: 'definitely-not-the-real-jwt-access-secret', expiresIn: '15m' },
      );
      const res = await request(harness.app.getHttpServer())
        .post(ORCHESTRATOR_ROUTE)
        .set('Authorization', `Bearer ${forged}`)
        .send({ channel: 'DASHBOARD', content: 'hi' });
      expect(res.status).toBe(401);
    });

    it('rejects an EXPIRED token, correctly signed — 401', async () => {
      const expired = await harness.jwt.signAsync(
        { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
        { secret: accessSecret, expiresIn: '-10s' },
      );
      const res = await request(harness.app.getHttpServer())
        .post(ORCHESTRATOR_ROUTE)
        .set('Authorization', `Bearer ${expired}`)
        .send({ channel: 'DASHBOARD', content: 'hi' });
      expect(res.status).toBe(401);
    });

    it('rejects a well-formed but WRONG-TYPE token (refresh token used as access) — 401', async () => {
      const refreshShaped = await harness.jwt.signAsync(
        { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'refresh', jti: 'x' },
        { secret: accessSecret, expiresIn: '15m' },
      );
      const res = await request(harness.app.getHttpServer())
        .post(ORCHESTRATOR_ROUTE)
        .set('Authorization', `Bearer ${refreshShaped}`)
        .send({ channel: 'DASHBOARD', content: 'hi' });
      expect(res.status).toBe(401);
    });

    it('a REAL, currently-valid guest token is REJECTED on this authenticated-only route — 401, not treated as an authenticated principal', async () => {
      // Mint a real guest session exactly as a browser would.
      const mintRes = await request(harness.app.getHttpServer())
        .post('/api/v1/public/guest/session')
        .send({})
        .expect(200);
      const cookies = mintRes.headers['set-cookie'] as unknown as string[];
      const guestCookie = cookies.find((c) => c.startsWith('guest_token='));
      expect(guestCookie).toBeDefined();
      const guestTokenValue = guestCookie!.split(';')[0].split('=')[1];

      const res = await request(harness.app.getHttpServer())
        .post(ORCHESTRATOR_ROUTE)
        .set('Authorization', `Bearer ${guestTokenValue}`)
        .send({ channel: 'DASHBOARD', content: 'hi' });
      // Guest tokens carry no `type: 'access'` claim (verified: w2-guest-identity.md
      // §3 — claims are exactly { sub, tenantId, guest: true }), so JwtStrategy's
      // `payload.type !== 'access'` check refuses it before any permission check runs.
      expect(res.status).toBe(401);
    });
  });

  describe('AI-w2-auth — WebSocket: /ai namespace handshake (WsAuthService.authenticate, real code path)', () => {
    it('rejects a handshake with no token at all', async () => {
      await expect(wsAuth.authenticate(fakeHandshake())).rejects.toBeDefined();
    });

    it('rejects a malformed/garbage bearer token', async () => {
      await expect(wsAuth.authenticate(fakeHandshake(undefined, 'garbage.not.jwt'))).rejects.toBeDefined();
    });

    it('rejects a token signed with the wrong secret (forged)', async () => {
      const forged = await harness.jwt.signAsync(
        { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
        { secret: 'wrong-secret-entirely', expiresIn: '15m' },
      );
      await expect(wsAuth.authenticate(fakeHandshake(undefined, forged))).rejects.toBeDefined();
    });

    it('rejects an expired token', async () => {
      const expired = await harness.jwt.signAsync(
        { sub: seed.tenantA.staffUserId, tenantId: seed.tenantA.id, type: 'access' },
        { secret: accessSecret, expiresIn: '-10s' },
      );
      await expect(wsAuth.authenticate(fakeHandshake(undefined, expired))).rejects.toBeDefined();
    });

    it('rejects a token with no tenantId claim (not tenant-scoped)', async () => {
      const noTenant = await harness.jwt.signAsync(
        { sub: seed.tenantA.staffUserId, type: 'access' },
        { secret: accessSecret, expiresIn: '15m' },
      );
      await expect(wsAuth.authenticate(fakeHandshake(undefined, noTenant))).rejects.toBeDefined();
    });

    it('ACCEPTS a real, currently-valid guest token on the WS path (asymmetric with REST by design — WsAuthService has an explicit guest branch REST\'s JwtStrategy does not)', async () => {
      const mintRes = await request(harness.app.getHttpServer())
        .post('/api/v1/public/guest/session')
        .send({})
        .expect(200);
      const cookies = mintRes.headers['set-cookie'] as unknown as string[];
      const guestCookie = cookies.find((c) => c.startsWith('guest_token='))!;

      const principal = await wsAuth.authenticate(fakeHandshake(guestCookie.split(';')[0]));
      expect(principal.guest).toBe(true);
      expect(principal.permissions).toEqual([]);
    });
  });
});
