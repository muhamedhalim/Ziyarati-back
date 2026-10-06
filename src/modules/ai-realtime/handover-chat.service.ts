import { Injectable } from '@nestjs/common';

import { HandoverRequestService } from '../ai/handover-request.service';
import { ConversationAiTakeoverService } from '../conversations/conversation-ai-takeover.service';
import { Message } from '../../entities/Conversations/Message';
import { AgentWhatsappDispatcher } from './agent-whatsapp-dispatcher.service';

/**
 * Live Agent Handover — the one place an agent's reply is actually SENT.
 * Persistence (both the AI's own history and the unified timeline) stays in
 * `HandoverRequestService.sendAgentReply` (AiModule) — this service only adds
 * the cross-cutting concerns only the ai-realtime module can safely reach:
 * recording that a person has taken over, and dispatching the reply over
 * WhatsApp when the conversation originated there. The web widget / dashboard
 * realtime chat is notified by the gateway emitting `AI_EVENT.AGENT_MESSAGE`
 * to the conversation room — same channel-agnostic delivery model as the AI's
 * own replies (Requirement #14: one implementation, no per-channel
 * duplication).
 */
@Injectable()
export class HandoverChatService {
  constructor(
    private readonly handovers: HandoverRequestService,
    private readonly dispatcher: AgentWhatsappDispatcher,
    private readonly takeover: ConversationAiTakeoverService,
  ) {}

  async sendAgentReply(
    tenantId: string,
    userId: string,
    aiConversationId: string,
    content: string,
  ): Promise<{
    message: Message;
    conversationId: string;
    dispatchedToWhatsapp: boolean;
  }> {
    const { message, conversation } = await this.handovers.sendAgentReply(
      tenantId,
      userId,
      aiConversationId,
      content,
    );

    // Before delivery, so an AI turn already in flight sees it at its pre-send
    // check. While the conversation is handed over the AI is silent anyway; this
    // is what keeps it silent for the clinic's window once it is returned.
    await this.takeover.stampStaffReply(tenantId, conversation.id);

    const dispatchedToWhatsapp = await this.dispatcher.dispatch(
      tenantId,
      conversation,
      message.id,
      content,
    );

    return { message, conversationId: conversation.id, dispatchedToWhatsapp };
  }
}
