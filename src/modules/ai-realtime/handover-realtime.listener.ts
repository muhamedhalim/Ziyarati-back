import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AiRealtimeGateway } from './ai-realtime.gateway';
import { AI_EVENT, room } from './ai-events.constants';
import {
  HandoverAcceptedEvent,
  HandoverAgentRepliedEvent,
  HandoverAssignedEvent,
  HandoverConversationClosedEvent,
  HandoverRejectedEvent,
  HandoverReleasedEvent,
  HandoverRequestedEvent,
  HandoverResolvedEvent,
  HandoverReturnedToAiEvent,
  HandoverTransferredEvent,
} from '../../events/handover.events';

/**
 * Bridges `HandoverRequestService`'s domain events (EventEmitter2, global — no
 * module coupling, same pattern as `WorkflowEventListener`) onto the realtime
 * gateway's rooms. This is the ONLY place that turns a handover state change
 * into a live push. The Agent Inbox listens on the TENANT room (it doesn't
 * care about aiConversationId); the customer's own chat session is joined to
 * `room.conversation(aiConversationId)` — a DIFFERENT id than the messaging
 * `Conversation` these events are keyed by — so only events that actually
 * carry an `aiConversationId` also reach that room.
 */
@Injectable()
export class HandoverRealtimeListener {
  private readonly logger = new Logger('HandoverRealtimeListener');

  constructor(private readonly gateway: AiRealtimeGateway) {}

  @OnEvent(HandoverRequestedEvent.eventName)
  onRequested(e: HandoverRequestedEvent) {
    this.broadcast(e.tenantId, { type: 'requested', conversationId: e.conversationId, aiConversationId: e.aiConversationId, reason: e.reason });
  }

  @OnEvent(HandoverAssignedEvent.eventName)
  onAssigned(e: HandoverAssignedEvent) {
    this.broadcast(e.tenantId, { type: 'assigned', conversationId: e.conversationId, assignedToUserId: e.assignedToUserId });
  }

  @OnEvent(HandoverAcceptedEvent.eventName)
  onAccepted(e: HandoverAcceptedEvent) {
    const payload = { type: 'accepted', conversationId: e.conversationId, userId: e.userId };
    this.broadcast(e.tenantId, payload);
    this.toCustomer(e.aiConversationId, payload);
  }

  @OnEvent(HandoverTransferredEvent.eventName)
  onTransferred(e: HandoverTransferredEvent) {
    this.broadcast(e.tenantId, { type: 'transferred', conversationId: e.conversationId, toUserId: e.toUserId });
  }

  @OnEvent(HandoverReturnedToAiEvent.eventName)
  onReturnedToAi(e: HandoverReturnedToAiEvent) {
    const payload = { type: 'returned_to_ai', conversationId: e.conversationId, aiConversationId: e.aiConversationId };
    this.broadcast(e.tenantId, payload);
    this.toCustomer(e.aiConversationId, payload);
  }

  @OnEvent(HandoverResolvedEvent.eventName)
  onResolved(e: HandoverResolvedEvent) {
    this.broadcast(e.tenantId, { type: 'resolved', conversationId: e.conversationId });
  }

  @OnEvent(HandoverRejectedEvent.eventName)
  onRejected(e: HandoverRejectedEvent) {
    this.broadcast(e.tenantId, { type: 'rejected', conversationId: e.conversationId });
  }

  @OnEvent(HandoverReleasedEvent.eventName)
  onReleased(e: HandoverReleasedEvent) {
    this.broadcast(e.tenantId, { type: 'released', conversationId: e.conversationId });
  }

  @OnEvent(HandoverConversationClosedEvent.eventName)
  onClosed(e: HandoverConversationClosedEvent) {
    this.broadcast(e.tenantId, { type: 'closed', conversationId: e.conversationId });
  }

  @OnEvent(HandoverAgentRepliedEvent.eventName)
  onAgentReplied(e: HandoverAgentRepliedEvent) {
    if (e.aiConversationId) {
      this.gateway.server.to(room.conversation(e.aiConversationId)).emit(AI_EVENT.AGENT_MESSAGE, {
        aiConversationId: e.aiConversationId,
        conversationId: e.conversationId,
        content: e.content,
        at: new Date().toISOString(),
      });
    }
    this.gateway.server.to(room.tenant(e.tenantId)).emit(AI_EVENT.CONVERSATION_UPDATE, { conversationId: e.conversationId });
  }

  /** Agent Inbox — every lifecycle event, regardless of which room the customer is in. */
  private broadcast(tenantId: string, payload: Record<string, unknown>): void {
    try {
      this.gateway.server.to(room.tenant(tenantId)).emit(AI_EVENT.HANDOVER, payload);
    } catch (err) {
      this.logger.warn(`broadcast failed: ${(err as Error)?.message}`);
    }
  }

  private toCustomer(aiConversationId: string | undefined, payload: Record<string, unknown>): void {
    if (!aiConversationId) return;
    this.gateway.server.to(room.conversation(aiConversationId)).emit(AI_EVENT.HANDOVER, payload);
  }
}
