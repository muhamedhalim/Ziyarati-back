import { Injectable, Logger } from '@nestjs/common';

import { ConversationService } from '../conversations/conversation.service';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { ConversationAiTakeoverService } from '../conversations/conversation-ai-takeover.service';
import {
  CONVERSATION_OWNER_TYPE,
  SENDER_TYPE,
} from '../conversations/conversation.constants';
import { AiExecutionService } from '../ai/ai-execution.service';
import { AppError, ErrorCode } from '../../common/errors';
import { Message } from '../../entities/Conversations/Message';
import { AgentWhatsappDispatcher } from './agent-whatsapp-dispatcher.service';

export interface StaffWhatsappReplyResult {
  message: Message;
  conversationId: string;
  /** True only when WhatsApp accepted it; false = saved but NOT delivered (the message is marked FAILED). */
  dispatchedToWhatsapp: boolean;
  /** When the AI is silenced until, or `null` when automatic takeover is off. */
  aiPausedUntil: Date | null;
}

/**
 * A staff member answers a patient over WhatsApp from the Ziyarati inbox.
 *
 * Until now a message typed in the inbox was only SAVED — it never reached the
 * patient unless the conversation had been formally handed over. This is the
 * send that makes it real, and it is also what makes the AI step aside: a
 * person replying is the signal the clinic's automatic-takeover window starts.
 *
 * Order matters:
 *  1. authorise — the conversation must be this clinic's (404 otherwise), and a
 *     conversation handed to ANOTHER agent is theirs (409), as in a handover;
 *  2. save the reply on the timeline;
 *  3. stamp the takeover window — BEFORE delivery, so an AI turn already running
 *     for this patient sees it at its pre-send check and does not talk over the
 *     person;
 *  4. add the reply to the AI session's history (best-effort), so the AI knows
 *     what the clinic said when it answers again;
 *  5. deliver over WhatsApp (best-effort; a refusal marks the saved message
 *     FAILED instead of losing it).
 *
 * The tenant is the caller's own; the conversation id is only ever looked up
 * inside it.
 */
@Injectable()
export class StaffWhatsappReplyService {
  private readonly logger = new Logger('StaffWhatsappReplyService');

  constructor(
    private readonly conversations: ConversationService,
    private readonly timeline: ConversationExecutionService,
    private readonly takeover: ConversationAiTakeoverService,
    private readonly aiExecution: AiExecutionService,
    private readonly dispatcher: AgentWhatsappDispatcher,
  ) {}

  async send(
    tenantId: string,
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<StaffWhatsappReplyResult> {
    const conversation = await this.conversations.findOne(
      tenantId,
      conversationId,
    );

    const hasNumber = !!(
      conversation.customer?.whatsapp_id || conversation.customer?.phone
    );
    if (!conversation.whatsapp_account || !hasNumber) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This is not a WhatsApp conversation — there is no WhatsApp number to send to',
      });
    }
    if (
      conversation.owner_type === CONVERSATION_OWNER_TYPE.HUMAN &&
      conversation.assigned_to &&
      conversation.assigned_to.id !== userId
    ) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This conversation is assigned to another agent',
      });
    }

    const message = await this.timeline.sendMessage(
      tenantId,
      userId,
      conversationId,
      { content, senderType: SENDER_TYPE.AGENT },
    );

    const aiPausedUntil = await this.takeover.stampStaffReply(
      tenantId,
      conversationId,
    );

    await this.aiExecution
      .recordStaffMessage(tenantId, conversationId, userId, content)
      .catch((err) =>
        this.logger.warn(
          `could not add the staff reply to the AI history (tenant=${tenantId}, conversation=${conversationId}): ${(err as Error)?.message}`,
        ),
      );

    const dispatchedToWhatsapp = await this.dispatcher.dispatch(
      tenantId,
      conversation,
      message.id,
      content,
    );

    return {
      message,
      conversationId,
      dispatchedToWhatsapp,
      aiPausedUntil,
    };
  }
}
