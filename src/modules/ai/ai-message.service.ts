import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * AI conversation messages (history).
 *
 * Schema note: `ai_messages.ai_conversation_id` is a plain column (not a
 * relation), so it is queried by value. Tenant isolation: every query filters
 * `tenant: { id: tenantId }` AND the parent AI conversation is verified to
 * belong to the tenant.
 */
@Injectable()
export class AiMessageService {
  constructor(
    @InjectRepository(AiMessage) private readonly messages: Repository<AiMessage>,
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
  ) {}

  /** Paginated, chronological history for an AI conversation. */
  async history(
    tenantId: string,
    aiConversationId: string,
    page = 1,
    limit = 50,
  ) {
    await this.assertConversation(tenantId, aiConversationId);
    const [data, total] = await this.messages.findAndCount({
      where: { tenant: { id: tenantId }, ai_conversation_id: aiConversationId },
      order: { created_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  private async assertConversation(tenantId: string, aiConversationId: string): Promise<void> {
    if (!(await this.aiConversations.exists({ where: { id: aiConversationId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI conversation not found' });
    }
  }
}
