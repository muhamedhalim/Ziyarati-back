import { Logger } from '@nestjs/common';
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

function resolveCorrelationId(clientSupplied: string | undefined): string {
  if (clientSupplied && CORRELATION_ID_PATTERN.test(clientSupplied)) {
    return clientSupplied;
  }
  return randomUUID();
}

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
  cors: { origin: true, credentials: true },
})
export class AiRealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger('AiRealtimeGateway');

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
  ): Promise<boolean> {
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId || !aiConversationId) return false;
    return this.access.canAccess(
      tenantId,
      aiConversationId,
      client.data.user as AuthenticatedUser | undefined,
    );
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const user = await this.wsAuth.authenticate(client);
      // Keep the flat ids for the existing room-naming code, but also stash the
      // FULL principal so `onMessage` can restore a real TenantContextService
      // scope (roles/permissions) for the AI turn — see WsAuthService docblock.
      client.data.userId = user.id;
      client.data.tenantId = user.tenantId;
      client.data.user = user;
      client.join(room.tenant(user.tenantId!));
      client.emit(AI_EVENT.CONNECTED, {
        userId: user.id,
        tenantId: user.tenantId,
      });

      // Presence: only meaningful for real staff users (guests/patients aren't
      // "agents"), gated on the same permission the Agent Inbox itself needs.
      if (user.permissions?.includes(PERMISSION.AI_HANDOVER_READ)) {
        const p = await this.presence.connect(user.tenantId!, user.id);
        client.to(room.tenant(user.tenantId!)).emit(AI_EVENT.PRESENCE, p);
      }
    } catch (err) {
      client.emit(AI_EVENT.ERROR, {
        message: (err as Error)?.message ?? 'Unauthorized',
      });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const { tenantId, userId, user } = client.data as {
      tenantId?: string;
      userId?: string;
      user?: AuthenticatedUser;
    };
    if (!tenantId || !userId) return;
    if (user?.permissions?.includes(PERMISSION.AI_HANDOVER_READ)) {
      const p = await this.presence.disconnect(tenantId, userId);
      if (p) client.to(room.tenant(tenantId)).emit(AI_EVENT.PRESENCE, p);
    }
  }

  @SubscribeMessage(AI_EVENT.JOIN)
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { aiConversationId: string },
  ) {
    if (!(await this.mayAccess(client, body?.aiConversationId))) {
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
    // N-2: this used to emit into an arbitrary room WITHOUT joining it — a
    // cross-tenant event-injection primitive that needed no membership at all.
    // Ownership first, then membership (a socket that never joined has no
    // business relaying presence into the room).
    if (!(await this.mayAccess(client, body?.aiConversationId))) return;
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
    if (!(await this.mayAccess(client, body?.aiConversationId))) return;
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
    const tenantId = client.data.tenantId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!tenantId || !userId || !body?.status) return { ok: false };
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
    const tenantId = client.data.tenantId as string | undefined;
    return tenantId ? this.presence.snapshot(tenantId) : [];
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
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId || !body?.aiConversationId) {
      client.emit(AI_EVENT.ERROR, { message: 'Missing aiConversationId' });
      return { ok: false };
    }
    // No permission is required (a customer escalating their OWN chat), but
    // "own" has to mean something: without this, any socket could pause the AI
    // on a stranger's conversation and pull a human into it.
    if (!(await this.mayAccess(client, body.aiConversationId))) {
      client.emit(AI_EVENT.ERROR, { message: 'AI conversation not found' });
      return { ok: false };
    }
    // Escalating to a human is part of the AI assistant capability — it pauses
    // an AI conversation and pulls staff into it. A clinic that may not run AI
    // may not drive its handover lifecycle either.
    if (!(await this.mayUseAi(client, AI_EVENT.HANDOVER))) return { ok: false };
    try {
      const handover = await this.handovers.create(tenantId, {
        aiConversationId: body.aiConversationId,
        reason: body.reason,
      });
      return { ok: true, handoverId: handover.id };
    } catch (err) {
      this.logger.warn(`onHandover failed: ${(err as Error)?.message}`);
      client.emit(AI_EVENT.ERROR, {
        message: (err as Error)?.message ?? 'Handover request failed',
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
    const tenantId = client.data.tenantId as string | undefined;
    const userId = client.data.userId as string | undefined;
    const user = client.data.user as AuthenticatedUser | undefined;
    if (
      !tenantId ||
      !userId ||
      !body?.aiConversationId ||
      !body?.content?.trim()
    ) {
      client.emit(AI_EVENT.ERROR, { message: 'Missing fields' });
      return { ok: false };
    }
    if (!user?.permissions?.includes(PERMISSION.AI_HANDOVER_MANAGE)) {
      client.emit(AI_EVENT.ERROR, { message: 'Forbidden' });
      return { ok: false };
    }
    if (!(await this.mayAccess(client, body.aiConversationId))) {
      client.emit(AI_EVENT.ERROR, { message: 'AI conversation not found' });
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
      client.emit(AI_EVENT.ERROR, {
        message: (err as Error)?.message ?? 'Reply failed',
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
    const tenantId = client.data.tenantId as string;
    if (!tenantId || !body?.content?.trim()) {
      client.emit(AI_EVENT.ERROR, {
        message: 'Empty message or unauthenticated socket',
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
      client.emit(AI_EVENT.ERROR, { message: 'Forbidden' });
      return;
    }
    // Restore the authenticated principal for this turn — every downstream
    // service (booking tools, admin tools, usage metering) reads it via
    // TenantContextService exactly as it would under an HTTP request.
    return this.ctx.run(() => {
      if (user) this.ctx.setPrincipal(user);
      // AI-016/C2: Socket.IO frames never traverse the REST correlation
      // middleware (I-3) — without this, every realtime turn's ledger rows
      // carry a null correlation_id. Adopt a well-formed client hint or
      // generate one, same posture as REST's own request-id handling.
      this.ctx.setCorrelationId(resolveCorrelationId(body?.correlationId));
      return this.runMessage(client, body, tenantId);
    });
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
        },
        (delta) =>
          client.emit(AI_EVENT.TOKEN, {
            aiConversationId: body.aiConversationId ?? null,
            delta,
          }),
      );

      // Ensure the sender is in the (possibly new) conversation room for future turns.
      client.join(room.conversation(result.aiConversationId));
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
      };
      client.emit(AI_EVENT.DONE, done);
      // Notify other viewers of this conversation + the tenant's dashboards
      // (the Agent Inbox refreshes on this signal even while HANDED_OVER).
      client
        .to(room.conversation(result.aiConversationId))
        .emit(AI_EVENT.CONVERSATION_UPDATE, done);
      client.to(room.tenant(tenantId)).emit(AI_EVENT.CONVERSATION_UPDATE, {
        aiConversationId: result.aiConversationId,
      });
    } catch (err) {
      this.logger.warn(`onMessage failed: ${(err as Error)?.message}`);
      client.emit(AI_EVENT.ERROR, {
        message: (err as Error)?.message ?? 'AI turn failed',
      });
    }
  }
}
