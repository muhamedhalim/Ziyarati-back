import { Logger } from '@nestjs/common';
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
import { HandoverChatService } from './handover-chat.service';
import { AgentPresenceService, PresenceStatus } from './agent-presence.service';
import { WsAuthService } from './ws-auth.service';
import { AI_EVENT, room } from './ai-events.constants';

interface MessagePayload {
  content: string;
  idempotencyKey?: string;
  channel?: AiChannel;
  aiConversationId?: string;
  agentId?: string;
  language?: string;
  useMemory?: boolean;
  autoRoute?: boolean;
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
@WebSocketGateway({ namespace: '/ai', cors: { origin: true, credentials: true } })
export class AiRealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
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
  ) {}

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
      client.emit(AI_EVENT.CONNECTED, { userId: user.id, tenantId: user.tenantId });

      // Presence: only meaningful for real staff users (guests/patients aren't
      // "agents"), gated on the same permission the Agent Inbox itself needs.
      if (user.permissions?.includes(PERMISSION.AI_HANDOVER_READ)) {
        const p = this.presence.connect(user.tenantId!, user.id);
        client.to(room.tenant(user.tenantId!)).emit(AI_EVENT.PRESENCE, p);
      }
    } catch (err) {
      client.emit(AI_EVENT.ERROR, { message: (err as Error)?.message ?? 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const { tenantId, userId, user } = client.data as { tenantId?: string; userId?: string; user?: AuthenticatedUser };
    if (!tenantId || !userId) return;
    if (user?.permissions?.includes(PERMISSION.AI_HANDOVER_READ)) {
      const p = this.presence.disconnect(tenantId, userId);
      if (p) client.to(room.tenant(tenantId)).emit(AI_EVENT.PRESENCE, p);
    }
  }

  @SubscribeMessage(AI_EVENT.JOIN)
  onJoin(@ConnectedSocket() client: Socket, @MessageBody() body: { aiConversationId: string }) {
    if (body?.aiConversationId) client.join(room.conversation(body.aiConversationId));
    return { joined: body?.aiConversationId ?? null };
  }

  @SubscribeMessage(AI_EVENT.LEAVE)
  onLeave(@ConnectedSocket() client: Socket, @MessageBody() body: { aiConversationId: string }) {
    if (body?.aiConversationId) client.leave(room.conversation(body.aiConversationId));
    return { left: body?.aiConversationId ?? null };
  }

  @SubscribeMessage(AI_EVENT.TYPING)
  onTyping(@ConnectedSocket() client: Socket, @MessageBody() body: { aiConversationId: string; typing: boolean }) {
    if (body?.aiConversationId) {
      client.to(room.conversation(body.aiConversationId)).emit(AI_EVENT.TYPING, {
        userId: client.data.userId,
        typing: !!body.typing,
      });
    }
  }

  @SubscribeMessage(AI_EVENT.SEEN)
  onSeen(@ConnectedSocket() client: Socket, @MessageBody() body: { aiConversationId: string; messageId: string }) {
    if (body?.aiConversationId) {
      client.to(room.conversation(body.aiConversationId)).emit(AI_EVENT.SEEN, {
        userId: client.data.userId,
        messageId: body.messageId,
      });
    }
  }

  /** Sets the caller's own presence status (Online/Busy/Away). */
  @SubscribeMessage(AI_EVENT.PRESENCE_UPDATE)
  onPresenceUpdate(@ConnectedSocket() client: Socket, @MessageBody() body: { status: 'ONLINE' | 'BUSY' | 'AWAY' }) {
    const tenantId = client.data.tenantId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!tenantId || !userId || !body?.status) return { ok: false };
    const p = this.presence.setStatus(tenantId, userId, body.status as Exclude<PresenceStatus, 'OFFLINE'>);
    this.server.to(room.tenant(tenantId)).emit(AI_EVENT.PRESENCE, p);
    return { ok: true };
  }

  /** Returns the full tenant presence snapshot on demand (Inbox initial load). */
  @SubscribeMessage(AI_EVENT.PRESENCE_SNAPSHOT)
  onPresenceSnapshot(@ConnectedSocket() client: Socket) {
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
  async onHandover(@ConnectedSocket() client: Socket, @MessageBody() body: { aiConversationId: string; reason?: string }) {
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId || !body?.aiConversationId) {
      client.emit(AI_EVENT.ERROR, { message: 'Missing aiConversationId' });
      return { ok: false };
    }
    try {
      const handover = await this.handovers.create(tenantId, {
        aiConversationId: body.aiConversationId,
        reason: body.reason,
      });
      return { ok: true, handoverId: handover.id };
    } catch (err) {
      this.logger.warn(`onHandover failed: ${(err as Error)?.message}`);
      client.emit(AI_EVENT.ERROR, { message: (err as Error)?.message ?? 'Handover request failed' });
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
    if (!tenantId || !userId || !body?.aiConversationId || !body?.content?.trim()) {
      client.emit(AI_EVENT.ERROR, { message: 'Missing fields' });
      return { ok: false };
    }
    if (!user?.permissions?.includes(PERMISSION.AI_HANDOVER_MANAGE)) {
      client.emit(AI_EVENT.ERROR, { message: 'Forbidden' });
      return { ok: false };
    }
    try {
      const result = await this.handoverChat.sendAgentReply(tenantId, userId, body.aiConversationId, body.content.trim());
      return { ok: true, dispatchedToWhatsapp: result.dispatchedToWhatsapp };
    } catch (err) {
      this.logger.warn(`onAgentReply failed: ${(err as Error)?.message}`);
      client.emit(AI_EVENT.ERROR, { message: (err as Error)?.message ?? 'Reply failed' });
      return { ok: false };
    }
  }

  /** The streaming turn: orchestrate → stream tokens → final message. */
  @SubscribeMessage(AI_EVENT.MESSAGE)
  async onMessage(@ConnectedSocket() client: Socket, @MessageBody() body: MessagePayload) {
    const tenantId = client.data.tenantId as string;
    if (!tenantId || !body?.content?.trim()) {
      client.emit(AI_EVENT.ERROR, { message: 'Empty message or unauthenticated socket' });
      return;
    }
    const user = client.data.user as AuthenticatedUser | undefined;
    // Restore the authenticated principal for this turn — every downstream
    // service (booking tools, admin tools, usage metering) reads it via
    // TenantContextService exactly as it would under an HTTP request.
    return this.ctx.run(() => {
      if (user) this.ctx.setPrincipal(user);
      return this.runMessage(client, body, tenantId);
    });
  }

  private async runMessage(client: Socket, body: MessagePayload, tenantId: string): Promise<void> {
    client.emit(AI_EVENT.DELIVERED, { at: new Date().toISOString() });
    client.emit(AI_EVENT.THINKING, { aiConversationId: body.aiConversationId ?? null });

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
        (delta) => client.emit(AI_EVENT.TOKEN, { aiConversationId: body.aiConversationId ?? null, delta }),
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
      client.to(room.conversation(result.aiConversationId)).emit(AI_EVENT.CONVERSATION_UPDATE, done);
      client.to(room.tenant(tenantId)).emit(AI_EVENT.CONVERSATION_UPDATE, { aiConversationId: result.aiConversationId });
    } catch (err) {
      this.logger.warn(`onMessage failed: ${(err as Error)?.message}`);
      client.emit(AI_EVENT.ERROR, { message: (err as Error)?.message ?? 'AI turn failed' });
    }
  }
}
