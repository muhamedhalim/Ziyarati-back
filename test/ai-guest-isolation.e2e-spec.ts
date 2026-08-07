/**
 * F-1 / F-2 / N-1 / N-2 — real-Postgres proof that one anonymous visitor cannot
 * reach another's AI conversation.
 *
 * WHY THIS SUITE EXISTS: every guest is authenticated into the SAME synthetic
 * discovery tenant (`GuestSessionService.DISCOVERY_TENANT_SLUG`), so the
 * `tenant: { id: tenantId }` predicate that isolates two clinics from each
 * other groups all guests into one bucket. Before this fix, `guestSubject` —
 * the FND-001 ownership binding — was compared ONLY inside
 * `GuestSessionService.convert()`. Every other path (resume a turn, join a
 * socket room, type, mark seen, escalate to a human) was tenant-only, i.e.
 * open to any guest holding another guest's conversation id.
 *
 * Deliberately drives the REAL enforcement seams — `AiConversationAccessService`
 * (F-1), the REAL `AiRealtimeGateway` handler methods (F-2/N-2), and the REAL
 * `ConversationSessionService` whitelist (N-1) — against the real database,
 * with real signed guest tokens minted by the real `POST /public/guest/session`
 * route and verified by the real `WsAuthService`. Socket.IO's own transport is
 * not under test; the authorization decisions in our handlers are.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { AiConversationAccessService } from '../src/modules/ai/ai-conversation-access.service';
import { AiConversationService } from '../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../src/modules/ai-orchestrator/conversation-session.service';
import { AiRealtimeGateway } from '../src/modules/ai-realtime/ai-realtime.gateway';
import { WsAuthService } from '../src/modules/ai-realtime/ws-auth.service';
import { GuestSessionService } from '../src/modules/guest-chat/guest-session.service';
import { room } from '../src/modules/ai-realtime/ai-events.constants';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantApprovalStatus } from '../src/entities/enums';
import type { AuthenticatedUser } from '../src/modules/auth/interfaces/authenticated-user.interface';

const SUITE = `iso-${randomUUID().slice(0, 8)}`;

/** Minimal Socket.IO double: only what the gateway handlers actually touch. */
interface FakeSocket {
  data: Record<string, unknown>;
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  to: jest.Mock;
  emit: jest.Mock;
  /** Events this socket relayed into another room, per `to(room).emit(...)`. */
  relayed: { room: string; event: string; payload: unknown }[];
}

function fakeSocket(principal: AuthenticatedUser): FakeSocket {
  const relayed: FakeSocket['relayed'] = [];
  const rooms = new Set<string>();
  const socket: FakeSocket = {
    data: { userId: principal.id, tenantId: principal.tenantId, user: principal },
    rooms,
    join: jest.fn((r: string) => rooms.add(r)),
    leave: jest.fn((r: string) => rooms.delete(r)),
    to: jest.fn((r: string) => ({
      emit: (event: string, payload: unknown) => relayed.push({ room: r, event, payload }),
    })),
    emit: jest.fn(),
    relayed,
  };
  return socket;
}

const asSocket = (s: FakeSocket) => s as unknown as Socket;

