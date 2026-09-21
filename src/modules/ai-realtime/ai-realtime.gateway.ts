import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { AiChannel } from '../ai-orchestrator/ai-channel.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSION } from '../../rbac/rbac.constants';
import { HandoverRequestService } from '../ai/handover-request.service';
import { AiConversationAccessService } from '../ai/ai-conversation-access.service';
import { HandoverChatService } from './handover-chat.service';
import { AgentPresenceService, PresenceStatus } from './agent-presence.service';
import { WsAuthService } from './ws-auth.service';
import { AI_EVENT, room } from './ai-events.constants';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { normalizeException } from '../../common/errors/error-normalizer';
import { ErrorCode } from '../../common/errors/error-code';
import { AiWsRateLimitService } from './ai-ws-rate-limit.service';
import { parseAllowedOrigins } from '../../config/cors-origins';
import { AI_PUBLIC_TOOL } from '../ai/tools/ai-public-booking-tools.constants';

/**
 * Wire shape of `book_public_appointment`'s successful `toolResult` (see
 * `AiToolDispatchService.bookPublicAppointment`), forwarded on `ai:done` so a
 * booking-capable client can render a confirmation without trusting anything
 * the model said in its text reply. `paymentLink` carries no URL — only the
 * fields the payment-link service actually returns (`token`, `amount`,
 * `currency`, `expiresAt`); a client resolves the token into a route itself.
 */
export interface PublicBookingConfirmationPayload {
  appointmentId: string;
  status: string;
  paymentStatus: string;
  startAt: string;
  endAt: string;
  totalAmount: number | null;
  currency: string;
  hasInsurance: boolean;
  /** The booked branch's own IANA timezone — never the visitor's browser guess. */
  timezone: string;
  paymentLink?: {
    token: string;
    amount: number;
    currency: string;
    expiresAt?: string;
  };
}

/** UUID v4, the only shape `POST /public/guest/attachments` ever mints. */
const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Hard cap mirroring `SendMessageDto`'s `@ArrayMaxSize(3)`. */
const MAX_ATTACHMENT_IDS = 3;

/**
 * Shape-checks the one array a socket frame may now carry.
 *
 * A Socket.IO frame never reaches the global `ValidationPipe`, so anything
 * arriving here is whatever the client felt like sending — including a
 * thousand-element array, or objects where strings belong. This is not the
 * authorization boundary (that is redemption, which is scoped to the socket's
 * verified subject); it exists so a malformed frame is dropped at the edge
 * instead of being carried three layers deeper before something notices.
 */
function sanitizeAttachmentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((v): v is string => typeof v === 'string')
    .filter((v) => ATTACHMENT_ID_PATTERN.test(v))
    .slice(0, MAX_ATTACHMENT_IDS);
  return ids.length > 0 ? ids : undefined;
}

interface MessagePayload {
  content: string;
  idempotencyKey?: string;
  channel?: AiChannel;
  aiConversationId?: string;
  agentId?: string;
  language?: string;
  useMemory?: boolean;
  autoRoute?: boolean;
  /**
   * Files this turn should consider, by the ids `POST
   * /public/guest/attachments` returned.
   *
   * Shape-checked here (`sanitizeAttachmentIds`) because Socket.IO frames
   * never pass through the global `ValidationPipe`; the substantive rules live
   * in `SendMessageDto`. Accepting them from a client is safe regardless:
   * redemption is scoped to this socket's own verified subject, so a forged or
   * foreign id resolves to nothing rather than to someone else's file.
   */
  attachmentIds?: string[];
  /**
   * AI-016/C2 (FR-031, FR-082): an OPTIONAL client-supplied correlation
   * hint for this turn — never an authorization, tenancy, or identity
   * input. Adopted only if well-formed (see `resolveCorrelationId`);
   * otherwise the gateway generates one, exactly as REST's
   * `request-context.middleware.ts` does for `X-Request-Id`.
   */
  correlationId?: string;
}

/**
 * AI-016/C2 (FR-031, FR-082, R4, inspection I-3): `TenantContextService
 * .setCorrelationId` has exactly one production caller today — the Express
 * middleware in `main.ts` — which Socket.IO frames never traverse. Without
 * this, the ledger's correlation column is null for every realtime turn.
 *
 * Bounded charset/length (not merely "non-empty", unlike the REST
 * middleware's own looser check) because this value, unlike an HTTP header
 * set by trusted infrastructure, arrives directly from the browser: it is
 * a correlation HINT only, never trusted for authorization, tenancy, or
 * identity (FR-082) — bounding it keeps a malformed or oversized value from
 * ever reaching a log line or a durable column.
 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * AI-022 (FR-047): kept consistent with `AiConversation.channel`'s own
 * `@Column({ length: 20 })` (`AiConversation.ts:35-36`) — a bare number, not
 * a shared import, since the entity is a persistence concern and this is a
 * fast-fail wire check that must run before any DB write is attempted. If
 * the column's length ever changes, this constant must change with it.
 */
const MAX_CHANNEL_LENGTH = 20;

