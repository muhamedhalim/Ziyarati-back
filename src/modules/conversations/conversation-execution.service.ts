import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { Message } from '../../entities/Conversations/Message';
import { Customer } from '../../entities/CRM/Customer';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { AppError, ErrorCode } from '../../common/errors';

import { MessageStatusService } from './message-status.service';
import { SendMessageDto } from './dto/send-message.dto';
import { BulkMessageDto } from './dto/bulk-message.dto';
import {
  MESSAGE_STATUS,
  MESSAGE_TYPE,
  SENDER_TYPE,
} from './conversation.constants';

/**
 * Message-send orchestration (the write path + status lifecycle seam).
 *
 * `sendMessage` runs in a TRANSACTION: it creates the message, an initial SENT
 * status log, and bumps the conversation's `last_message_at` atomically — so a
 * message never exists without its initial status, and ordering metadata stays
 * consistent. Delivery to an external channel (WhatsApp) / queue worker would
 * plug in after the SENT log (status transitions to DELIVERED/READ/FAILED are
 * recorded via MessageStatusService — webhook/queue driven; retry is upstream).
 *
 * Tenant isolation: the conversation is loaded tenant-scoped inside the
 * transaction; the message + status log are stamped with the tenant.
 */
@Injectable()
export class ConversationExecutionService {
  constructor(
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly status: MessageStatusService,
    private readonly dataSource: DataSource,
  ) {}

  async sendMessage(
    tenantId: string,
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<Message> {
    const senderType = dto.senderType ?? SENDER_TYPE.AGENT;
    const messageType = dto.messageType ?? MESSAGE_TYPE.TEXT;

    // Text/system messages must carry content; image/file carry it on the attachment.
    if (
      (messageType === MESSAGE_TYPE.TEXT ||
        messageType === MESSAGE_TYPE.SYSTEM) &&
      !dto.content?.trim()
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'content is required for text/system messages',
      });
    }

    const created = await this.dataSource.transaction(async (manager) => {
      const conversation = await manager.getRepository(Conversation).findOne({
        where: { id: conversationId, tenant: { id: tenantId } },
      });
      if (!conversation) {
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Conversation not found',
        });
      }

      const repo = manager.getRepository(Message);
      const message = await repo.save(
        repo.create({
          conversation: { id: conversationId } as Conversation,
          tenant: { id: tenantId } as Tenant,
          sender_type: senderType as Message['sender_type'],
          sender_user:
            senderType === SENDER_TYPE.AGENT
              ? ({ id: userId } as User)
              : undefined,
          content: dto.content,
          message_type: messageType,
        }),
      );

      await this.status.append(
        tenantId,
        message.id,
        MESSAGE_STATUS.SENT,
        manager,
      );

      conversation.last_message_at = new Date();
      await manager.getRepository(Conversation).save(conversation);

