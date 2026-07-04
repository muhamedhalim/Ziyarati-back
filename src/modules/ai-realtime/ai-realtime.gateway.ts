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
import { WsAuthService } from './ws-auth.service';
import { AI_EVENT, room } from './ai-events.constants';

interface MessagePayload {
  content: string;
  channel?: AiChannel;
  aiConversationId?: string;
  agentId?: string;
  language?: string;
  useMemory?: boolean;
  autoRoute?: boolean;
}

/**
 * Realtime AI Gateway (Feature 1). Socket.IO, JWT-authenticated, with strict
 * tenant + conversation room isolation. A `ai:message` runs a STREAMING turn
 * through `AiOrchestratorService.handleStream` (the gateway never calls the AI
 * engine directly), emitting `ai:token` deltas live and `ai:done` at the end.
 * Presence, typing, seen, thinking and handover events are relayed to the right
 * rooms. Horizontal scaling is provided by the Redis adapter (see
 * RedisIoAdapter); this class is adapter-agnostic.
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
      client.to(room.tenant(user.tenantId!)).emit(AI_EVENT.PRESENCE, { userId: user.id, online: true });
    } catch (err) {
      client.emit(AI_EVENT.ERROR, { message: (err as Error)?.message ?? 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const { tenantId, userId } = client.data as { tenantId?: string; userId?: string };
    if (tenantId) client.to(room.tenant(tenantId)).emit(AI_EVENT.PRESENCE, { userId, online: false });
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

  /** Relay a human-handover signal to the tenant's staff (real transfer logic
   *  stays in HandoverRequestService — this only notifies in realtime). */
  @SubscribeMessage(AI_EVENT.HANDOVER)
  onHandover(@ConnectedSocket() client: Socket, @MessageBody() body: { aiConversationId: string; reason?: string }) {
    const tenantId = client.data.tenantId as string;
    this.server.to(room.tenant(tenantId)).emit(AI_EVENT.HANDOVER, {
      aiConversationId: body?.aiConversationId,
      reason: body?.reason ?? null,
      requestedBy: client.data.userId,
      at: new Date().toISOString(),
    });
    return { ok: true };
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
      };
      client.emit(AI_EVENT.DONE, done);
      // Notify other viewers of this conversation + the tenant's dashboards.
      client.to(room.conversation(result.aiConversationId)).emit(AI_EVENT.CONVERSATION_UPDATE, done);
      client.to(room.tenant(tenantId)).emit(AI_EVENT.CONVERSATION_UPDATE, { aiConversationId: result.aiConversationId });
    } catch (err) {
      this.logger.warn(`onMessage failed: ${(err as Error)?.message}`);
      client.emit(AI_EVENT.ERROR, { message: (err as Error)?.message ?? 'AI turn failed' });
    }
  }
}
