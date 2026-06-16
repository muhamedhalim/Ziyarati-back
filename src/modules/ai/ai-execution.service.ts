import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { AiUsageLog } from '../../entities/AI Agent/AiUsageLog';
import { AiCostLog } from '../../entities/AI Agent/AiCostLog';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AiRagService } from './ai-rag.service';
import { AiProviderFactory } from './providers/ai-provider.factory';
import { AiChatMessage } from './providers/ai-provider.interface';
import { SendMessageDto } from './dto/send-message.dto';
import {
  AI_CONVERSATION_STATUS,
  AI_MESSAGE_ROLE,
  currentPeriodMonth,
  priceFor,
} from './ai.constants';

/**
 * RAG execution pipeline — the single orchestration point for AI message turns.
 *
 * Flow (transactional): persist user message → retrieve KB context (RAG) →
 * assemble prompt (system + context + history + user) → call the provider
 * abstraction → persist assistant message → record usage (AiUsageLog) + cost
 * (AiCostLog). No real LLM is implemented; the no-op provider yields a fallback
 * answer with zero tokens.
 *
 * Tenant isolation: the AI conversation is loaded tenant-scoped; messages, usage
 * and cost rows are all stamped with the tenant; RAG retrieval is tenant+agent
 * scoped.
 */
@Injectable()
export class AiExecutionService {
  private readonly logger = new Logger('AiExecutionService');

  constructor(
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
    @InjectRepository(AiMessage) private readonly messages: Repository<AiMessage>,
    private readonly rag: AiRagService,
    private readonly providers: AiProviderFactory,
    private readonly dataSource: DataSource,
  ) {}

  async sendMessage(tenantId: string, aiConversationId: string, dto: SendMessageDto) {
    const aiConv = await this.aiConversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
      relations: { agent: true },
    });
    if (!aiConv) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI conversation not found' });
    }
    if (aiConv.status !== AI_CONVERSATION_STATUS.ACTIVE) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Cannot send to a conversation in status "${aiConv.status}"`,
      });
    }
    const agent: AiAgent | undefined = aiConv.agent;

    // RAG retrieval (outside the tx — read-only, possibly slow).
    const chunks = agent
      ? await this.rag.retrieve(tenantId, agent.id, dto.content)
      : [];
    const context = this.rag.assembleContext(chunks);

    const result = await this.dataSource.transaction(async (manager) => {
      const msgRepo = manager.getRepository(AiMessage);

      // 1) persist the user message
      await msgRepo.save(
        msgRepo.create({
          ai_conversation_id: aiConversationId,
          tenant: { id: tenantId } as Tenant,
          role: AI_MESSAGE_ROLE.USER,
          content: dto.content,
          tokens_used: 0,
        }),
      );

      // 2) load recent history (the LATEST 20, then restore chronological order).
      // NOTE: must order DESC+take to get the most recent turns; ordering ASC
      // would return the OLDEST 20 and drop recent context in long chats.
      const recent = await msgRepo.find({
        where: { ai_conversation_id: aiConversationId, tenant: { id: tenantId } },
        order: { created_at: 'DESC' },
        take: 20,
      });
      const history = recent.reverse();

      // 3) assemble the prompt
      const messages: AiChatMessage[] = [];
      if (agent?.system_prompt) messages.push({ role: 'system', content: agent.system_prompt });
      if (context) messages.push({ role: 'system', content: `Relevant knowledge:\n${context}` });
      for (const m of history) messages.push({ role: this.mapRole(m.role), content: m.content });

      // 4) provider completion (abstraction; no-op fallback by default)
      const provider = this.providers.resolve(agent?.model);
      const completion = await provider.complete({
        tenantId,
        model: agent?.model,
        temperature: agent ? Number(agent.temperature) : undefined,
        messages,
      });

      // 5) persist the assistant message
      const assistant = await msgRepo.save(
        msgRepo.create({
          ai_conversation_id: aiConversationId,
          tenant: { id: tenantId } as Tenant,
          role: AI_MESSAGE_ROLE.ASSISTANT,
          content: completion.content,
          tokens_used: completion.completionTokens,
        }),
      );

      // 6) usage + cost
      const totalTokens = completion.promptTokens + completion.completionTokens;
      if (agent) await this.recordUsage(manager, tenantId, agent.id, totalTokens);
      await this.recordCost(manager, tenantId, completion.promptTokens, completion.completionTokens, completion.model);

      return { assistant, completion, totalTokens };
    });

    return {
      message: result.assistant,
      retrievedChunks: chunks.length,
      usage: {
        promptTokens: result.completion.promptTokens,
        completionTokens: result.completion.completionTokens,
        totalTokens: result.totalTokens,
      },
      fallback: result.completion.fallback ?? false,
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private mapRole(role: string): 'system' | 'user' | 'assistant' {
    if (role === AI_MESSAGE_ROLE.ASSISTANT) return 'assistant';
    if (role === AI_MESSAGE_ROLE.SYSTEM) return 'system';
    return 'user';
  }

  /** Find-or-create + increment the monthly usage row for (tenant, agent). */
  private async recordUsage(
    manager: EntityManager,
    tenantId: string,
    agentId: string,
    tokens: number,
  ): Promise<void> {
    const repo = manager.getRepository(AiUsageLog);
    const period_month = currentPeriodMonth();
    const existing = await repo.findOne({
      where: { tenant: { id: tenantId }, agent: { id: agentId }, period_month },
    });
    if (existing) {
      existing.total_tokens += tokens;
      existing.total_requests += 1;
      await repo.save(existing);
    } else {
      await repo.save(
        repo.create({
          tenant: { id: tenantId } as Tenant,
          agent: { id: agentId } as AiAgent,
          period_month,
          total_tokens: tokens,
          total_requests: 1,
        }),
      );
    }
  }

  /** Find-or-create + increment the monthly cost row (tenant-level). */
  private async recordCost(
    manager: EntityManager,
    tenantId: string,
    inputTokens: number,
    outputTokens: number,
    model: string,
  ): Promise<void> {
    const repo = manager.getRepository(AiCostLog);
    const period_month = currentPeriodMonth();
    const price = priceFor(model);
    const cost = (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;

    const existing = await repo.findOne({
      where: { tenant: { id: tenantId }, period_month },
    });
    if (existing) {
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.total_cost_usd = +(Number(existing.total_cost_usd) + cost).toFixed(6);
      await repo.save(existing);
    } else {
      await repo.save(
        repo.create({
          tenant: { id: tenantId } as Tenant,
          period_month,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_cost_usd: +cost.toFixed(6),
        }),
      );
    }
  }
}
