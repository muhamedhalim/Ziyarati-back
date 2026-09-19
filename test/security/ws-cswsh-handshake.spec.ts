/**
 * CSWSH remediation — wire-level proof.
 *
 * Nothing here is mocked at the seam that matters. A real HTTP server carries a
 * real Socket.IO server built by the REAL `RedisIoAdapter.createIOServer` (the
 * one point every Nest gateway is created through), with the REAL
 * `AiRealtimeGateway`, `WsAuthService` (real JWT verification, real cookie
 * parsing) and `AiConversationAccessService` behind it, and real
 * `socket.io-client` sockets carrying the headers a hostile page's browser
 * would. Only the persistence/AI edges are doubles.
 *
 * What it proves, per finding:
 *   F-1/F-7  a refused handshake never reaches `handleConnection`, on BOTH
 *            transports, and the allowed origin still connects.
 *   F-3      two guests in the same discovery tenant cannot see each other's
 *            conversation ids, handover reasons or lifecycle events.
 *   F-4      an expired credential and a revoked/reduced/moved user do not keep
 *            a socket's privileges.
 *   F-5      `?token=` is not an authentication mechanism.
 *   F-6      staff without an AI permission cannot join a conversation room or
 *            use presence.
 *
 * The Nest handler-binding glue (`bindMessageHandlers`) is the only part
 * re-implemented, in `bindHandlers` below; the handlers themselves are the
 * gateway's own methods. `socket.io-client` is resolved from the hoisted
 * dependency tree exactly as `test/realtime-parser-upgrade.e2e-spec.ts` does.
 *
 * No database and no Redis: runs anywhere `npm run test:security` does.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Namespace, Server as IoServer, Socket } from 'socket.io';

import { AppError, ErrorCode } from '../../src/common/errors';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { AiConversationAccessService } from '../../src/modules/ai/ai-conversation-access.service';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import {
  AI_EVENT,
  room,
} from '../../src/modules/ai-realtime/ai-events.constants';
import { HandoverRealtimeListener } from '../../src/modules/ai-realtime/handover-realtime.listener';
import { RedisIoAdapter } from '../../src/modules/ai-realtime/redis-io.adapter';
import { WsAuthService } from '../../src/modules/ai-realtime/ws-auth.service';
import {
  HandoverAcceptedEvent,
  HandoverRequestedEvent,
} from '../../src/events/handover.events';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import { createMockConfigService } from '../utils/mock-factories';

const APP = 'https://app.example.com';
const BOOK = 'https://book.example.com';
/** Same registrable domain as APP (so "same-site" to a Lax cookie) — but NOT allow-listed. */
const SIBLING = 'https://evil.example.com';
const ATTACKER = 'https://attacker.example';
const SECRET = 'wire-level-test-secret';

const DISCOVERY = 'tenant-discovery';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const INBOX = [
  PERMISSION.AI_HANDOVER_READ,
  PERMISSION.AI_HANDOVER_MANAGE,
  PERMISSION.AI_CONVERSATIONS_MANAGE,
];

interface DialOptions {
  origin?: string;
  cookie?: string;
  secFetchSite?: string;
  token?: string;
  query?: Record<string, string>;
  transports?: ('websocket' | 'polling')[];
  port?: number;
}

interface DialResult {
  socket: ClientSocket;
  /** `ai:connected` arrived — admitted AND authenticated. */
  connected: boolean;
  /** The engine refused the handshake itself (`connect_error`). */
  handshakeRefused: boolean;
  /** Admitted by the engine, then refused by authentication (`ai:error`). */
  aiError?: { code: string; message: string };
}

