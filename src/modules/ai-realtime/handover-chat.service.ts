import { Injectable, Logger } from '@nestjs/common';

import { HandoverRequestService } from '../ai/handover-request.service';
import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { Message } from '../../entities/Conversations/Message';

/**
 * Live Agent Handover — the one place an agent's reply is actually SENT.
 * Persistence (both the AI's own history and the unified timeline) stays in
 * `HandoverRequestService.sendAgentReply` (AiModule) — this service only adds
 * the cross-cutting concern only the ai-realtime module can safely reach:
 * dispatching the reply over WhatsApp when the conversation originated there.
 * The web widget / dashboard realtime chat is notified by the gateway emitting
 * `AI_EVENT.AGENT_MESSAGE` to the conversation room — same channel-agnostic
 * delivery model as the AI's own replies (Requirement #14: one implementation,
 * no per-channel duplication).
 */
@Injectable()
export class HandoverChatService {
  private readonly logger = new Logger('HandoverChatService');

  constructor(
    private readonly handovers: HandoverRequestService,
    private readonly messaging: WhatsappMessagingService,
    private readonly router: WhatsappMessageRouter,
  ) {}

  async sendAgentReply(
    tenantId: string,
    userId: string,
    aiConversationId: string,
    content: string,
  ): Promise<{ message: Message; conversationId: string; dispatchedToWhatsapp: boolean }> {
    const { message, conversation } = await this.handovers.sendAgentReply(tenantId, userId, aiConversationId, content);

    let dispatchedToWhatsapp = false;
    const to = conversation.customer?.whatsapp_id || conversation.customer?.phone;
    if (conversation.whatsapp_account && to) {
      try {
        const account = await this.router.resolveForSend(tenantId, { accountId: conversation.whatsapp_account.id });
        const res = await this.messaging.sendSession({
          tenantId,
          accountId: account.id ?? conversation.whatsapp_account.id,
          phoneNumberId: account.phoneNumberId,
          mode: account.mode,
          to,
          text: content,
        });
        dispatchedToWhatsapp = res.success;
        if (!res.success) this.logger.warn(`agent reply WhatsApp send failed: ${res.error}`);
      } catch (err) {
        this.logger.warn(`agent reply WhatsApp dispatch failed: ${(err as Error)?.message}`);
      }
    }

    return { message, conversationId: conversation.id, dispatchedToWhatsapp };
  }
}