      return message;
    });

    return this.reload(tenantId, created.id);
  }

  /** Broadcast the same message to multiple conversations (per-conversation results). */
  async sendBulk(tenantId: string, userId: string, dto: BulkMessageDto) {
    const results: Array<{
      conversationId: string;
      success: boolean;
      messageId?: string;
      error?: string;
    }> = [];
    for (const conversationId of dto.conversationIds) {
      try {
        const msg = await this.sendMessage(tenantId, userId, conversationId, {
          content: dto.content,
          messageType: dto.messageType,
          senderType: dto.senderType,
        });
        results.push({ conversationId, success: true, messageId: msg.id });
      } catch (err) {
        results.push({
          conversationId,
          success: false,
          error: err instanceof AppError ? err.message : 'send failed',
        });
      }
    }
    const sent = results.filter((r) => r.success).length;
    return {
      requested: dto.conversationIds.length,
      sent,
      failed: results.length - sent,
      results,
    };
  }

  /** Marks a message as read (READ status log). */
  markRead(tenantId: string, messageId: string) {
    return this.status.markRead(tenantId, messageId);
  }

  /**
   * Records the provider's message id onto an ALREADY-CREATED message
   * (FND-023), once an outbound WhatsApp send completes. `sendMessage`/
   * `recordChannelMessage` persist the row BEFORE the channel send even
   * happens (so a message is never lost if the send fails), so the provider
   * id can only be attached afterward — this is what lets a LATER delivery/
   * read webhook (matched by wamid) find its way back to the right row.
   */
  async recordProviderMessageId(
    tenantId: string,
    messageId: string,
    waMessageId: string,
  ): Promise<void> {
    await this.messages.update(
      { id: messageId, tenant: { id: tenantId } },
      { wa_message_id: waMessageId },
    );
  }

  /**
   * Persist a non-interactive-send channel message (CUSTOMER inbound, BOT/AI
   * reply, SYSTEM note, or an AGENT message that arrived from OUTSIDE
   * ZiyaraTech's own send path — see `senderType` note below) into the
   * unified Conversation/Message timeline — the seam used by the AI engine
   * to MIRROR each turn so agents, inbox, search and analytics all read one
   * store. Reuses the same transactional pattern as `sendMessage` (message +
   * initial SENT status + `last_message_at` bump). For a CUSTOMER message the
   * conversation's customer is attached as the sender.
   *
   * Returns `null` (no-op) when the conversation isn't found for the tenant, so
   * an AI session with no linked Conversation simply isn't mirrored. Accepts an
   * optional `manager` to enlist in a caller's transaction.
   *
   * `senderType: 'AGENT'` is for a message ZiyaraTech did not send itself —
   * today, a WhatsApp Coexistence `smb_message_echo` (the clinic staff replied
   * from the native WhatsApp Business App, not from ZiyaraTech's UI). Unlike
   * `sendMessage`'s AGENT path, no `sender_user` is set: there is no
   * authenticated ZiyaraTech actor to attribute it to, and the column is
   * nullable precisely for this case.
   *
   * `origin` carries provider facts about an inbound channel message:
   *  - `waMessageId` — the WhatsApp `wamid`. Recording it is what makes the
   *    partial UNIQUE `messages(tenantId, wa_message_id)` actually do its job
   *    (it existed before this but nothing populated the column, so inbound
   *    de-duplication silently never happened), and it is how inbound media is
   *    later matched back to its message.
   *  - `messageType` — image/document/audio/… so the timeline can render the
   *    message as what it really was instead of labelling everything `text`.
   */
  async recordChannelMessage(
    tenantId: string,
    conversationId: string,
    senderType: Extract<
      Message['sender_type'],
      'CUSTOMER' | 'BOT' | 'SYSTEM' | 'AGENT'
    >,
    content: string,
    manager?: EntityManager,
    origin?: { waMessageId?: string; messageType?: string },
  ): Promise<Message | null> {
    const exec = async (m: EntityManager): Promise<Message | null> => {
      const convRepo = m.getRepository(Conversation);
      const conversation = await convRepo.findOne({
        where: { id: conversationId, tenant: { id: tenantId } },
        relations: { customer: true },
      });
      if (!conversation) return null;

      const repo = m.getRepository(Message);
      const message = await repo.save(
        repo.create({
          conversation: { id: conversationId } as Conversation,
          tenant: { id: tenantId } as Tenant,
          sender_type: senderType,
          sender_customer:
            senderType === SENDER_TYPE.CUSTOMER && conversation.customer
              ? ({ id: conversation.customer.id } as Customer)
              : undefined,
          content,
          message_type: origin?.messageType ?? MESSAGE_TYPE.TEXT,
          wa_message_id: origin?.waMessageId,
        }),
      );

      await this.status.append(tenantId, message.id, MESSAGE_STATUS.SENT, m);
      conversation.last_message_at = new Date();
      await convRepo.save(conversation);
      return message;
    };

    return manager ? exec(manager) : this.dataSource.transaction(exec);
  }

  /**
   * Find-or-create the unified timeline Conversation for a WhatsApp customer.
   *
   * The AI-only path (`AiConversation`) lazily creates a linked Conversation
   * only at handover (see `HandoverRequestService.create`) — a coexistence
   * echo has no `aiConversationId` to key off at all (it arrives from a
   * business-app-initiated send, not an AI turn), so it resolves/creates the
   * timeline Conversation directly from (tenant, customer). Reuses whichever
   * conversation already exists for this customer (most recent) rather than
   * creating a second one, so an echo lands in the same inbox thread the
   * patient's own messages do once a handover happens to create one.
   */
  async findOrCreateForWhatsapp(
    tenantId: string,
    customerId: string,
    whatsappAccountId: string,
  ): Promise<Conversation> {
    const existing = await this.conversations.findOne({
      where: { tenant: { id: tenantId }, customer: { id: customerId } },
      order: { created_at: 'DESC' },
    });
    if (existing) return existing;

    return this.conversations.save(
      this.conversations.create({
        tenant: { id: tenantId } as Tenant,
        customer: { id: customerId } as Customer,
        whatsapp_account: { id: whatsappAccountId } as WhatsappAccount,
        type: 'whatsapp',
      }),
    );
  }

  private async reload(tenantId: string, id: string): Promise<Message> {
    const message = await this.messages.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { conversation: true, sender_user: true },
    });
    if (!message) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Message not found' });
    }
    return message;
  }
}