describe('CSWSH — Socket.IO handshake admission, on the wire', () => {
  const savedEnv = {
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
    API_CLUSTER_WORKERS: process.env.API_CLUSTER_WORKERS,
  };

  const jwt = new JwtService({});
  const principals = new Map<string, AuthenticatedUser | Error>();
  const conversations = new Map<
    string,
    { tenantId: string; guestSubject?: string }
  >();
  const clients: ClientSocket[] = [];

  let httpServer: HttpServer;
  let io: IoServer;
  let ns: Namespace;
  let port: number;
  let gateway: AiRealtimeGateway;
  let wsAuth: WsAuthService;
  let listener: HandoverRealtimeListener;
  let connectionSpy: jest.SpyInstance;
  let orchestrator: { handleStream: jest.Mock };
  let presence: Record<
    'connect' | 'disconnect' | 'setStatus' | 'snapshot',
    jest.Mock
  >;
  let warn: jest.SpyInstance;

  // ── helpers ─────────────────────────────────────────────────────────────

  const guestToken = (sub: string, expiresIn: string | number = '1h') =>
    jwt.signAsync(
      { sub, tenantId: DISCOVERY, guest: true },
      { secret: SECRET, expiresIn: expiresIn as never },
    );

  const staffToken = (
    sub: string,
    tenantId: string,
    expiresIn: string | number = '1h',
  ) =>
    jwt.signAsync(
      { sub, tenantId, type: 'access' },
      { secret: SECRET, expiresIn: expiresIn as never },
    );

  const staff = (
    id: string,
    tenantId: string,
    permissions: string[],
  ): AuthenticatedUser => ({
    id,
    tenantId,
    email: null,
    roles: ['staff'],
    permissions,
  });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error('waitFor: condition not met');
      await wait(15);
    }
  }

  function dial(opts: DialOptions = {}): Promise<DialResult> {
    const headers: Record<string, string> = {};
    if (opts.origin !== undefined) headers.Origin = opts.origin;
    if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
    if (opts.secFetchSite !== undefined)
      headers['Sec-Fetch-Site'] = opts.secFetchSite;

    const socket = ioClient(`http://127.0.0.1:${opts.port ?? port}/ai`, {
      transports: opts.transports ?? ['websocket'],
      extraHeaders: headers,
      auth: opts.token ? { token: opts.token } : undefined,
      query: opts.query,
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);

    return new Promise((resolve) => {
      const done = (r: Omit<DialResult, 'socket'>) => {
        clearTimeout(timer);
        resolve({ socket, ...r });
      };
      const timer = setTimeout(
        () => done({ connected: false, handshakeRefused: false }),
        6000,
      );
      socket.on(AI_EVENT.CONNECTED, () =>
        done({ connected: true, handshakeRefused: false }),
      );
      socket.on(AI_EVENT.ERROR, (aiError: { code: string; message: string }) =>
        done({ connected: false, handshakeRefused: false, aiError }),
      );
      socket.on('connect_error', () =>
        done({ connected: false, handshakeRefused: true }),
      );
    });
  }

  /** Every payload of `event` this client receives from now on. */
  const collect = <T = unknown>(socket: ClientSocket, event: string): T[] => {
    const seen: T[] = [];
    socket.on(event, (payload: T) => seen.push(payload));
    return seen;
  };

  const emitAck = <T = unknown>(
    socket: ClientSocket,
    event: string,
    body?: unknown,
  ) =>
    (body === undefined
      ? socket.timeout(3000).emitWithAck(event)
      : socket.timeout(3000).emitWithAck(event, body)) as Promise<T>;

  const serverSide = (client: ClientSocket): Socket => {
    const s = ns.sockets.get(client.id as string);
    if (!s) throw new Error('server-side socket not found');
    return s;
  };

  /** Mirrors what Nest's `bindMessageHandlers` does for the gateway's `@SubscribeMessage`s. */
  function bindHandlers(socket: Socket): void {
    const ackOf = (ack: unknown) =>
      typeof ack === 'function'
        ? (ack as (v: unknown) => void)
        : () => undefined;
    socket.on(
      AI_EVENT.JOIN,
      (body: never, ack: unknown) =>
        void gateway.onJoin(socket, body).then(ackOf(ack)),
    );
    socket.on(
      AI_EVENT.HANDOVER,
      (body: never, ack: unknown) =>
        void gateway.onHandover(socket, body).then(ackOf(ack)),
    );
    socket.on(
      AI_EVENT.PRESENCE_UPDATE,
      (body: never, ack: unknown) =>
        void gateway.onPresenceUpdate(socket, body).then(ackOf(ack)),
    );
    socket.on(
      AI_EVENT.PRESENCE_SNAPSHOT,
      (ack: unknown) =>
        void gateway.onPresenceSnapshot(socket).then(ackOf(ack)),
    );
    socket.on(
      AI_EVENT.MESSAGE,
      (body: never) => void gateway.onMessage(socket, body),
    );
    socket.on('disconnect', () => void gateway.handleDisconnect(socket));
  }

  function startServer(): { http: HttpServer; io: IoServer; port: number } {
    const http = createServer();
    const adapter = new RedisIoAdapter(http as never);
    const server = adapter.createIOServer(0, {
      // Exactly what the gateway declares. It shapes the POLLING transport's
      // response headers only — the allow-list enforced at the handshake is the
      // adapter's, and is what these tests are about.
      cors: { origin: [APP, BOOK], credentials: true },
    } as never) as IoServer;
    return { http, io: server, port: 0 };
  }

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN = `${APP},${BOOK}`;
    delete process.env.API_CLUSTER_WORKERS;
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const auth = {
      buildAuthenticatedUser: jest.fn(async (id: string) => {
        const p = principals.get(id);
        if (!p) throw new AppError(ErrorCode.USER_INACTIVE);
        if (p instanceof Error) throw p;
        return p;
      }),
    };
    wsAuth = new WsAuthService(
      jwt,
      createMockConfigService({ JWT_ACCESS_SECRET: SECRET }) as never,
      auth as never,
    );

    const fakeConversations = {
      findOne: jest.fn(
        async ({
          where,
        }: {
          where: { id: string; tenant: { id: string } };
        }) => {
          const c = conversations.get(where.id);
          if (!c || c.tenantId !== where.tenant.id) return null;
          return {
            id: where.id,
            tenant: { id: c.tenantId },
            session: c.guestSubject ? { guestSubject: c.guestSubject } : null,
          };
        },
      ),
    };

    orchestrator = { handleStream: jest.fn() };
    presence = {
      connect: jest.fn().mockResolvedValue({ status: 'ONLINE' }),
      disconnect: jest.fn().mockResolvedValue({ status: 'OFFLINE' }),
      setStatus: jest.fn().mockResolvedValue({ status: 'BUSY' }),
      snapshot: jest.fn().mockResolvedValue([{ userId: 'roster-entry' }]),
    };

    gateway = new AiRealtimeGateway(
      wsAuth,
      orchestrator as never,
      new TenantContextService(),
      { create: jest.fn().mockResolvedValue({ id: 'h1' }) } as never,
      { sendAgentReply: jest.fn() } as never,
      presence as never,
      new AiConversationAccessService(fakeConversations as never),
      {
        resolve: jest.fn().mockResolvedValue({ allowed: true }),
        shouldBlock: jest.fn().mockReturnValue(true),
      } as never,
      {
        checkAndRecord: jest.fn().mockResolvedValue({ allowed: true }),
      } as never,
    );
    listener = new HandoverRealtimeListener(gateway);

    const started = startServer();
    httpServer = started.http;
    io = started.io;
    ns = io.of('/ai');
    gateway.server = ns as unknown as IoServer;
    connectionSpy = jest.spyOn(gateway, 'handleConnection');
    ns.on('connection', (socket) => {
      void gateway.handleConnection(socket);
      bindHandlers(socket);
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    port = (httpServer.address() as AddressInfo).port;
  }, 30_000);

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    principals.clear();
    conversations.clear();
    orchestrator.handleStream.mockReset();
    presence.connect.mockClear();
    presence.disconnect.mockClear();
    connectionSpy.mockClear();
    warn.mockClear();
    await wait(30);
  });

  afterAll(async () => {
    await new Promise<void>((r) => io.close(() => r()));
    jest.restoreAllMocks();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // F-1 / F-7 — handshake admission
  // ══════════════════════════════════════════════════════════════════════
  describe('F-1/F-7 — Origin and Fetch Metadata enforced at the handshake', () => {
    it('ACCEPTS the allow-listed origin carrying the visitor cookie — the real frontend path', async () => {
      const cookie = `guest_token=${await guestToken('guest-1')}`;
      const r = await dial({ origin: APP, cookie });
      expect(r).toMatchObject({ connected: true, handshakeRefused: false });
      expect(connectionSpy).toHaveBeenCalledTimes(1);
    });

    it('ACCEPTS the second allow-listed origin (the Marketplace)', async () => {
      const cookie = `guest_token=${await guestToken('guest-1')}`;
      expect((await dial({ origin: BOOK, cookie })).connected).toBe(true);
    });

    it('REFUSES a foreign origin on the WebSocket transport — the attack — before handleConnection runs', async () => {
      const cookie = `guest_token=${await guestToken('victim')}`;
      await waitFor(() => io.engine.clientsCount === 0); // earlier tests' sockets have gone
      const r = await dial({ origin: ATTACKER, cookie });
      expect(r.connected).toBe(false);
      expect(r.handshakeRefused).toBe(true);
      expect(connectionSpy).not.toHaveBeenCalled();
      expect(io.engine.clientsCount).toBe(0); // and the refused handshake created no session
    });

    it('REFUSES the same-site sibling with a valid cookie — SameSite would have let it through', async () => {
      const cookie = `access_token=${await staffToken('victim', TENANT_A)}`;
      principals.set('victim', staff('victim', TENANT_A, INBOX));
      const r = await dial({ origin: SIBLING, cookie });
      expect(r.handshakeRefused).toBe(true);
      expect(connectionSpy).not.toHaveBeenCalled();
    });

    it('REFUSES Origin: null', async () => {
      const cookie = `guest_token=${await guestToken('victim')}`;
      const r = await dial({ origin: 'null', cookie });
      expect(r.handshakeRefused).toBe(true);
      expect(connectionSpy).not.toHaveBeenCalled();
    });

    it('REFUSES a missing Origin when a Cookie is present', async () => {
      const cookie = `guest_token=${await guestToken('victim')}`;
      const r = await dial({ cookie });
      expect(r.handshakeRefused).toBe(true);
      expect(connectionSpy).not.toHaveBeenCalled();
    });

    it('ACCEPTS a missing Origin with an explicit auth.token and NO cookie — native/test clients keep working', async () => {
      const token = await guestToken('native-client');
      const r = await dial({ token });
      expect(r.connected).toBe(true);
    });

    it('REFUSES a foreign origin even when it presents a perfectly valid explicit auth.token', async () => {
      const token = await guestToken('token-holder');
      const r = await dial({ origin: ATTACKER, token });
      expect(r.handshakeRefused).toBe(true);
      expect(connectionSpy).not.toHaveBeenCalled();
    });

    it('REFUSES Sec-Fetch-Site: cross-site from an allow-listed origin (defence in depth)', async () => {
      const cookie = `guest_token=${await guestToken('g')}`;
      const r = await dial({ origin: APP, cookie, secFetchSite: 'cross-site' });
      expect(r.handshakeRefused).toBe(true);
      expect(connectionSpy).not.toHaveBeenCalled();
    });

    it.each(['same-origin', 'same-site', 'none'])(
      'ACCEPTS Sec-Fetch-Site: %s from an allow-listed origin',
      async (site) => {
        const cookie = `guest_token=${await guestToken('g')}`;
        expect(
          (await dial({ origin: APP, cookie, secFetchSite: site })).connected,
        ).toBe(true);
      },
    );

    it('does NOT let Sec-Fetch-Site: same-origin rescue a foreign origin', async () => {
      const cookie = `guest_token=${await guestToken('g')}`;
      const r = await dial({
        origin: ATTACKER,
        cookie,
        secFetchSite: 'same-origin',
      });
      expect(r.handshakeRefused).toBe(true);
    });

    it('logs the refusal with the origin — and never the cookie or the token', async () => {
      // A fresh adapter: the refusal log is throttled per reason, and the tests
      // above have already spent this server's first line for every reason.
      const started = startServer();
      await new Promise<void>((r) => started.http.listen(0, '127.0.0.1', r));
      const freshPort = (started.http.address() as AddressInfo).port;
      const token = await guestToken('secret-holder');
      try {
        warn.mockClear();
        await dial({
          port: freshPort,
          origin: ATTACKER,
          cookie: `guest_token=${token}`,
          token,
        });
        const lines = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes('Refused WebSocket handshake'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('origin_not_allowed');
        expect(lines[0]).toContain(ATTACKER);
        expect(lines[0]).not.toContain(token);
        expect(lines[0]).not.toMatch(/guest_token|access_token|cookie/i);
      } finally {
        await new Promise<void>((r) => started.io.close(() => r()));
      }
    });
  });

  describe('F-1 — the polling transport (the second way in)', () => {
    const poll = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
        headers,
      });

    it('REFUSES a foreign origin outright — no session is created, not merely unreadable', async () => {
      await waitFor(() => io.engine.clientsCount === 0);
      const res = await poll({ Origin: ATTACKER, Cookie: 'guest_token=x' });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('sid');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(io.engine.clientsCount).toBe(0);
    });

    it('REFUSES Origin: null and a missing Origin with a Cookie', async () => {
      expect((await poll({ Origin: 'null' })).status).toBe(403);
      expect((await poll({ Cookie: 'guest_token=x' })).status).toBe(403);
    });

    it('keeps the CORS behaviour for the allowed origin: 200 with credentials-mode headers', async () => {
      const res = await poll({ Origin: APP });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(APP);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      await res.text();
    });

    it('admits a missing Origin with no Cookie (explicit-token client)', async () => {
      const res = await poll({});
      expect(res.status).toBe(200);
      await res.text();
    });

    it('a real client using ONLY polling connects from the allowed origin and is refused from a foreign one', async () => {
      const cookie = `guest_token=${await guestToken('poller')}`;
      expect(
        (await dial({ origin: APP, cookie, transports: ['polling'] }))
          .connected,
      ).toBe(true);
      const bad = await dial({
        origin: ATTACKER,
        cookie,
        transports: ['polling'],
      });
      expect(bad.handshakeRefused).toBe(true);
    });
  });

  describe('F-1 — clustered mode (websocket-only) enforces the same policy', () => {
    it('refuses a foreign origin and admits the allowed one', async () => {
      process.env.API_CLUSTER_WORKERS = '3';
      const started = startServer();
      delete process.env.API_CLUSTER_WORKERS;
      let connections = 0;
      started.io.of('/ai').on('connection', () => {
        connections += 1;
      });
      await new Promise<void>((r) => started.http.listen(0, '127.0.0.1', r));
      const clusterPort = (started.http.address() as AddressInfo).port;
      try {
        const bad = await dial({
          port: clusterPort,
          origin: ATTACKER,
          cookie: 'a=b',
        });
        expect(bad.handshakeRefused).toBe(true);
        expect(connections).toBe(0);
        const good = ioClient(`http://127.0.0.1:${clusterPort}/ai`, {
          transports: ['websocket'],
          extraHeaders: { Origin: APP },
          reconnection: false,
          forceNew: true,
        });
        clients.push(good);
        await new Promise<void>((resolve, reject) => {
          good.on('connect', () => resolve());
          good.on('connect_error', reject);
        });
        expect(connections).toBe(1);
      } finally {
        await new Promise<void>((r) => started.io.close(() => r()));
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // F-5 — no query-string credential
  // ══════════════════════════════════════════════════════════════════════
  describe('F-5 — ?token= is not an authentication mechanism', () => {
    it('a valid token in the query string authenticates nothing', async () => {
      const token = await guestToken('query-holder');
      const r = await dial({ query: { token } });
      expect(r.connected).toBe(false);
      expect(r.aiError).toMatchObject({ code: ErrorCode.UNAUTHORIZED });
      expect(r.aiError?.message).toBe('Missing access token');
    });

    it('the same token in handshake.auth still works — the supported path is intact', async () => {
      expect(
        (await dial({ token: await guestToken('auth-holder') })).connected,
      ).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // F-3 — guest isolation in the shared discovery tenant
  // ══════════════════════════════════════════════════════════════════════
  describe("F-3 — guest A can never receive guest B's data", () => {
    it('a handover request (conversation id + free-text reason) reaches inbox staff and NO guest', async () => {
      principals.set('agent-1', staff('agent-1', DISCOVERY, INBOX));
      const agent = await dial({
        token: await staffToken('agent-1', DISCOVERY),
      });
      const guestA = await dial({ token: await guestToken('guest-A') });
      const guestB = await dial({ token: await guestToken('guest-B') });
      expect([agent.connected, guestA.connected, guestB.connected]).toEqual([
        true,
        true,
        true,
      ]);
      const atAgent = collect<{ reason?: string }>(
        agent.socket,
        AI_EVENT.HANDOVER,
      );
      const atA = collect(guestA.socket, AI_EVENT.HANDOVER);
      const atB = collect(guestB.socket, AI_EVENT.HANDOVER);

      listener.onRequested(
        new HandoverRequestedEvent(
          DISCOVERY,
          'h1',
          'msg-conv',
          'conv-of-A',
          'PRIVATE-REASON-FROM-A',
        ),
      );

      await waitFor(() => atAgent.length === 1); // positive control: the broadcast is real
      await wait(150);
      expect(atAgent[0]).toMatchObject({
        reason: 'PRIVATE-REASON-FROM-A',
        aiConversationId: 'conv-of-A',
      });
      expect(atA).toEqual([]);
      expect(atB).toEqual([]);
    });

    it('guests are not members of any tenant room; inbox staff are', async () => {
      principals.set('agent-1', staff('agent-1', DISCOVERY, INBOX));
      const agent = await dial({
        token: await staffToken('agent-1', DISCOVERY),
      });
      const guest = await dial({ token: await guestToken('guest-A') });
      expect(serverSide(guest.socket).rooms.has(room.tenant(DISCOVERY))).toBe(
        false,
      );
      expect(serverSide(agent.socket).rooms.has(room.tenant(DISCOVERY))).toBe(
        true,
      );
    });

    it('a guest turn never announces its conversation id to the tenant room — a staff turn still does', async () => {
      principals.set('agent-1', staff('agent-1', DISCOVERY, INBOX));
      principals.set('agent-2', staff('agent-2', DISCOVERY, INBOX));
      const agent1 = await dial({
        token: await staffToken('agent-1', DISCOVERY),
      });
      const agent2 = await dial({
        token: await staffToken('agent-2', DISCOVERY),
      });
      const guestA = await dial({ token: await guestToken('guest-A') });
      const guestB = await dial({ token: await guestToken('guest-B') });
      const updatesAtAgent = collect<{ aiConversationId: string }>(
        agent1.socket,
        AI_EVENT.CONVERSATION_UPDATE,
      );
      const updatesAtB = collect(guestB.socket, AI_EVENT.CONVERSATION_UPDATE);
      const doneAtA = collect(guestA.socket, AI_EVENT.DONE);
      const reply = (aiConversationId: string) => ({
        aiConversationId,
        reply: { content: 'hi' },
        usage: {},
        streamed: false,
      });

      // Guest A's turn.
      orchestrator.handleStream.mockResolvedValueOnce(reply('conv-of-A'));
      guestA.socket.emit(AI_EVENT.MESSAGE, { content: 'hello' });
      await waitFor(() => doneAtA.length === 1);
      await wait(150);
      expect(updatesAtAgent).toEqual([]);
      expect(updatesAtB).toEqual([]);

      // Control: a STAFF turn is announced to the inbox, so the silence above is
      // the guard, not a broken broadcast.
      orchestrator.handleStream.mockResolvedValueOnce(reply('conv-of-staff'));
      agent2.socket.emit(AI_EVENT.MESSAGE, { content: 'hello' });
      await waitFor(() => updatesAtAgent.length === 1);
      expect(updatesAtAgent[0]).toEqual({ aiConversationId: 'conv-of-staff' });
      expect(updatesAtB).toEqual([]);
    });

    it("guest B cannot join guest A's conversation room, and so never gets the human agent's replies", async () => {
      conversations.set('conv-of-A', {
        tenantId: DISCOVERY,
        guestSubject: 'guest-A',
      });
      const guestA = await dial({ token: await guestToken('guest-A') });
      const guestB = await dial({ token: await guestToken('guest-B') });
      const errorsAtB = collect<{ code: string }>(
        guestB.socket,
        AI_EVENT.ERROR,
      );
      const atA = collect(guestA.socket, AI_EVENT.HANDOVER);
      const atB = collect(guestB.socket, AI_EVENT.HANDOVER);

      expect(
        await emitAck(guestB.socket, AI_EVENT.JOIN, {
          aiConversationId: 'conv-of-A',
        }),
      ).toEqual({ joined: null });
      expect(errorsAtB.map((e) => e.code)).toEqual([ErrorCode.NOT_FOUND]);
      expect(
        await emitAck(guestA.socket, AI_EVENT.JOIN, {
          aiConversationId: 'conv-of-A',
        }),
      ).toEqual({ joined: 'conv-of-A' });

      listener.onAccepted(
        new HandoverAcceptedEvent(
          DISCOVERY,
          'h1',
          'msg-conv',
          'agent-1',
          'conv-of-A',
        ),
      );
      await waitFor(() => atA.length === 1);
      await wait(150);
      expect(atA[0]).toMatchObject({ type: 'accepted' }); // owner's own conversation: still delivered
      expect(atB).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════
  describe('tenant isolation after the socket is accepted', () => {
    it("tenant A staff receive nothing broadcast to tenant B, and cannot join tenant B's conversation", async () => {
      principals.set('staff-a', staff('staff-a', TENANT_A, INBOX));
      principals.set('staff-b', staff('staff-b', TENANT_B, INBOX));
      conversations.set('conv-of-B', { tenantId: TENANT_B });
      const a = await dial({ token: await staffToken('staff-a', TENANT_A) });
      const b = await dial({ token: await staffToken('staff-b', TENANT_B) });
      const atA = collect(a.socket, AI_EVENT.HANDOVER);
      const atB = collect(b.socket, AI_EVENT.HANDOVER);

      listener.onRequested(
        new HandoverRequestedEvent(TENANT_B, 'h1', 'mc', 'conv-of-B', 'why'),
      );
      await waitFor(() => atB.length === 1);
      await wait(150);
      expect(atA).toEqual([]);

      expect(
        await emitAck(a.socket, AI_EVENT.JOIN, {
          aiConversationId: 'conv-of-B',
        }),
      ).toEqual({ joined: null });
      expect(
        await emitAck(b.socket, AI_EVENT.JOIN, {
          aiConversationId: 'conv-of-B',
        }),
      ).toEqual({ joined: 'conv-of-B' });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // F-6 — permission checks
  // ══════════════════════════════════════════════════════════════════════
  describe('F-6 — staff without an AI permission', () => {
    it('cannot join a conversation room, use presence, or hold the tenant broadcast room', async () => {
      principals.set(
        'doctor',
        staff('doctor', TENANT_A, ['appointments.read']),
      );
      conversations.set('conv-1', { tenantId: TENANT_A });
      const d = await dial({ token: await staffToken('doctor', TENANT_A) });
      expect(d.connected).toBe(true);
      const errors = collect<{ code: string }>(d.socket, AI_EVENT.ERROR);

      expect(serverSide(d.socket).rooms.has(room.tenant(TENANT_A))).toBe(false);
      expect(
        await emitAck(d.socket, AI_EVENT.JOIN, { aiConversationId: 'conv-1' }),
      ).toEqual({ joined: null });
      expect(
        await emitAck(d.socket, AI_EVENT.PRESENCE_UPDATE, { status: 'BUSY' }),
      ).toEqual({ ok: false });
      expect(await emitAck(d.socket, AI_EVENT.PRESENCE_SNAPSHOT)).toEqual([]);
      expect(errors.map((e) => e.code)).toEqual([
        ErrorCode.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        ErrorCode.FORBIDDEN,
      ]);
      expect(presence.setStatus).not.toHaveBeenCalled();
      expect(presence.snapshot).not.toHaveBeenCalled();
      expect(presence.connect).not.toHaveBeenCalled();
    });

    it.each([
      PERMISSION.AI_HANDOVER_READ,
      PERMISSION.AI_HANDOVER_MANAGE,
      PERMISSION.AI_CONVERSATIONS_READ,
      PERMISSION.AI_CONVERSATIONS_MANAGE,
    ])(
      "may join their tenant's conversation with only %s",
      async (permission) => {
        principals.set('s', staff('s', TENANT_A, [permission]));
        conversations.set('conv-1', { tenantId: TENANT_A });
        const s = await dial({ token: await staffToken('s', TENANT_A) });
        expect(
          await emitAck(s.socket, AI_EVENT.JOIN, {
            aiConversationId: 'conv-1',
          }),
        ).toEqual({ joined: 'conv-1' });
      },
    );

    it('inbox staff keep presence and the tenant room', async () => {
      principals.set('agent', staff('agent', TENANT_A, INBOX));
      const a = await dial({ token: await staffToken('agent', TENANT_A) });
      await waitFor(() => presence.connect.mock.calls.length === 1);
      expect(serverSide(a.socket).rooms.has(room.tenant(TENANT_A))).toBe(true);
      expect(
        await emitAck(a.socket, AI_EVENT.PRESENCE_UPDATE, { status: 'BUSY' }),
      ).toEqual({ ok: true });
      expect(await emitAck(a.socket, AI_EVENT.PRESENCE_SNAPSHOT)).toEqual([
        { userId: 'roster-entry' },
      ]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // F-4 — the socket does not outlive its credential or its privileges
  // ══════════════════════════════════════════════════════════════════════
  describe('F-4 — expiry and revalidation', () => {
    it('an event on an expired credential ends the socket instead of being served', async () => {
      const r = await dial({ token: await guestToken('short-lived', 2) });
      expect(r.connected).toBe(true);
      const errors = collect<{ code: string }>(r.socket, AI_EVENT.ERROR);
      const closed = new Promise<string>((res) =>
        r.socket.on('disconnect', res),
      );

      await wait(2300);
      r.socket.emit(AI_EVENT.MESSAGE, { content: 'still there?' });

      expect(await closed).toBe('io server disconnect');
      expect(errors.map((e) => e.code)).toEqual([ErrorCode.UNAUTHORIZED]);
      expect(orchestrator.handleStream).not.toHaveBeenCalled();
    }, 15_000);

    it('the sweep ends an IDLE socket whose credential expired — one that never sends an event', async () => {
      const r = await dial({ token: await guestToken('idle', 2) });
      expect(r.connected).toBe(true);
      const closed = new Promise<string>((res) =>
        r.socket.on('disconnect', res),
      );
      await wait(2300);
      await gateway.revalidateSockets();
      expect(await closed).toBe('io server disconnect');
    }, 15_000);

    it('a deactivated user has every socket ended by the next sweep', async () => {
      principals.set('agent', staff('agent', TENANT_A, INBOX));
      const one = await dial({ token: await staffToken('agent', TENANT_A) });
      const two = await dial({ token: await staffToken('agent', TENANT_A) });
      const closed = [one, two].map(
        (r) => new Promise<string>((res) => r.socket.on('disconnect', res)),
      );

      principals.delete('agent'); // → USER_INACTIVE
      await gateway.revalidateSockets();

      expect(await Promise.all(closed)).toEqual([
        'io server disconnect',
        'io server disconnect',
      ]);
    });

    it('a revoked permission takes the socket OUT of the tenant room and conversation rooms, and refuses the next join', async () => {
      principals.set('agent', staff('agent', TENANT_A, INBOX));
      conversations.set('conv-1', { tenantId: TENANT_A });
      const a = await dial({ token: await staffToken('agent', TENANT_A) });
      await waitFor(() => presence.connect.mock.calls.length === 1);
      expect(
        await emitAck(a.socket, AI_EVENT.JOIN, { aiConversationId: 'conv-1' }),
      ).toEqual({ joined: 'conv-1' });
      const s = serverSide(a.socket);
      expect(s.rooms.has(room.tenant(TENANT_A))).toBe(true);
      expect(s.rooms.has(room.conversation('conv-1'))).toBe(true);
      const errors = collect<{ code: string }>(a.socket, AI_EVENT.ERROR);

      principals.set('agent', staff('agent', TENANT_A, [])); // role stripped
      await gateway.revalidateSockets();

      expect(s.connected).toBe(true); // reduced, not disconnected
      expect(s.rooms.has(room.tenant(TENANT_A))).toBe(false);
      expect(s.rooms.has(room.conversation('conv-1'))).toBe(false);
      expect(presence.disconnect).toHaveBeenCalledTimes(1); // presence count balanced
      expect(
        await emitAck(a.socket, AI_EVENT.JOIN, { aiConversationId: 'conv-1' }),
      ).toEqual({ joined: null });
      expect(
        await emitAck(a.socket, AI_EVENT.PRESENCE_UPDATE, { status: 'AWAY' }),
      ).toEqual({ ok: false });
      expect(errors.map((e) => e.code)).toEqual([
        ErrorCode.FORBIDDEN,
        ErrorCode.FORBIDDEN,
      ]);

      a.socket.close();
      await wait(100);
      expect(presence.disconnect).toHaveBeenCalledTimes(1); // and not double-released on close
    });

    it('a user who moved to another tenant has the socket ended (rooms are tenant-scoped)', async () => {
      principals.set('mover', staff('mover', TENANT_A, INBOX));
      const r = await dial({ token: await staffToken('mover', TENANT_A) });
      const closed = new Promise<string>((res) =>
        r.socket.on('disconnect', res),
      );
      principals.set('mover', staff('mover', TENANT_B, INBOX));
      await gateway.revalidateSockets();
      expect(await closed).toBe('io server disconnect');
    });

    it('a transient lookup failure keeps the socket (and its principal) rather than mass-disconnecting agents', async () => {
      principals.set('agent', staff('agent', TENANT_A, INBOX));
      const r = await dial({ token: await staffToken('agent', TENANT_A) });
      principals.set('agent', new Error('connection pool exhausted'));
      await gateway.revalidateSockets();
      expect(serverSide(r.socket).connected).toBe(true);
      expect(serverSide(r.socket).rooms.has(room.tenant(TENANT_A))).toBe(true);
    });

    it('re-resolves each DISTINCT user once per sweep, however many sockets they hold', async () => {
      principals.set('agent', staff('agent', TENANT_A, INBOX));
      await dial({ token: await staffToken('agent', TENANT_A) });
      await dial({ token: await staffToken('agent', TENANT_A) });
      await dial({ token: await staffToken('agent', TENANT_A) });
      await dial({ token: await guestToken('a-guest') });
      const spy = jest.spyOn(wsAuth, 'revalidate');
      await gateway.revalidateSockets();
      expect(spy).toHaveBeenCalledTimes(1); // one staff user; the guest costs no lookup
    });
  });
});

/**
 * The tests above build the Socket.IO server by calling
 * `RedisIoAdapter.createIOServer` directly. Production does not: `main.ts` calls
 * `app.useWebSocketAdapter(new RedisIoAdapter(app))` and Nest's
 * `SocketServerProvider` → `IoAdapter.create` reach `createIOServer` on their
 * own. This boots a REAL Nest application with exactly that wiring and a
 * gateway declared exactly as `AiRealtimeGateway` is (`namespace: '/ai'`, the
 * same `cors` shape), so the proof does not rest on my reading of Nest's
 * internals. (`AiRealtimeGateway` itself needs the whole AI stack; the admission
 * layer under test sits BELOW the gateway, so a probe gateway is faithful.)
 */
describe('CSWSH — admission through a real Nest application (main.ts wiring)', () => {
  const NEST_APP = 'https://app.example.com';
  const saved = process.env.FRONTEND_ORIGIN;
  let app: INestApplication;
  let port: number;
  let connections = 0;
  let initCalls = 0;
  const sockets: ClientSocket[] = [];

  @WebSocketGateway({
    namespace: '/ai',
    cors: { origin: [NEST_APP], credentials: true },
  })
  class ProbeGateway implements OnGatewayConnection, OnModuleInit {
    // Proves Nest invokes lifecycle hooks on a gateway provider — which is what
    // starts `AiRealtimeGateway`'s revalidation timer (`onModuleInit`).
    onModuleInit(): void {
      initCalls += 1;
    }

    handleConnection(client: Socket): void {
      connections += 1;
      client.emit('ai:connected', {});
    }
  }

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN = NEST_APP;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [ProbeGateway],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Exactly what main.ts does.
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    for (const s of sockets) s.close();
    await app.close();
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.FRONTEND_ORIGIN;
    else process.env.FRONTEND_ORIGIN = saved;
  });

  const attempt = (
    headers: Record<string, string>,
    transports: ('websocket' | 'polling')[] = ['websocket'],
  ) =>
    new Promise<'connected' | 'refused'>((resolve) => {
      const s = ioClient(`http://127.0.0.1:${port}/ai`, {
        transports,
        extraHeaders: headers,
        reconnection: false,
        forceNew: true,
      });
      sockets.push(s);
      const timer = setTimeout(() => resolve('refused'), 6000);
      s.on('ai:connected', () => {
        clearTimeout(timer);
        resolve('connected');
      });
      s.on('connect_error', () => {
        clearTimeout(timer);
        resolve('refused');
      });
    });

  it('invokes onModuleInit on the gateway provider (what starts the revalidation sweep)', () => {
    expect(initCalls).toBe(1);
  });

  it('admits the allow-listed origin', async () => {
    expect(await attempt({ Origin: NEST_APP })).toBe('connected');
    expect(connections).toBe(1);
  });

  it('refuses a foreign origin on the WebSocket transport before the gateway runs', async () => {
    const before = connections;
    expect(
      await attempt({ Origin: 'https://attacker.example', Cookie: 'a=b' }),
    ).toBe('refused');
    expect(connections).toBe(before);
  });

  it('refuses a foreign origin on the polling transport too', async () => {
    const before = connections;
    expect(
      await attempt({ Origin: 'https://attacker.example' }, ['polling']),
    ).toBe('refused');
    expect(connections).toBe(before);
  });

  it('refuses Origin: null, a missing Origin with a cookie, and cross-site Fetch Metadata', async () => {
    const before = connections;
    expect(await attempt({ Origin: 'null' })).toBe('refused');
    expect(await attempt({ Cookie: 'access_token=x' })).toBe('refused');
    expect(
      await attempt({ Origin: NEST_APP, 'Sec-Fetch-Site': 'cross-site' }),
    ).toBe('refused');
    expect(connections).toBe(before);
  });
});