function resolveCorrelationId(clientSupplied: string | undefined): string {
  if (clientSupplied && CORRELATION_ID_PATTERN.test(clientSupplied)) {
    return clientSupplied;
  }
  return randomUUID();
}

/**
 * How often a connected staff principal is re-resolved from the database (and a
 * lapsed credential is noticed on an idle socket). Bounds how long a socket can
 * outlive a deactivation or a role/permission change: REST re-resolves the
 * principal on EVERY request, a socket resolves it once at connect, so without a
 * bound a revoked agent kept both the privileges and the live broadcasts until
 * the tab closed.
 *
 * A sweep costs one indexed single-row query per DISTINCT connected staff user —
 * never per socket and never per event — and none for guests. That is the reason
 * it is a sweep and not a lookup on each event: a busy inbox would otherwise
 * turn every keystroke's `ai:typing` into a database round trip.
 */
export const WS_REVALIDATE_INTERVAL_MS = 60_000;

/**
 * Who is part of the Agent Inbox audience: the staff the handover REST routes
 * (`ai.handover.read`) already treat as agents, and the same permission that
 * already decides whether a socket registers presence. Only these sockets join
 * the `tenant:<id>` room, so only they receive its broadcasts.
 */
const INBOX_PERMISSION = PERMISSION.AI_HANDOVER_READ;

/**
 * Any one of these lets staff read or act on AI conversations over REST, which
 * is what makes it legitimate for the same staff to hold a conversation room
 * over the socket: that room delivers a human agent's replies and the
 * conversation's lifecycle events, i.e. conversation content in transit.
 * `ai.conversations.*` covers the Dashboard Assistant, `ai.handover.*` the
 * Agent Inbox. A guest is never checked against this — its access to a room is
 * its own conversation, proven by `AiConversationAccessService`.
 */
const CONVERSATION_ROOM_PERMISSIONS: readonly string[] = [
  PERMISSION.AI_HANDOVER_READ,
  PERMISSION.AI_HANDOVER_MANAGE,
  PERMISSION.AI_CONVERSATIONS_READ,
  PERMISSION.AI_CONVERSATIONS_MANAGE,
];

const holds = (user: AuthenticatedUser | undefined, permission: string) =>
  !!user?.permissions?.includes(permission);

/** Staff who may hold the tenant broadcast room and use presence. Never a guest. */
const isInboxStaff = (user: AuthenticatedUser | undefined) =>
  !!user && !user.guest && holds(user, INBOX_PERMISSION);

/** May this principal be in a conversation room at all (ownership is checked separately). */
const mayHoldConversationRooms = (user: AuthenticatedUser | undefined) =>
  !!user &&
  (!!user.guest || CONVERSATION_ROOM_PERMISSIONS.some((p) => holds(user, p)));

/**
 * The same origin allow-list `main.ts` applies to REST, applied to the socket.
 *
 * The gateway used to declare `origin: true`, which reflects whatever `Origin`
 * the request carried — so any site could open a credentialed socket into this
 * namespace using the visitor's own `guest_token` cookie, on a transport that
 * bypasses `CsrfGuard` entirely. REST has refused that since the cookie-auth
 * work landed; this closes the same hole on the transport the public widget
 * actually uses.
 *
 * Read from the identical env var and parsed by the identical helper
 * (`parseAllowedOrigins`), so the two can never drift into disagreeing about
 * which origins are legitimate — including about how an entry is normalized.
 * Evaluated at class definition time, exactly as the decorator requires — same
 * lifecycle as the `app.enableCors` call it mirrors.
 *
 * NOTE FOR TEST/DEPLOY CONFIG: `http://localhost:3000` and
 * `http://127.0.0.1:3000` are DIFFERENT origin strings for the same host. Any
 * harness that serves the app from one must set `FRONTEND_ORIGIN` to match, or
 * the socket is refused while REST appears fine (REST is same-origin through
 * the Next rewrite; the socket is not). Both Playwright configs set it.
 */
const WS_ALLOWED_ORIGINS = parseAllowedOrigins(process.env.FRONTEND_ORIGIN);

/**
 * Realtime AI Gateway (Feature 1, extended for Live Agent Handover). Socket.IO,
 * JWT-authenticated, with strict tenant + conversation room isolation. A
 * `ai:message` runs a STREAMING turn through `AiOrchestratorService.handleStream`
 * (the gateway never calls the AI engine directly), emitting `ai:token` deltas
 * live and `ai:done` at the end. Presence, typing, seen, thinking and handover
 * events are relayed to the right rooms. Horizontal scaling is provided by the
 * Redis adapter (see RedisIoAdapter); this class is adapter-agnostic.
 *
 * Live Agent Handover: `ai:handover` now actually CREATES a real
 * `HandoverRequest` (previously a pure relay stub) — customer-initiated, no
 * permission required (same as a `@Public()` REST endpoint would be). `ai:agent:reply`
 * is staff-only — since sockets bypass the REST `PermissionsGuard`, the
 * permission check happens explicitly here (same pattern already used by
 * `AiToolDispatchService` for tool-level gating over this same gateway).
 */
