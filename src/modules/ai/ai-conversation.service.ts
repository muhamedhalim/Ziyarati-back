import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Conversation } from '../../entities/Conversations/Conversation';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateConversationDto } from './dto/create-conversation.dto';
import { ConversationFilterDto } from './dto/conversation-filter.dto';
import { AI_CONVERSATION_STATUS } from './ai.constants';

/**
 * AI conversation sessions. May link to a messaging `Conversation` (shared
 * thread) and an agent.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; agent and
 * linked conversation are validated against the tenant.
 */
@Injectable()
export class AiConversationService {
  constructor(
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
  ) {}

  async start(tenantId: string, dto: CreateConversationDto): Promise<AiConversation> {
    if (dto.agentId) await this.assertAgent(tenantId, dto.agentId);
    if (dto.conversationId) await this.assertConversation(tenantId, dto.conversationId);
    const aiConv = this.aiConversations.create({
      tenant: { id: tenantId } as Tenant,
      agent: dto.agentId ? ({ id: dto.agentId } as AiAgent) : undefined,
      conversation: dto.conversationId ? ({ id: dto.conversationId } as Conversation) : undefined,
      status: AI_CONVERSATION_STATUS.ACTIVE,
    });
    const saved = await this.aiConversations.save(aiConv);
    return this.findOne(tenantId, saved.id);
  }

  async findAll(tenantId: string, filter: ConversationFilterDto) {
    const where: FindOptionsWhere<AiConversation> = { tenant: { id: tenantId } };
    if (filter.status) where.status = filter.status;
    if (filter.agentId) where.agent = { id: filter.agentId };

    const [data, total] = await this.aiConversations.findAndCount({
      where,
      relations: { agent: true, conversation: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<AiConversation> {
    const aiConv = await this.aiConversations.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { agent: true, conversation: true },
    });
    if (!aiConv) throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI conversation not found' });
    return aiConv;
  }

  async close(tenantId: string, id: string): Promise<AiConversation> {
    return this.setStatus(tenantId, id, AI_CONVERSATION_STATUS.COMPLETED);
  }

  async archive(tenantId: string, id: string): Promise<AiConversation> {
    return this.setStatus(tenantId, id, AI_CONVERSATION_STATUS.ARCHIVED);
  }

  /**
   * Binds an AI session to its unified-timeline Conversation — only if it has
   * none yet. A WhatsApp session started before the inbound bridge stored
   * messages on the timeline has no linked thread, so its turns were never
   * mirrored and an agent could not see them; the bridge calls this the first
   * time it knows the thread.
   *
   * The `"conversationId" IS NULL` guard makes it a compare-and-set: it never
   * re-points a session that is already linked (e.g. to a handover thread), and
   * two concurrent callers cannot both win. The target conversation is
   * validated against the tenant. Returns whether this call linked it.
   */
  async linkTimelineConversation(
    tenantId: string,
    id: string,
    conversationId: string,
  ): Promise<boolean> {
    await this.assertConversation(tenantId, conversationId);
    const res = await this.aiConversations
      .createQueryBuilder()
      .update(AiConversation)
      .set({ conversation: { id: conversationId } as Conversation })
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('"conversationId" IS NULL')
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /** Sets the conversation status (used by the handover flow → HANDED_OVER). */
  async setStatus(tenantId: string, id: string, status: string): Promise<AiConversation> {
    const aiConv = await this.findOne(tenantId, id);
    aiConv.status = status;
    await this.aiConversations.save(aiConv);
    return this.findOne(tenantId, id);
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    if (!(await this.agents.exists({ where: { id: agentId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI agent not found in this tenant' });
    }
  }

  private async assertConversation(tenantId: string, conversationId: string): Promise<void> {
    if (!(await this.conversations.exists({ where: { id: conversationId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Conversation not found in this tenant' });
    }
  }
}
