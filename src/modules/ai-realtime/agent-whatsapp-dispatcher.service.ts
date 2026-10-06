import { Injectable, Logger } from '@nestjs/common';

import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { MessageStatusService } from '../conversations/message-status.service';

/** The part of a conversation the dispatcher needs to find the patient. */
export interface DispatchableConversation {
  id: string;
  customer?: { whatsapp_id?: string | null; phone?: string | null } | null;
  whatsapp_account?: { id: string } | null;
}

/**
 * The one place a staff member's reply is actually SENT to the patient over
 * WhatsApp — shared by the handover reply and the inbox reply, so there is a
 * single send, a single provider-id recording and a single failure rule.
 *
 * The message is already saved on the timeline when this runs; this only
 * delivers it. Delivery is best-effort and never throws: the person's reply
 * is not lost because WhatsApp refused it.
 *  - success: the provider message id is recorded onto the timeline message, so
 *    a later delivery/read webhook (matched by wamid) finds its way back to it,
 *    and so a coexistence echo of the same message is recognised as ours;
 *  - failure (no account, refused, provider error): the timeline message is
 *    marked FAILED, so the inbox does not show an undelivered reply as sent.
 *
 * A conversation with no WhatsApp account or no number is not a WhatsApp
 * conversation: nothing is attempted and it is not a failure.
 */
@Injectable()
export class AgentWhatsappDispatcher {
  private readonly logger = new Logger('AgentWhatsappDispatcher');

  constructor(
    private readonly messaging: WhatsappMessagingService,
    private readonly router: WhatsappMessageRouter,
    private readonly timeline: ConversationExecutionService,
    private readonly messageStatus: MessageStatusService,
  ) {}

  /** True only when WhatsApp accepted the message. */
  async dispatch(
    tenantId: string,
    conversation: DispatchableConversation,
    messageId: string,
    content: string,
  ): Promise<boolean> {
    const to =
      conversation.customer?.whatsapp_id || conversation.customer?.phone;
    if (!conversation.whatsapp_account || !to) return false;

    try {
      const account = await this.router.resolveForSend(tenantId, {
        accountId: conversation.whatsapp_account.id,
      });
      const res = await this.messaging.sendSession({
        tenantId,
        accountId: account.id ?? conversation.whatsapp_account.id,
        phoneNumberId: account.phoneNumberId,
        mode: account.mode,
        to,
        text: content,
      });
      if (res.success) {
        if (res.providerMessageId) {
          // FND-023 — lets a later delivery/read webhook (matched by wamid)
          // find its way back to this reply on the unified timeline.
          await this.timeline
            .recordProviderMessageId(tenantId, messageId, res.providerMessageId)
            .catch((e) =>
              this.logger.warn(
                `could not record provider message id: ${(e as Error)?.message}`,
              ),
            );
        }
        return true;
      }
      this.logger.warn(`agent reply WhatsApp send failed: ${res.error}`);
    } catch (err) {
      this.logger.warn(
        `agent reply WhatsApp dispatch failed: ${(err as Error)?.message}`,
      );
    }
    await this.markFailed(tenantId, messageId);
    return false;
  }

  private async markFailed(tenantId: string, messageId: string): Promise<void> {
    try {
      await this.messageStatus.markFailed(tenantId, messageId);
    } catch (err) {
      this.logger.warn(
        `could not mark the undelivered reply FAILED: ${(err as Error)?.message}`,
      );
    }
  }
}
