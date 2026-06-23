import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { Message } from '../../entities/Conversations/Message';
import { Customer } from '../../entities/CRM/Customer';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
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
      (messageType === MESSAGE_TYPE.TEXT || messageType === MESSAGE_TYPE.SYSTEM) &&
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
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Conversation not found' });
      }

      const repo = manager.getRepository(Message);
      const message = await repo.save(
        repo.create({
          conversation: { id: conversationId } as Conversation,
          tenant: { id: tenantId } as Tenant,
          sender_type: senderType as Message['sender_type'],
          sender_user:
            senderType === SENDER_TYPE.AGENT ? ({ id: userId } as User) : undefined,
          content: dto.content,
          message_type: messageType,
        }),
      );

      await this.status.append(tenantId, message.id, MESSAGE_STATUS.SENT, manager);

      conversation.last_message_at = new Date();
      await manager.getRepository(Conversation).save(conversation);

      return message;
    });

    return this.reload(tenantId, created.id);
  }

  /** Broadcast the same message to multiple conversations (per-conversation results). */
  async sendBulk(tenantId: string, userId: string, dto: BulkMessageDto) {
    const results: Array<{ conversationId: string; success: boolean; messageId?: string; error?: string }> = [];
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
    return { requested: dto.conversationIds.length, sent, failed: results.length - sent, results };
  }

  /** Marks a message as read (READ status log). */
  markRead(tenantId: string, messageId: string) {
    return this.status.markRead(tenantId, messageId);
  }

  /**
   * Persist a non-agent channel message (CUSTOMER inbound, BOT/AI reply, or
   * SYSTEM note) into the unified Conversation/Message timeline — the seam used
   * by the AI engine to MIRROR each turn so agents, inbox, search and analytics
   * all read one store. Reuses the same transactional pattern as `sendMessage`
   * (message + initial SENT status + `last_message_at` bump). For a CUSTOMER
   * message the conversation's customer is attached as the sender.
   *
   * Returns `null` (no-op) when the conversation isn't found for the tenant, so
   * an AI session with no linked Conversation simply isn't mirrored. Accepts an
   * optional `manager` to enlist in a caller's transaction.
   */
  async recordChannelMessage(
    tenantId: string,
    conversationId: string,
    senderType: Extract<Message['sender_type'], 'CUSTOMER' | 'BOT' | 'SYSTEM'>,
    content: string,
    manager?: EntityManager,
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
          message_type: MESSAGE_TYPE.TEXT,
        }),
      );

      await this.status.append(tenantId, message.id, MESSAGE_STATUS.SENT, m);
      conversation.last_message_at = new Date();
      await convRepo.save(conversation);
      return message;
    };

    return manager ? exec(manager) : this.dataSource.transaction(exec);
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
