import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { ConversationParticipant } from '../../entities/Conversations/ConversationParticipant';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';

import { AddParticipantDto } from './dto/add-participant.dto';

/**
 * Conversation participants (staff users).
 *
 * Tenant isolation: `conversation_participants` has NO tenant column, so
 * isolation flows THROUGH the conversation — every operation first verifies the
 * conversation belongs to the caller's tenant, then operates on its participants.
 *
 * Schema note: the table has only `conversation`, `user`, `joined_at` — there is
 * NO role/status/left_at column. Participant role is therefore DERIVED from the
 * user's RBAC role; "leave" is row removal (no left_at is persisted).
 */
@Injectable()
export class ConversationParticipantService {
  constructor(
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** Adds a user participant (idempotent via the unique (conversation, user) constraint). */
  async add(tenantId: string, conversationId: string, dto: AddParticipantDto): Promise<ConversationParticipant> {
    await this.assertConversation(tenantId, conversationId);
    if (!(await this.users.exists({ where: { id: dto.userId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'User not found in this tenant' });
    }

    const existing = await this.participants.findOne({
      where: { conversation: { id: conversationId }, user: { id: dto.userId } },
    });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, { message: 'User is already a participant' });
    }

    const participant = this.participants.create({
      conversation: { id: conversationId } as Conversation,
      user: { id: dto.userId } as User,
    });
    return this.participants.save(participant);
  }

  async list(tenantId: string, conversationId: string): Promise<ConversationParticipant[]> {
    await this.assertConversation(tenantId, conversationId);
    return this.participants.find({
      where: { conversation: { id: conversationId } },
      relations: { user: true },
      order: { joined_at: 'ASC' },
    });
  }

  /** Removes a participant ("leave" — no left_at column exists, so the row is deleted). */
  async remove(tenantId: string, conversationId: string, participantId: string): Promise<void> {
    await this.assertConversation(tenantId, conversationId);
    const participant = await this.participants.findOne({
      where: { id: participantId, conversation: { id: conversationId } },
    });
    if (!participant) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Participant not found' });
    }
    await this.participants.remove(participant);
  }

  /**
   * Participant role/status update is NOT supported by the finalized schema
   * (`conversation_participants` has no role/status column). This method makes
   * the limitation explicit rather than silently no-op'ing.
   */
  async update(tenantId: string, conversationId: string, participantId: string): Promise<never> {
    await this.assertConversation(tenantId, conversationId);
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message:
        'Participant role/status is not stored by the current schema. A participant\'s role is derived from the user\'s RBAC role; changing it is out of scope for this module.',
    });
  }

  private async assertConversation(tenantId: string, conversationId: string): Promise<void> {
    if (!(await this.conversations.exists({ where: { id: conversationId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Conversation not found' });
    }
  }
}
