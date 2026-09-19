/**
 * T057 — realtime-room cross-tenant reproduction (FR-021, FR-029), against
 * `AiRealtimeGateway` on the `/ai` namespace.
 *
 * Mirrors `test/ai-guest-isolation.e2e-spec.ts`'s `FakeSocket` pattern exactly
 * (per this task's explicit instruction) — a minimal Socket.IO double exposing
 * only what the gateway handlers touch (`data`, `rooms`, `join`, `leave`,
 * `to`, `emit`) — never a real `socket.io-client`. Room ids
 * (`room.conversation(id)`) embed no tenant (B10, per plan.md), so this file
 * exercises TWO REAL, DISTINCT tenants (not guest-vs-guest, which is W6's
 * job) driving `AiRealtimeGateway`'s handler methods directly, against the
 * REAL `WsAuthService`-derived data shape and the REAL `AiConversationAccessService`.
 */
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import { room } from '../../src/modules/ai-realtime/ai-events.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

/** Minimal Socket.IO double: only what the gateway handlers actually touch. */
interface FakeSocket {
  data: Record<string, unknown>;
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  to: jest.Mock;
  emit: jest.Mock;
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

describe('AI-W4 realtime-room cross-tenant reproduction (T057)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let gateway: AiRealtimeGateway;

  let convA: AiConversation;
  let convB: AiConversation;
  let staffA: AuthenticatedUser;
  let staffB: AuthenticatedUser;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    gateway = harness.app.get(AiRealtimeGateway);

    convA = await conversations.start(seed.tenantA.id, {});
    convB = await conversations.start(seed.tenantB.id, {});

    // Real (non-guest) principals — this file is about TENANT isolation, not
    // guest-vs-guest (W6's job). `AiConversationAccessService.assertAccess`
    // only applies the extra guest-subject check when `principal.guest` is
    // set, so a real staff principal's refusal here is purely tenant-scoped.
    //
    // They hold `ai.handover.read` (CSWSH F-6: `ai:join` now requires an AI
    // conversation/handover permission for staff). That is load-bearing for this
    // file, not incidental: with NO permission the cross-tenant refusals below
    // would still pass — refused by the permission gate instead — and stop
    // testing tenant isolation at all. The permission-less case has its own
    // describe further down.
    staffA = {
      id: seed.tenantA.staffUserId,
      tenantId: seed.tenantA.id,
      roles: ['doctor'],
      permissions: [PERMISSION.AI_HANDOVER_READ],
    };
    staffB = {
      id: seed.tenantB.staffUserId,
      tenantId: seed.tenantB.id,
      roles: ['doctor'],
      permissions: [PERMISSION.AI_HANDOVER_READ],
    };
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [[convA.id, convB.id]]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  describe('onJoin — cross-tenant room join', () => {
    it('control: tenant-A staff may join their own tenant\'s conversation room', async () => {
      const socket = fakeSocket(staffA);
      await expect(gateway.onJoin(asSocket(socket), { aiConversationId: convA.id })).resolves.toEqual({
        joined: convA.id,
      });
      expect(socket.rooms.has(room.conversation(convA.id))).toBe(true);
    });

    it('refuses tenant-A staff joining tenant B\'s conversation room — server-side, before any join happens', async () => {
      const socket = fakeSocket(staffA);
      await expect(gateway.onJoin(asSocket(socket), { aiConversationId: convB.id })).resolves.toEqual({
        joined: null,
      });
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.rooms.size).toBe(0);
    });

    it('refuses tenant-B staff joining tenant A\'s conversation room (symmetric check)', async () => {
      const socket = fakeSocket(staffB);
      await expect(gateway.onJoin(asSocket(socket), { aiConversationId: convA.id })).resolves.toEqual({
        joined: null,
      });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('refuses an unknown conversation id identically to a real foreign one (not an existence oracle)', async () => {
      const socket = fakeSocket(staffA);
      await expect(gateway.onJoin(asSocket(socket), { aiConversationId: randomUUID() })).resolves.toEqual({
        joined: null,
      });
    });
  });

  describe('onJoin — the permission gate (CSWSH F-6), independent of tenant', () => {
    it('refuses staff with NO AI permission a conversation room in their OWN tenant — same tenant is not enough', async () => {
      const doctorNoAi: AuthenticatedUser = { ...staffA, permissions: [] };
      const socket = fakeSocket(doctorNoAi);
      await expect(
        gateway.onJoin(asSocket(socket), { aiConversationId: convA.id }),
      ).resolves.toEqual({
        joined: null,
      });
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(
        'ai:error',
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    });
  });

  describe('typing/seen relay — no event delivered into a room never joined', () => {
    it('tenant-A staff who never joined tenant B\'s room gets zero relay on typing', async () => {
      const socket = fakeSocket(staffA);
      await gateway.onTyping(asSocket(socket), { aiConversationId: convB.id, typing: true });
      expect(socket.relayed).toHaveLength(0);
    });

    it('tenant-A staff who never joined tenant B\'s room gets zero relay on seen', async () => {
      const socket = fakeSocket(staffA);
      await gateway.onSeen(asSocket(socket), { aiConversationId: convB.id, messageId: 'm1' });
      expect(socket.relayed).toHaveLength(0);
    });

    it('control: tenant-A staff who DID join their own room DOES relay typing (proves the refusal above is ownership, not a blanket no-op)', async () => {
      const socket = fakeSocket(staffA);
      await gateway.onJoin(asSocket(socket), { aiConversationId: convA.id });
      await gateway.onTyping(asSocket(socket), { aiConversationId: convA.id, typing: true });
      expect(socket.relayed).toEqual([
        { room: room.conversation(convA.id), event: 'ai:typing', payload: { userId: staffA.id, typing: true } },
      ]);
    });
  });

  describe('onHandover — cross-tenant escalation attempt', () => {
    it('refuses tenant-A staff escalating tenant B\'s conversation to a human', async () => {
      const before = await harness.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM handover_requests WHERE "tenantId" = $1`,
        [seed.tenantB.id],
      );
      const socket = fakeSocket(staffA);
      await expect(
        gateway.onHandover(asSocket(socket), { aiConversationId: convB.id, reason: 'cross-tenant probe' }),
      ).resolves.toEqual({ ok: false });
      expect(socket.emit).toHaveBeenCalledWith(
        'ai:error',
        expect.objectContaining({ message: 'AI conversation not found' }),
      );
      // Absent side effect: no handover request was created for tenant B.
      const after = await harness.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM handover_requests WHERE "tenantId" = $1`,
        [seed.tenantB.id],
      );
      expect(after[0].count).toBe(before[0].count);
    });
  });
});