describe('AI guest conversation isolation — real Postgres (F-1 / F-2 / N-1 / N-2)', () => {
  let e2e: E2eApp;
  let access: AiConversationAccessService;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let gateway: AiRealtimeGateway;
  let wsAuth: WsAuthService;

  let discoveryTenantId: string;
  let guestA: AuthenticatedUser;
  let guestB: AuthenticatedUser;
  /** Guest A's conversation — the thing guest B must never reach. */
  let convA: string;

  let clinicTenantId: string;
  let clinicConv: string;

  /** Mints a real guest session and returns the principal WsAuthService derives. */
  async function mintGuest(): Promise<AuthenticatedUser> {
    const res = await request(e2e.app.getHttpServer())
      .post('/api/v1/public/guest/session')
      .send({})
      .expect(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const guestCookie = cookies.find((c) => c.startsWith('guest_token='));
    if (!guestCookie) throw new Error('guest_token cookie was not issued');

    // Verify it exactly as the gateway would, so the principal under test is
    // the real one — not a hand-built object that could drift from production.
    return wsAuth.authenticate({
      handshake: { auth: {}, headers: { cookie: guestCookie.split(';')[0] }, query: {} },
    } as unknown as Socket);
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    access = e2e.app.get(AiConversationAccessService);
    conversations = e2e.app.get(AiConversationService);
    sessions = e2e.app.get(ConversationSessionService);
    gateway = e2e.app.get(AiRealtimeGateway);
    wsAuth = e2e.app.get(WsAuthService);

    discoveryTenantId = await e2e.app.get(GuestSessionService).ensureDiscoveryTenant();

    guestA = await mintGuest();
    guestB = await mintGuest();

    // Both guests really do land in the same tenant — the premise of F-1.
    expect(guestA.tenantId).toBe(discoveryTenantId);
    expect(guestB.tenantId).toBe(discoveryTenantId);
    expect(guestA.id).not.toBe(guestB.id);

    // Guest A's conversation, bound exactly as AiOrchestratorService.prepare does.
    const created = await conversations.start(discoveryTenantId, {});
    convA = created.id;
    await sessions.patch(discoveryTenantId, convA, { guestSubject: guestA.id });

    // A separate clinic tenant + conversation, for the cross-tenant assertions.
    const tenants = e2e.dataSource.getRepository(Tenant);
    const clinic = await tenants.save(
      tenants.create({
        name: `E2E Clinic ${SUITE}`,
        slug: `e2e-clinic-${SUITE}`,
        contact_email: `clinic-${SUITE}@example.test`,
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      }),
    );
    clinicTenantId = clinic.id;
    clinicConv = (await conversations.start(clinicTenantId, {})).id;
  }, 90_000);

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) => e2e.dataSource.query(sql, p);
    await q(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [[convA, clinicConv]]).catch(
      () => undefined,
    );
    await q(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [[convA, clinicConv]]);
    await cleanupTenant(e2e, clinicTenantId);
    await e2e.app.close();
  }, 60_000);

  // ── F-1: resuming / reading someone else's conversation ──────────────────

  describe('[F-1] conversation ownership', () => {
    it('lets the owning guest reach their own conversation', async () => {
      await expect(access.assertAccess(discoveryTenantId, convA, guestA)).resolves.toMatchObject({
        id: convA,
      });
    });

    it('refuses guest B, who is in the SAME discovery tenant — the exact defect', async () => {
      await expect(
        access.assertAccess(discoveryTenantId, convA, guestB),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses a guest a conversation belonging to a real clinic tenant', async () => {
      await expect(
        access.assertAccess(discoveryTenantId, clinicConv, guestA),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('fails closed on a conversation with no binding at all', async () => {
      const orphan = (await conversations.start(discoveryTenantId, {})).id;
      try {
        await expect(
          access.assertAccess(discoveryTenantId, orphan, guestA),
        ).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        await e2e.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [orphan]);
      }
    });

    it('is not an existence oracle — unknown id and not-yours are indistinguishable', async () => {
      const unknown = await access
        .assertAccess(discoveryTenantId, randomUUID(), guestB)
        .catch((e) => e);
      const notMine = await access.assertAccess(discoveryTenantId, convA, guestB).catch((e) => e);

      expect(notMine.message).toBe(unknown.message);
      expect(notMine.statusCode).toBe(unknown.statusCode);
    });
  });

  // ── F-2 / N-2: socket room authorization ─────────────────────────────────

  describe('[F-2] websocket room authorization', () => {
    it('lets the owning guest join their own conversation room', async () => {
      const socket = fakeSocket(guestA);
      await expect(gateway.onJoin(asSocket(socket), { aiConversationId: convA })).resolves.toEqual({
        joined: convA,
      });
      expect(socket.rooms.has(room.conversation(convA))).toBe(true);
    });

    it("refuses guest B the room — this is what leaked the human agent's replies", async () => {
      const socket = fakeSocket(guestB);
      await expect(gateway.onJoin(asSocket(socket), { aiConversationId: convA })).resolves.toEqual({
        joined: null,
      });
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.rooms.size).toBe(0);
    });

    it('refuses a guest a CROSS-TENANT conversation room', async () => {
      const socket = fakeSocket(guestA);
      await expect(
        gateway.onJoin(asSocket(socket), { aiConversationId: clinicConv }),
      ).resolves.toEqual({ joined: null });
      expect(socket.rooms.size).toBe(0);
    });

    it('[N-2] refuses typing relay into a room the socket does not own', async () => {
      const socket = fakeSocket(guestB);
      await gateway.onTyping(asSocket(socket), { aiConversationId: convA, typing: true });
      expect(socket.relayed).toHaveLength(0);
    });

    it('[N-2] refuses typing relay even for the OWNER when it never joined the room', async () => {
      const socket = fakeSocket(guestA); // owner, but rooms is empty
      await gateway.onTyping(asSocket(socket), { aiConversationId: convA, typing: true });
      expect(socket.relayed).toHaveLength(0);
    });

    it('relays typing for an owner that has joined', async () => {
      const socket = fakeSocket(guestA);
      await gateway.onJoin(asSocket(socket), { aiConversationId: convA });
      await gateway.onTyping(asSocket(socket), { aiConversationId: convA, typing: true });

      expect(socket.relayed).toEqual([
        { room: room.conversation(convA), event: 'ai:typing', payload: { userId: guestA.id, typing: true } },
      ]);
    });

    it('[N-2] refuses seen relay into a room the socket does not own', async () => {
      const socket = fakeSocket(guestB);
      await gateway.onSeen(asSocket(socket), { aiConversationId: convA, messageId: 'm1' });
      expect(socket.relayed).toHaveLength(0);
    });

    it('refuses guest B escalating guest A\'s conversation to a human', async () => {
      const socket = fakeSocket(guestB);
      await expect(
        gateway.onHandover(asSocket(socket), { aiConversationId: convA, reason: 'takeover' }),
      ).resolves.toEqual({ ok: false });
      expect(socket.emit).toHaveBeenCalledWith(
        'ai:error',
        expect.objectContaining({ message: 'AI conversation not found' }),
      );
    });
  });

  // ── N-1: the session patch whitelist ─────────────────────────────────────

  describe('[N-1] session patch whitelist', () => {
    it('cannot overwrite guestSubject — the binding the checks above depend on', async () => {
      await sessions.patchFromClient(discoveryTenantId, convA, {
        guestSubject: guestB.id,
      } as never);

      const session = await sessions.get(discoveryTenantId, convA);
      expect(session.guestSubject).toBe(guestA.id);

      // …and the takeover it was aiming for still fails.
      await expect(
        access.assertAccess(discoveryTenantId, convA, guestB),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('cannot write selected* — the public booking tenant is derived from selectedBranchId', async () => {
      await sessions.patchFromClient(discoveryTenantId, convA, {
        selectedClinicId: clinicTenantId,
        selectedBranchId: randomUUID(),
      } as never);

      const session = await sessions.get(discoveryTenantId, convA);
      expect(session.selectedClinicId).toBeUndefined();
      expect(session.selectedBranchId).toBeUndefined();
    });

    it('cannot write context.customerId — the server-bound booking subject', async () => {
      await sessions.patch(discoveryTenantId, convA, {
        context: { customerId: 'server-bound-customer' },
      });
      await sessions.patchFromClient(discoveryTenantId, convA, {
        context: { customerId: 'attacker-supplied' },
      });

      const session = await sessions.get(discoveryTenantId, convA);
      expect(session.context?.customerId).toBe('server-bound-customer');
    });

    it('still applies client-owned keys', async () => {
      await sessions.patchFromClient(discoveryTenantId, convA, {
        language: 'ar',
        currentIntent: 'book_appointment',
      });

      const session = await sessions.get(discoveryTenantId, convA);
      expect(session).toMatchObject({ language: 'ar', currentIntent: 'book_appointment' });
    });
  });
});
