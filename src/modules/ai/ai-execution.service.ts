import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AiRagService } from './ai-rag.service';
import { AiProviderFactory } from './providers/ai-provider.factory';
import { AiChatMessage } from './providers/ai-provider.interface';
import { SendMessageDto } from './dto/send-message.dto';
import { UsageService } from '../subscription-billing/usage.service';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AiToolDispatchService } from './tools/ai-tool-dispatch.service';
import { AI_TOOLS } from './tools/ai-tools.constants';
import {
  AI_CONVERSATION_STATUS,
  AI_MESSAGE_ROLE,
  currentPeriodMonth,
  priceFor,
} from './ai.constants';

/** Bounds the tool-calling loop so a misbehaving model can't spin indefinitely. */
const MAX_TOOL_ITERATIONS = 4;

/**
 * AI turn orchestrator: persist user message → retrieve KB context (RAG) →
 * assemble prompt → run the provider with the booking TOOLSET, executing any
 * tool calls through AiToolDispatchService (which reuses the Appointment/
 * Scheduling services) → persist the final assistant message → meter usage/cost.
 *
 * The model can now perform real business actions (check availability, book,
 * reschedule, cancel) — but only by emitting tool calls that the dispatcher
 * validates and executes; the model never writes to the DB directly. The no-op
 * provider emits no tool calls, so without OpenAI configured this degrades to a
 * plain Q&A answer.
 *
 * The OpenAI/tool round-trips are NOT wrapped in a DB transaction (a connection
 * must not be held across network + booking calls); only the final assistant
 * write + usage/cost metering run together in a short transaction.
 *
 * Tenant isolation: the AI conversation is loaded tenant-scoped; messages, usage
 * and cost rows are stamped with the tenant; tool execution is tenant-bound from
 * context (never from model arguments).
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
    private readonly usage: UsageService,
    private readonly dispatch: AiToolDispatchService,
    private readonly ctx: TenantContextService,
  ) {}

  async sendMessage(tenantId: string, aiConversationId: string, dto: SendMessageDto) {
    const aiConv = await this.aiConversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
      relations: { agent: true, conversation: true },
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

    // Quota pre-check (blocks a tenant already over its monthly token cap).
    await this.usage.assertWithinLimit(tenantId, USAGE_METRIC.AI_TOKENS, 1);

    // 1) persist the user message (own write — not held across the LLM round-trips).
    await this.messages.save(
      this.messages.create({
        ai_conversation_id: aiConversationId,
        tenant: { id: tenantId } as Tenant,
        role: AI_MESSAGE_ROLE.USER,
        content: dto.content,
        tokens_used: 0,
      }),
    );

    // 2) RAG retrieval (read-only).
    const chunks = agent ? await this.rag.retrieve(tenantId, agent.id, dto.content) : [];
    const context = this.rag.assembleContext(chunks);

    // 3) assemble the prompt from the latest-20 history (DESC+take then reverse).
    const recent = await this.messages.find({
      where: { ai_conversation_id: aiConversationId, tenant: { id: tenantId } },
      order: { created_at: 'DESC' },
      take: 20,
    });
    const messages: AiChatMessage[] = [];
    if (agent?.system_prompt) messages.push({ role: 'system', content: agent.system_prompt });
    if (context) messages.push({ role: 'system', content: `Relevant knowledge:\n${context}` });
    for (const m of recent.reverse()) messages.push({ role: this.mapRole(m.role), content: m.content });

    // 4) tool-calling loop: complete → execute tool calls → feed results → repeat
    //    until the model returns a plain answer (or the iteration cap is hit).
    const provider = this.providers.resolve(agent?.model);
    const toolCtx = {
      tenantId,
      actorUserId: this.ctx.getUser()?.id,
      aiConversationId,
      conversationId: aiConv.conversation?.id,
    };

    let promptTokens = 0;
    let completionTokens = 0;
    let lastModel = agent?.model ?? 'noop';
    let fallback = false;
    let finalContent = '';

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
      const completion = await provider.complete({
        tenantId,
        model: agent?.model,
        temperature: agent ? Number(agent.temperature) : undefined,
        messages,
        tools: AI_TOOLS,
      });
      promptTokens += completion.promptTokens;
      completionTokens += completion.completionTokens;
      lastModel = completion.model;
      fallback = completion.fallback ?? fallback;

      const calls = completion.toolCalls ?? [];
      if (calls.length === 0) {
        finalContent = completion.content;
        break;
      }

      // Record the assistant's tool-call turn, execute each call, feed results back.
      messages.push({ role: 'assistant', content: completion.content || null, tool_calls: calls });
      for (const call of calls) {
        const result = await this.dispatch.execute(toolCtx, call);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result),
        });
      }
      if (i === MAX_TOOL_ITERATIONS - 1) {
        finalContent = completion.content || 'I have processed your request.';
      }
    }

    // 5) persist the assistant message + meter usage/cost in one short transaction.
    const totalTokens = promptTokens + completionTokens;
    const assistant = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(AiMessage).save(
        manager.getRepository(AiMessage).create({
          ai_conversation_id: aiConversationId,
          tenant: { id: tenantId } as Tenant,
          role: AI_MESSAGE_ROLE.ASSISTANT,
          content: finalContent,
          tokens_used: completionTokens,
        }),
      );
      if (agent) await this.recordUsage(manager, tenantId, agent.id, totalTokens);
      await this.recordCost(manager, tenantId, promptTokens, completionTokens, lastModel);
      return saved;
    });

    await this.usage.increment(tenantId, USAGE_METRIC.AI_TOKENS, totalTokens);

    return {
      message: assistant,
      retrievedChunks: chunks.length,
      usage: { promptTokens, completionTokens, totalTokens },
      fallback,
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private mapRole(role: string): 'system' | 'user' | 'assistant' {
    if (role === AI_MESSAGE_ROLE.ASSISTANT) return 'assistant';
    if (role === AI_MESSAGE_ROLE.SYSTEM) return 'system';
    return 'user';
  }

  /**
   * Atomically increment the monthly usage row for (tenant, agent).
   *
   * Was find-then-save, which lost updates under concurrent turns (two turns read
   * the same row → last write wins → tokens undercounted) or hit 23505. A single
   * `INSERT … ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x` against the existing
   * UNIQUE(tenantId, agentId, period_month) is race-safe — the running total can
   * never be lost. Runs inside the caller's transaction.
   */
  private async recordUsage(
    manager: EntityManager,
    tenantId: string,
    agentId: string,
    tokens: number,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO ai_usage_logs ("tenantId", "agentId", period_month, total_tokens, total_requests)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT ("tenantId", "agentId", period_month)
       DO UPDATE SET total_tokens   = ai_usage_logs.total_tokens   + EXCLUDED.total_tokens,
                     total_requests = ai_usage_logs.total_requests + 1`,
      [tenantId, agentId, currentPeriodMonth(), tokens],
    );
  }

  /**
   * Atomically increment the monthly cost row (tenant-level). Same race-safety
   * rationale as recordUsage; conflict target is UNIQUE(tenantId, period_month).
   */
  private async recordCost(
    manager: EntityManager,
    tenantId: string,
    inputTokens: number,
    outputTokens: number,
    model: string,
  ): Promise<void> {
    const price = priceFor(model);
    const cost = +(
      (inputTokens / 1000) * price.input +
      (outputTokens / 1000) * price.output
    ).toFixed(6);

    await manager.query(
      `INSERT INTO ai_cost_logs ("tenantId", period_month, input_tokens, output_tokens, total_cost_usd)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("tenantId", period_month)
       DO UPDATE SET input_tokens   = ai_cost_logs.input_tokens   + EXCLUDED.input_tokens,
                     output_tokens  = ai_cost_logs.output_tokens  + EXCLUDED.output_tokens,
                     total_cost_usd = ai_cost_logs.total_cost_usd + EXCLUDED.total_cost_usd`,
      [tenantId, currentPeriodMonth(), inputTokens, outputTokens, cost],
    );
  }
}
