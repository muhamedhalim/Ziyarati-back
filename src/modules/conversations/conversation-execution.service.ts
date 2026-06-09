import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { Message } from '../../entities/Conversations/Message';
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
