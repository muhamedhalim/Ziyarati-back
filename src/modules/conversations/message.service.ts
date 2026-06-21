import { Injectable } from '@nestjs/common';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import { Message } from '../../entities/Conversations/Message';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AppError, ErrorCode } from '../../common/errors';
import { MessageFilterDto } from './dto/message-filter.dto';
import { UpdateMessageDto } from './dto/update-message.dto';
import { SENDER_TYPE } from './conversation.constants';

/**
 * Message reads + edit + delete.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }` and verifies
 * the parent conversation belongs to the tenant. Ordering within a conversation
 * is guaranteed by `created_at ASC` (then id) — backed by the
 * `(conversation, created_at)` index.
 *
 * Schema note: `messages` has no `deleted_at` → delete is HARD (CASCADE removes
 * attachments + status logs); no `edited_at` → edits update content in place.
 */
@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
  ) {}

  async list(tenantId: string, conversationId: string, filter: MessageFilterDto) {
    await this.assertConversation(tenantId, conversationId);

    const where: FindOptionsWhere<Message> = {
      tenant: { id: tenantId },
      conversation: { id: conversationId },
    };
    if (filter.senderType) where.sender_type = filter.senderType as Message['sender_type'];
    if (filter.messageType) where.message_type = filter.messageType;
    if (filter.from && filter.to) {
      where.created_at = Between(new Date(filter.from), new Date(filter.to));
    } else if (filter.from) {
      where.created_at = MoreThanOrEqual(new Date(filter.from));
    } else if (filter.to) {
      where.created_at = LessThan(new Date(filter.to));
    }

    const [data, total] = await this.messages.findAndCount({
      where,
      relations: { sender_user: true, sender_customer: true },
      order: { created_at: 'ASC', id: 'ASC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<Message> {
    const message = await this.messages.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { conversation: true, sender_user: true, sender_customer: true },
    });
    if (!message) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Message not found' });
    }
    return message;
  }

  async edit(tenantId: string, id: string, dto: UpdateMessageDto): Promise<Message> {
    const message = await this.findOne(tenantId, id);
    // Integrity: only an agent's OWN outbound messages may be edited. The record
    // of what a CUSTOMER, the BOT, or the SYSTEM said is immutable — an agent must
    // never be able to rewrite the other party's words.
    this.assertAgentAuthored(message, 'edited');
    message.content = dto.content;
    await this.messages.save(message);
    return this.findOne(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const message = await this.findOne(tenantId, id);
    // Same integrity rule as edit: CUSTOMER/BOT/SYSTEM messages cannot be deleted
    // through the agent API (would erase the other party's record).
    this.assertAgentAuthored(message, 'deleted');
    await this.messages.delete({ id: message.id });
  }

  /** Guards that the message is agent-authored before a mutating operation. */
  private assertAgentAuthored(message: Message, verb: string): void {
    if (message.sender_type !== SENDER_TYPE.AGENT) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Only AGENT messages can be ${verb}; a ${message.sender_type} message is immutable`,
      });
    }
  }

  private async assertConversation(tenantId: string, conversationId: string): Promise<void> {
    if (!(await this.conversations.exists({ where: { id: conversationId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Conversation not found' });
    }
  }
}
