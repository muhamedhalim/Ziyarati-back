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
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const principal = await this.wsAuth.authenticate(client);
      client.data.userId = principal.userId;
      client.data.tenantId = principal.tenantId;
      client.join(room.tenant(principal.tenantId));
      client.emit(AI_EVENT.CONNECTED, { userId: principal.userId, tenantId: principal.tenantId });
      client.to(room.tenant(principal.tenantId)).emit(AI_EVENT.PRESENCE, { userId: principal.userId, online: true });
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