@WebSocketGateway({
  namespace: '/ai',
  cors: { origin: WS_ALLOWED_ORIGINS, credentials: true },
})
export class AiRealtimeGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger('AiRealtimeGateway');
  private readonly isProduction = process.env.NODE_ENV === 'production';
  private revalidationTimer?: NodeJS.Timeout;
  private revalidating = false;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly ctx: TenantContextService,
    private readonly handovers: HandoverRequestService,
    private readonly handoverChat: HandoverChatService,
    private readonly presence: AgentPresenceService,
    private readonly access: AiConversationAccessService,
    private readonly entitlements: AccessControlService,
    private readonly wsRateLimit: AiWsRateLimitService,
  ) {}

  /**
   * Capability gate for the events that actually EXECUTE something.
   *
   * A socket never passes through `SubscriptionAccessGuard`/`FeatureGuard` —
   * those are HTTP guards — so before this check the `ai:message` event reached
   * `AiOrchestratorService` with no entitlement evaluation whatsoever. A clinic
   * whose AI capability was never granted, or was administratively suspended
   * mid-incident, kept running AI turns for as long as a browser tab stayed
   * open. `AiExecutionService` now refuses those turns at the execution seam
   * too (defence in depth, and the only cover for non-socket transports); this
   * gate exists so the socket client gets a clean `ai:error` instead of a
   * generic failure, and so nothing downstream is touched at all.
   *
   * Never throws — a rejected `@SubscribeMessage` handler would surface as an
   * unhandled exception on the wire. Fails CLOSED on an unreadable decision.
   */
  private async mayUseAi(client: Socket, event: string): Promise<boolean> {
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId) return false;
    try {
      const decision = await this.entitlements.resolve(
        tenantId,
        FeatureKey.AI_ASSISTANT,
      );
      if (decision.allowed) return true;
      if (
        !this.entitlements.shouldBlock(decision, {
          surface: 'websocket',
          detail: event,
        })
      ) {
        return true; // ACCESS_POLICY_MODE=shadow — recorded, not enforced
      }
      this.logger.warn(
        `Refusing "${event}" for tenant ${tenantId}: not entitled to "${FeatureKey.AI_ASSISTANT}" ` +
          `(source=${decision.source})`,
      );
    } catch (err) {
      this.logger.error(
        `AI entitlement check failed for "${event}" (tenant=${tenantId}) — refusing (fail closed): ` +
          `${(err as Error)?.message}`,
      );
    }
    client.emit(AI_EVENT.ERROR, {
      code: ErrorCode.FORBIDDEN,
      message: 'The AI assistant is not available for this clinic',
    });
    return false;
  }

  /**
   * F-2: every handler below takes an `aiConversationId` straight off the wire.
   * `room.conversation(id)` embeds no tenant, so without this check any
   * authenticated socket — including a zero-permission guest — could join or
   * emit into ANY conversation's room, cross-tenant, and receive the
   * `ai:agent:message` a human agent sends (see HandoverRealtimeListener).
   *
   * Returns the socket's own principal alongside the verdict so callers don't
   * re-read `client.data`. Never throws: a socket handler must not reject
   * across the wire with a stack.
   */
  private async mayAccess(
    client: Socket,
    aiConversationId: string | undefined,
    /**
     * Room / reply events only: a STAFF socket may also take part in a web
     * guest's AI conversation (discovery tenant) when its own clinic holds a
     * handover request on it (F-07). Never for `ai:handover` itself, which is the
     * customer's own action, and never for a guest socket.
     */
    opts: { asHandoverAgent?: boolean } = {},
  ): Promise<boolean> {
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId || !aiConversationId) return false;
    const user = client.data.user as AuthenticatedUser | undefined;
    if (await this.access.canAccess(tenantId, aiConversationId, user)) {
      return true;
    }
    if (opts.asHandoverAgent && user && !user.guest) {
      return this.handovers.canAgentAccess(tenantId, aiConversationId);
    }
    return false;
  }

  /**
   * Exact expiry check for the credential that admitted this socket.
   *
   * A token is verified once, at the handshake, and a socket can live for hours.
   * REST re-verifies on every request, so a lapsed token stopped working there
   * immediately while an open socket kept working — and kept receiving room
   * broadcasts — indefinitely. This closes that for events; the sweep closes it
   * for a socket that is only listening.
   *
   * No recorded expiry (a socket that never went through `handleConnection`, or
   * a token minted without `exp` — production tokens always carry one) means
   * there is nothing to enforce, not that the socket is expired.
   *
   * A lapsed credential ENDS the socket rather than answering each later event
   * with an error: it will not become valid again on this connection, and the
   * client re-dials with the cookie it refreshes over REST.
   */
  private assertLive(client: Socket): boolean {
    const expiresAt = client.data.tokenExpiresAt as number | null | undefined;
    if (typeof expiresAt === 'number' && Date.now() >= expiresAt) {
      this.endSession(client, 'Session expired');
      return false;
    }
    return true;
  }

  /**
   * `UNAUTHORIZED` is the code the clients already treat as "this connection is
   * not authenticated" (the widget's `TERMINAL_AUTH_CODES`), so an ended session
   * lands in the same handling as a refused handshake instead of a spinner.
   */
  private endSession(client: Socket, message: string): void {
    client.emit(AI_EVENT.ERROR, { code: ErrorCode.UNAUTHORIZED, message });
    client.disconnect(true);
  }

  /**
   * F-4 — bounds how long an open socket can outlive its handshake. Runs every
   * {@link WS_REVALIDATE_INTERVAL_MS} over the sockets connected to THIS
   * instance (each API instance sweeps its own; nothing needs to coordinate, and
   * no Redis traffic is added):
   *
   *  1. a socket whose credential has expired is ended — including an idle one
   *     that never sends an event for `assertLive` to catch;
   *  2. each DISTINCT staff user is re-resolved once, however many sockets and
   *     tabs they hold, through the same lookup REST uses. A deactivated or
   *     removed user, or one who moved tenant, has every socket ended; otherwise
   *     the fresh roles/permissions replace the ones captured at connect, so
   *     every later event is authorized against the current principal.
   *
   * Users are resolved one at a time on purpose. This is housekeeping and must
   * never compete with request traffic for the connection pool — a burst of
   * parallel lookups is exactly how a background task starves the API.
   *
   * A lookup that FAILS (as opposed to answering "inactive") keeps the current
   * principal until the next sweep: a database blip must not mass-disconnect
   * every agent, and it is retried, not cached.
   *
   * Public so the tick can be driven directly by tests without timers.
   */
  async revalidateSockets(): Promise<void> {
    if (this.revalidating) return;
    // `@WebSocketServer()` is the `/ai` NAMESPACE at runtime (Nest decorates the
    // Server with it) although it is typed `Server`; its `sockets` is the Map of
    // sockets connected to this instance.
    const sockets = (
      this.server as unknown as { sockets?: Map<string, Socket> } | undefined
    )?.sockets;
    if (!sockets) return;

    this.revalidating = true;
    try {
      const now = Date.now();
      const lapsed: Socket[] = [];
      const staffByUser = new Map<string, Socket[]>();
      for (const client of sockets.values()) {
        const expiresAt = client.data.tokenExpiresAt as
          | number
          | null
          | undefined;
        if (typeof expiresAt === 'number' && now >= expiresAt) {
          // Let a turn that is already streaming finish; the next sweep ends
          // the socket. Nothing new can start meanwhile (`assertLive`).
          if (!client.data.turnsInFlight) lapsed.push(client);
          continue;
        }
        const user = client.data.user as AuthenticatedUser | undefined;
        if (!user || user.guest) continue;
        const group = staffByUser.get(user.id);
        if (group) group.push(client);
        else staffByUser.set(user.id, [client]);
      }
      // Ended after the scan, never while iterating the live socket map.
      for (const client of lapsed) this.endSession(client, 'Session expired');
      for (const [userId, clients] of staffByUser) {
        await this.revalidateUser(userId, clients);
      }
    } finally {
      this.revalidating = false;
    }
  }

  private async revalidateUser(
    userId: string,
    clients: Socket[],
  ): Promise<void> {
    let fresh: AuthenticatedUser | null;
    try {
      fresh = await this.wsAuth.revalidate(
        clients[0].data.user as AuthenticatedUser,
      );
    } catch (err) {
      this.logger.warn(
        `Principal revalidation failed for user ${userId}; keeping the current principal until the next sweep: ${(err as Error)?.message}`,
      );
      return;
    }
    for (const client of clients) {
      // Gone, deactivated, or in another tenant now. Rooms are tenant-scoped, so
      // a socket cannot follow a user across that boundary — it has to re-dial
      // and be authenticated into the new one.
      if (!fresh || fresh.tenantId !== client.data.tenantId) {
        this.endSession(client, 'Session is no longer valid');
        continue;
      }
      client.data.user = fresh;
      await this.reconcileRooms(client, fresh);
    }
  }

  /**
   * Takes a still-connected socket OUT of what a reduced principal is no longer
   * entitled to. Only ever removes: a permission gained mid-session takes effect
   * at the next connect, which is the safe direction to be conservative in.
   */
  private async reconcileRooms(
    client: Socket,
    user: AuthenticatedUser,
  ): Promise<void> {
    const tenantId = client.data.tenantId as string;
    if (!isInboxStaff(user)) {
      client.leave(room.tenant(tenantId));
      if (client.data.presenceRegistered) {
        // Balances the `presence.connect` made at handshake — the count is per
        // socket, and `handleDisconnect` no longer will (the flag is cleared).
        client.data.presenceRegistered = false;
        const p = await this.presence.disconnect(tenantId, user.id);
        if (p) client.to(room.tenant(tenantId)).emit(AI_EVENT.PRESENCE, p);
      }
    }
    if (!mayHoldConversationRooms(user)) {
      const prefix = room.conversation('');
      for (const joined of [...client.rooms]) {
        if (joined.startsWith(prefix)) client.leave(joined);
      }
    }
  }

  onModuleInit(): void {
    this.revalidationTimer = setInterval(
      () => void this.revalidateSockets(),
      WS_REVALIDATE_INTERVAL_MS,
    );
    // A housekeeping timer must never be the thing that keeps a process (or a
    // test runner) alive.
    this.revalidationTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.revalidationTimer) clearInterval(this.revalidationTimer);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const { user, expiresAt } =
        await this.wsAuth.authenticateHandshake(client);
      // Keep the flat ids for the existing room-naming code, but also stash the
      // FULL principal so `onMessage` can restore a real TenantContextService
      // scope (roles/permissions) for the AI turn — see WsAuthService docblock.
      client.data.userId = user.id;
      client.data.tenantId = user.tenantId;
      client.data.user = user;
      // The credential's own expiry, enforced for the life of the socket (see
      // `assertLive` / `revalidateSockets`) instead of only at this handshake.
      client.data.tokenExpiresAt = expiresAt;

      // The tenant room carries the Agent Inbox's signals — handover lifecycle
      // (with the customer's free-text reason), conversation ids, presence.
      // Every anonymous visitor is minted into ONE shared discovery tenant, so
      // joining it unconditionally made this room a broadcast channel between
      // strangers: guest A received guest B's conversation id and handover
      // reason. Only inbox staff, who are entitled to those, join it.
      const inbox = isInboxStaff(user);
      if (inbox) client.join(room.tenant(user.tenantId!));
      client.emit(AI_EVENT.CONNECTED, {
        userId: user.id,
        tenantId: user.tenantId,
      });

      // Presence: only meaningful for real staff users (guests/patients aren't
      // "agents"), gated on the same permission the Agent Inbox itself needs.
      // Recorded on the socket so the matching `disconnect` (the presence
      // count is per socket) does not have to re-derive it from permissions
      // that may have changed since. Set BEFORE the await, not after: a socket
      // that disconnects while its own `connect` is still in flight must still
      // release, or the count it is about to add is never taken back.
      if (inbox) {
        client.data.presenceRegistered = true;
        const p = await this.presence.connect(user.tenantId!, user.id);
        client.to(room.tenant(user.tenantId!)).emit(AI_EVENT.PRESENCE, p);
      }
    } catch (err) {
      const normalized = normalizeException(err, this.isProduction);
      client.emit(AI_EVENT.ERROR, {
        code: normalized.code,
        message: normalized.message,
      });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const { tenantId, userId, presenceRegistered } = client.data as {
      tenantId?: string;
      userId?: string;
      presenceRegistered?: boolean;
    };
    if (!tenantId || !userId || !presenceRegistered) return;
    client.data.presenceRegistered = false;
    const p = await this.presence.disconnect(tenantId, userId);
    if (p) client.to(room.tenant(tenantId)).emit(AI_EVENT.PRESENCE, p);
  }

  @SubscribeMessage(AI_EVENT.JOIN)
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { aiConversationId: string },
  ) {
    if (!this.assertLive(client)) return { joined: null };
    // F-6: a conversation room delivers a human agent's replies and lifecycle
    // events, and `mayAccess` below is tenant-scoped for staff — so without a
    // permission check ANY staff member (a doctor with no AI role at all) could
    // join any conversation in the clinic and read it live. Checked before the
    // ownership lookup so an unpermitted socket costs no query.
    if (!mayHoldConversationRooms(client.data.user as AuthenticatedUser)) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
      return { joined: null };
    }
    if (
      !(await this.mayAccess(client, body?.aiConversationId, {
        asHandoverAgent: true,
      }))
    ) {
      // Unified error contract (`{code, message}` on every conversation-
      // related failure — join/message/handover/agent-reply alike): this used
      // to fail silently (no `ai:error` at all), so a client whose restored
      // `aiConversationId` no longer resolves had no signal to drop it until
      // the NEXT turn's `ai:message` also failed. Ack shape (`joined: null`)
      // is unchanged for any caller reading it directly.
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.NOT_FOUND,
        message: 'AI conversation not found',
      });
      return { joined: null };
    }
    client.join(room.conversation(body.aiConversationId));
    return { joined: body.aiConversationId };
  }

  /**
   * Leaving needs no ownership check — a socket can only remove ITSELF from a
   * room, and `join` is now guarded, so there is nothing to protect here.
   */
  @SubscribeMessage(AI_EVENT.LEAVE)
  onLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { aiConversationId: string },
  ) {
    if (body?.aiConversationId)
      client.leave(room.conversation(body.aiConversationId));
    return { left: body?.aiConversationId ?? null };
  }

  @SubscribeMessage(AI_EVENT.TYPING)
  async onTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { aiConversationId: string; typing: boolean },
  ) {
    if (!this.assertLive(client)) return;
    // N-2: this used to emit into an arbitrary room WITHOUT joining it — a
    // cross-tenant event-injection primitive that needed no membership at all.
    // Ownership first, then membership (a socket that never joined has no
    // business relaying presence into the room).
    if (
      !(await this.mayAccess(client, body?.aiConversationId, {
        asHandoverAgent: true,
      }))
    )
      return;
    const target = room.conversation(body.aiConversationId);
    if (!client.rooms.has(target)) return;

    client.to(target).emit(AI_EVENT.TYPING, {
      userId: client.data.userId,
      typing: !!body.typing,
    });
  }

  @SubscribeMessage(AI_EVENT.SEEN)
  async onSeen(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { aiConversationId: string; messageId: string },
  ) {
    if (!this.assertLive(client)) return;
    if (
      !(await this.mayAccess(client, body?.aiConversationId, {
        asHandoverAgent: true,
      }))
    )
      return;
    const target = room.conversation(body.aiConversationId);
    if (!client.rooms.has(target)) return;

    client.to(target).emit(AI_EVENT.SEEN, {
      userId: client.data.userId,
      messageId: body.messageId,
    });
  }

  /** Sets the caller's own presence status (Online/Busy/Away). */
  @SubscribeMessage(AI_EVENT.PRESENCE_UPDATE)
  async onPresenceUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { status: 'ONLINE' | 'BUSY' | 'AWAY' },
  ) {
    if (!this.assertLive(client)) return { ok: false };
    const tenantId = client.data.tenantId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!tenantId || !userId || !body?.status) return { ok: false };
    // F-6: presence describes AGENTS. A socket only registers it at connect if
    // the principal holds `ai.handover.read`; this event let any authenticated
    // socket write itself into the tenant's presence map (which the queue's
    // "who is available" view reads) and broadcast that to the inbox anyway.
    if (!isInboxStaff(client.data.user as AuthenticatedUser)) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
      return { ok: false };
    }
    const p = await this.presence.setStatus(
      tenantId,
      userId,
      body.status as Exclude<PresenceStatus, 'OFFLINE'>,
    );
    this.server.to(room.tenant(tenantId)).emit(AI_EVENT.PRESENCE, p);
    return { ok: true };
  }

  /** Returns the full tenant presence snapshot on demand (Inbox initial load). */
  @SubscribeMessage(AI_EVENT.PRESENCE_SNAPSHOT)
  async onPresenceSnapshot(@ConnectedSocket() client: Socket) {
    if (!this.assertLive(client)) return [];
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId) return [];
    // F-6: the snapshot is the tenant's staff roster with their status — inbox
    // data, not something every authenticated socket (including a guest, whose
    // "tenant" is the shared discovery tenant) is entitled to pull.
    if (!isInboxStaff(client.data.user as AuthenticatedUser)) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
      return [];
    }
    return this.presence.snapshot(tenantId);
  }

  /**
   * Customer-initiated (no permission required — analogous to a `@Public()`
   * REST endpoint): creates a REAL HandoverRequest and immediately stops the
   * AI. Broadcasts are handled by `HandoverRealtimeListener` reacting to the
   * domain event `HandoverRequestService.create` emits — this handler stays a
   * thin trigger, no duplicated broadcast logic.
   */
  @SubscribeMessage(AI_EVENT.HANDOVER)
  async onHandover(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { aiConversationId: string; reason?: string },
  ) {
    if (!this.assertLive(client)) return { ok: false };
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId || !body?.aiConversationId) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Missing aiConversationId',
      });
      return { ok: false };
    }
    // No permission is required (a customer escalating their OWN chat), but
    // "own" has to mean something: without this, any socket could pause the AI
    // on a stranger's conversation and pull a human into it.
    if (!(await this.mayAccess(client, body.aiConversationId))) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.NOT_FOUND,
        message: 'AI conversation not found',
      });
      return { ok: false };
    }
    // Escalating to a human is part of the AI assistant capability — it pauses
    // an AI conversation and pulls staff into it. A clinic that may not run AI
    // may not drive its handover lifecycle either.
    if (!(await this.mayUseAi(client, AI_EVENT.HANDOVER))) return { ok: false };
    try {
      // A web guest's request is filed under the clinic it selected (F-07);
      // staff / other principals escalate within their own tenant, as before.
      const handover = await this.handovers.requestForCustomer(
        tenantId,
        client.data.user as AuthenticatedUser | undefined,
        {
          aiConversationId: body.aiConversationId,
          reason: body.reason,
        },
      );
      return { ok: true, handoverId: handover.id };
    } catch (err) {
      this.logger.warn(`onHandover failed: ${(err as Error)?.message}`);
      const normalized = normalizeException(err, this.isProduction);
      client.emit(AI_EVENT.ERROR, {
        code: normalized.code,
        message: normalized.message,
      });
      return { ok: false };
    }
  }

  /** Staff-only: reply while the conversation is HANDED_OVER (Conversation Locking enforced downstream). */
  @SubscribeMessage(AI_EVENT.AGENT_REPLY)
  async onAgentReply(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { aiConversationId: string; content: string },
  ) {
    if (!this.assertLive(client)) return { ok: false };
    const tenantId = client.data.tenantId as string | undefined;
    const userId = client.data.userId as string | undefined;
    const user = client.data.user as AuthenticatedUser | undefined;
    if (
      !tenantId ||
      !userId ||
      !body?.aiConversationId ||
      !body?.content?.trim()
    ) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Missing fields',
      });
      return { ok: false };
    }
    if (!user?.permissions?.includes(PERMISSION.AI_HANDOVER_MANAGE)) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
      return { ok: false };
    }
    if (
      !(await this.mayAccess(client, body.aiConversationId, {
        asHandoverAgent: true,
      }))
    ) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.NOT_FOUND,
        message: 'AI conversation not found',
      });
      return { ok: false };
    }
    if (!(await this.mayUseAi(client, AI_EVENT.AGENT_REPLY))) {
      return { ok: false };
    }
    try {
      const result = await this.handoverChat.sendAgentReply(
        tenantId,
        userId,
        body.aiConversationId,
        body.content.trim(),
      );
      return { ok: true, dispatchedToWhatsapp: result.dispatchedToWhatsapp };
    } catch (err) {
      this.logger.warn(`onAgentReply failed: ${(err as Error)?.message}`);
      const normalized = normalizeException(err, this.isProduction);
      client.emit(AI_EVENT.ERROR, {
        code: normalized.code,
        message: normalized.message,
      });
      return { ok: false };
    }
  }

  /** The streaming turn: orchestrate → stream tokens → final message. */
  @SubscribeMessage(AI_EVENT.MESSAGE)
  async onMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: MessagePayload,
  ) {
    if (!this.assertLive(client)) return;
    const tenantId = client.data.tenantId as string;
    if (!tenantId || !body?.content?.trim()) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Empty message or unauthenticated socket',
      });
      return;
    }
    // AI-022 (FR-046, FR-047): validated BEFORE persistence — the un-bounded
    // `channel` used to reach the DB write as a raw, unhandled Postgres
    // "value too long for type character varying(20)" error. `code` is
    // VALIDATION_ERROR — distinguishable from RATE_LIMITED/FORBIDDEN without
    // parsing message text (FR-102c); `message` is a fixed, non-localized
    // developer string the client localizes itself (FR-102a).
    if (body.channel && body.channel.length > MAX_CHANNEL_LENGTH) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.VALIDATION_ERROR,
        message: `channel must be at most ${MAX_CHANNEL_LENGTH} characters`,
      });
      return;
    }
    // The gate that closes the WebSocket bypass: before this, `ai:message`
    // reached the orchestrator with no entitlement evaluation at all.
    if (!(await this.mayUseAi(client, AI_EVENT.MESSAGE))) return;
    const user = client.data.user as AuthenticatedUser | undefined;
    // AI-007: REST's equivalent STAFF route requires `ai.conversations.manage`
    // (`@RequirePermissions`, ai-conversation.controller.ts); this transport
    // never checked it. Same hand-written pattern this gateway already uses
    // at onAgentReply (`:338-341`) — not a new mechanism (FR-015). An
    // `ai:error`, never a throw across the socket (FR-016). Access is
    // restored only by granting the role this permission through the
    // existing role-and-permission mechanism — never by weakening or
    // special-casing this check for a STAFF principal (FR-016c).
    //
    // Guests are exempt, not special-cased around FR-016c: `WsAuthService`
    // mints them with `permissions: []` and `guest: true` (never a `users`
    // row, never a role) — REST has no equivalent gate for them at all, this
    // transport is the ONLY way `PublicAiWidget` reaches an AI turn, and the
    // guest's own tenant/entitlement checks above already ran. Applying this
    // staff permission to a principal that structurally can never hold any
    // permission would silently break public AI-guided booking, not restore
    // parity with anything REST does for guests.
    if (
      !user?.guest &&
      !user?.permissions?.includes(PERMISSION.AI_CONVERSATIONS_MANAGE)
    ) {
      client.emit(AI_EVENT.ERROR, {
        code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
      return;
    }
    // AI-015/AI-028 (FR-051, FR-053, D5): after entitlement + permission,
    // before the turn runs — so a permission-refused call never consumes
    // rate-limit budget. Identity is never client-supplied (FR-052): the
    // authenticated user id, or the guest subject (WsAuthService mints a
    // guest's `id` AS the token subject — the same value), or, only absent
    // both, the Socket.IO connection id.
    const identity = user?.id ?? client.id;
    const rateLimit = await this.wsRateLimit.checkAndRecord(
      identity,
      user?.guest ? 'guest' : 'authenticated',
    );
    if (!rateLimit.allowed) {
      client.emit(AI_EVENT.ERROR, {
        code: rateLimit.code,
        message:
          rateLimit.code === ErrorCode.SERVICE_UNAVAILABLE
            ? 'The AI assistant is temporarily unavailable. Please try again shortly.'
            : 'Too many messages sent too quickly. Please slow down.',
      });
      return;
    }
    // Restore the authenticated principal for this turn — every downstream
    // service (booking tools, admin tools, usage metering) reads it via
    // TenantContextService exactly as it would under an HTTP request.
    //
    // The turn is counted while it runs so the credential-expiry sweep does not
    // cut a legitimate answer off mid-stream (see `revalidateSockets`). It only
    // defers the END of the socket: a NEW event after expiry is still refused
    // at once by `assertLive`, so this cannot be used to extend a session.
    client.data.turnsInFlight = (client.data.turnsInFlight ?? 0) + 1;
    try {
      return await this.ctx.run(() => {
        if (user) this.ctx.setPrincipal(user);
        // AI-016/C2: Socket.IO frames never traverse the REST correlation
        // middleware (I-3) — without this, every realtime turn's ledger rows
        // carry a null correlation_id. Adopt a well-formed client hint or
        // generate one, same posture as REST's own request-id handling.
        this.ctx.setCorrelationId(resolveCorrelationId(body?.correlationId));
        return this.runMessage(client, body, tenantId);
      });
    } finally {
      client.data.turnsInFlight -= 1;
    }
  }

  private async runMessage(
    client: Socket,
    body: MessagePayload,
    tenantId: string,
  ): Promise<void> {
    client.emit(AI_EVENT.DELIVERED, { at: new Date().toISOString() });
    client.emit(AI_EVENT.THINKING, {
      aiConversationId: body.aiConversationId ?? null,
    });

    try {
      const result = await this.orchestrator.handleStream(
        tenantId,
        {
          channel: body.channel ?? 'WEBSITE',
          content: body.content,
          idempotencyKey: body.idempotencyKey,
          aiConversationId: body.aiConversationId,
          agentId: body.agentId,
          language: body.language,
          useMemory: body.useMemory,
          autoRoute: body.autoRoute,
          attachmentIds: sanitizeAttachmentIds(body.attachmentIds),
        },
        (delta) =>
          client.emit(AI_EVENT.TOKEN, {
            aiConversationId: body.aiConversationId ?? null,
            delta,
          }),
        // Tool progress. Emitted to THIS socket only — never to the
        // conversation or tenant room: the caller is the only party waiting on
        // a spinner, and a staff inbox has no use for another client's
        // per-tool chatter. The payload is the tool name and phase, nothing
        // else (see `AiToolProgressEvent`).
        (event) =>
          client.emit(AI_EVENT.TOOL, {
            aiConversationId: body.aiConversationId ?? null,
            name: event.name,
            phase: event.phase,
          }),
      );

      // Ensure the sender is in the (possibly new) conversation room for future turns.
      client.join(room.conversation(result.aiConversationId));
      // Forward `book_public_appointment`'s result — computed server-side
      // either way — so a booking-capable client can render a real
      // confirmation instead of relying on whatever the model paraphrased in
      // its text reply. Guarded on BOTH the tool name and its own `success`
      // flag: `lastTool` is genuinely the LAST tool call of the turn, which is
      // only ever the booking call when nothing else ran afterward, and a
      // failed attempt (validation error, slot taken) carries no booking
      // fields to forward at all.
      const lastToolResult = result.lastTool?.result as
        | ({ success?: boolean } & Partial<PublicBookingConfirmationPayload>)
        | undefined;
      const bookingConfirmation: PublicBookingConfirmationPayload | undefined =
        result.lastTool?.name === AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT &&
        lastToolResult?.success === true
          ? {
              appointmentId: lastToolResult.appointmentId!,
              status: lastToolResult.status!,
              paymentStatus: lastToolResult.paymentStatus!,
              startAt: lastToolResult.startAt!,
              endAt: lastToolResult.endAt!,
              totalAmount: lastToolResult.totalAmount ?? null,
              currency: lastToolResult.currency!,
              hasInsurance: lastToolResult.hasInsurance ?? false,
              timezone: lastToolResult.timezone!,
              ...(lastToolResult.paymentLink
                ? { paymentLink: lastToolResult.paymentLink }
                : {}),
            }
          : undefined;
      const done = {
        aiConversationId: result.aiConversationId,
        agentRole: result.agentRole,
        reply: result.reply,
        usage: result.usage,
        streamed: result.streamed,
        // Live Agent Handover: true when a human now owns this conversation —
        // the message was persisted but the AI did not answer. The client
        // should show a "waiting for a human agent" state instead of an empty
        // assistant bubble, and switch to listening for AI_EVENT.AGENT_MESSAGE.
        handedOver: result.handedOver ?? false,
        ...(bookingConfirmation ? { bookingConfirmation } : {}),
      };
      client.emit(AI_EVENT.DONE, done);
      // Notify other viewers of this conversation + the tenant's dashboards
      // (the Agent Inbox refreshes on this signal even while HANDED_OVER).
      client
        .to(room.conversation(result.aiConversationId))
        .emit(AI_EVENT.CONVERSATION_UPDATE, done);
      // A guest's conversation id goes to its own conversation room (above) and
      // nowhere else: the tenant room is the Agent Inbox's, and a guest's
      // "tenant" is the one every visitor shares.
      if (!client.data.user?.guest) {
        client.to(room.tenant(tenantId)).emit(AI_EVENT.CONVERSATION_UPDATE, {
          aiConversationId: result.aiConversationId,
        });
      }
    } catch (err) {
      this.logger.warn(`onMessage failed: ${(err as Error)?.message}`);
      const normalized = normalizeException(err, this.isProduction);
      client.emit(AI_EVENT.ERROR, {
        code: normalized.code,
        message: normalized.message,
      });
    }
  }
}
