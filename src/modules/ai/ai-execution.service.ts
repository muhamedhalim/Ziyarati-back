import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { AiToolDispatchService, ToolContext } from './tools/ai-tool-dispatch.service';
import { AI_TOOLS } from './tools/ai-tools.constants';
import { AI_ADMIN_TOOLS } from './tools/ai-admin-tools.constants';
import { AiMetricsService } from './ai-metrics.service';
import { AiToolCall, AiToolDefinition } from './providers/ai-provider.interface';
import {
  AI_CONVERSATION_STATUS,
  AI_MESSAGE_ROLE,
  currentPeriodMonth,
  priceFor,
} from './ai.constants';
import { HandoverCustomerRepliedEvent } from '../../events/handover.events';

/** Bounds the tool-calling loop so a misbehaving model can't spin indefinitely. */
const MAX_TOOL_ITERATIONS = 4;

/** Every tool exposed to the model — booking/discovery (always) + read-only
 *  admin tools (permission-checked per call inside AiToolDispatchService). */
const ALL_TOOLS: AiToolDefinition[] = [...AI_TOOLS, ...AI_ADMIN_TOOLS];

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
    private readonly timeline: ConversationExecutionService,
    private readonly metrics: AiMetricsService,
    private readonly emitter: EventEmitter2,
  ) {}

  async sendMessage(tenantId: string, aiConversationId: string, dto: SendMessageDto) {
    const turnStart = Date.now();
    let channel = 'API';
    let modelForMetric = 'noop';
    try {
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
      channel = aiConv.channel ?? 'API';
      const agent: AiAgent | undefined = aiConv.agent;
      // When the AI session is linked to a messaging Conversation, every turn is
      // mirrored into the unified Message timeline (see mirrorToTimeline).
      const linkedConversationId = aiConv.conversation?.id;

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
      // Mirror the inbound customer turn into the unified timeline (real timestamp
      // now, BEFORE the LLM call, so it sorts ahead of the bot reply).
      if (linkedConversationId) {
        await this.mirrorToTimeline(tenantId, linkedConversationId, 'CUSTOMER', dto.content);
      }

      // 2) RAG retrieval (read-only) — timed for Advanced AI Monitoring.
      const ragStart = Date.now();
      const embedTiming: { embeddingMs?: number } = {};
      const chunks = agent ? await this.rag.retrieve(tenantId, agent.id, dto.content, undefined, embedTiming) : [];
      const ragRetrievalMs = Date.now() - ragStart;
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
      const toolCtx: ToolContext = {
        tenantId,
        actorUserId: this.ctx.getUser()?.id,
        permissions: this.ctx.getUser()?.permissions ?? [],
        customerId: this.sessionCustomerId(aiConv.session),
        aiConversationId,
        conversationId: aiConv.conversation?.id,
      };

      let promptTokens = 0;
      let completionTokens = 0;
      let lastModel = agent?.model ?? 'noop';
      let fallback = false;
      let finalContent = '';
      let toolCallsCount = 0;
      let toolSuccessCount = 0;
      let toolFailureCount = 0;
      let toolExecMs = 0;
      let lastTool: { name: string; result: Record<string, unknown> } | undefined;

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
        const completion = await provider.complete({
          tenantId,
          model: agent?.model,
          temperature: agent ? Number(agent.temperature) : undefined,
          messages,
          tools: ALL_TOOLS,
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
          const [result, ms] = await this.timedToolCall(toolCtx, call);
          toolCallsCount += 1;
          toolExecMs += ms;
          if (result.success === false) toolFailureCount += 1;
          else toolSuccessCount += 1;
          lastTool = { name: call.name, result };
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
      modelForMetric = lastModel;

      // 5) persist the assistant message + meter usage/cost in one short transaction.
      const totalTokens = promptTokens + completionTokens;
      const costUsd = this.computeCost(promptTokens, completionTokens, lastModel);
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
        await this.recordCost(manager, tenantId, costUsd, promptTokens, completionTokens);
        return saved;
      });

      await this.usage.increment(tenantId, USAGE_METRIC.AI_TOKENS, totalTokens);

      // Mirror the bot reply into the unified timeline (after the assistant row is
      // committed, so its timestamp follows the customer turn).
      if (linkedConversationId && finalContent) {
        await this.mirrorToTimeline(tenantId, linkedConversationId, 'BOT', finalContent);
      }

      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: lastModel,
        streamed: false,
        fallback,
        success: true,
        promptTokens,
        completionTokens,
        costUsd,
        ragRetrievalMs,
        embeddingMs: embedTiming.embeddingMs,
        toolCallsCount,
        toolSuccessCount,
        toolFailureCount,
        toolExecMs,
        totalLatencyMs: Date.now() - turnStart,
      });

      return {
        message: assistant,
        retrievedChunks: chunks.length,
        usage: { promptTokens, completionTokens, totalTokens },
        fallback,
        lastTool,
      };
    } catch (err) {
      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: modelForMetric,
        streamed: false,
        fallback: false,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        toolCallsCount: 0,
        toolSuccessCount: 0,
        toolFailureCount: 0,
        toolExecMs: 0,
        totalLatencyMs: Date.now() - turnStart,
      });
      throw err;
    }
  }

  /**
   * Live Agent Handover: persist an inbound customer message WITHOUT calling the
   * model. Used by `AiOrchestratorService` when a conversation is HANDED_OVER —
   * the customer's message must still land in the AI's own history (so nothing
   * is lost when the conversation is returned to AI) and in the unified
   * Conversation/Message timeline (so the assigned agent sees it), but the AI
   * must not answer. Reuses the exact same persistence + mirror helpers as a
   * normal turn — no parallel storage path.
   */
  async recordInboundWhileHandedOver(
    tenantId: string,
    aiConversationId: string,
    content: string,
  ): Promise<{ handedOver: true }> {
    const aiConv = await this.aiConversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
      relations: { conversation: { assigned_to: true } },
    });
    if (!aiConv) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI conversation not found' });
    }

    await this.messages.save(
      this.messages.create({
        ai_conversation_id: aiConversationId,
        tenant: { id: tenantId } as Tenant,
        role: AI_MESSAGE_ROLE.USER,
        content,
        tokens_used: 0,
      }),
    );

    const linkedConversationId = aiConv.conversation?.id;
    if (linkedConversationId) {
      await this.mirrorToTimeline(tenantId, linkedConversationId, 'CUSTOMER', content);
      // Requirement #10 (notifications): let the assigned agent's channels
      // (WhatsApp/SMS/email, per their NotificationRule) know the customer
      // replied — the realtime WS push only reaches an already-online agent.
      this.emitter.emit(
        HandoverCustomerRepliedEvent.eventName,
        new HandoverCustomerRepliedEvent(
          tenantId,
          linkedConversationId,
          aiConversationId,
          aiConv.conversation?.assigned_to?.id,
        ),
      );
    }

    return { handedOver: true };
  }

  /** Times a single tool-dispatch call for Advanced AI Monitoring. */
  private async timedToolCall(
    toolCtx: ToolContext,
    call: AiToolCall,
  ): Promise<[Record<string, unknown>, number]> {
    const start = Date.now();
    const result = await this.dispatch.execute(toolCtx, call);
    return [result, Date.now() - start];
  }

  /**
   * The customer this conversation is bound to, when known server-side (e.g.
   * a WhatsApp contact linked via `sessionPatch.context.customerId` — see
   * `WhatsappInboundAiService`). Never trusted from the model; only ever read
   * from the persisted `AiConversation.session` jsonb column.
   */
  private sessionCustomerId(session: Record<string, unknown> | undefined): string | undefined {
    const context = session?.context as Record<string, unknown> | undefined;
    const customerId = context?.customerId;
    return typeof customerId === 'string' && customerId.trim() ? customerId : undefined;
  }

  /**
   * Streaming variant of a turn (Feature 2). Reuses the SAME RAG retrieval,
   * prompt assembly and — crucially — the SAME persistence + usage/cost metering
   * + timeline mirroring helpers as `sendMessage` (this method lives in the same
   * class), so no business logic is duplicated.
   *
   * Also runs the SAME tool-calling loop as `sendMessage` (discovery/booking +
   * the Dashboard Assistant's admin tools) — a streaming-capable provider
   * reassembles tool_call deltas onto the terminal chunk (see
   * `OpenAiChatProvider.stream()`), so a turn that needs a tool still streams
   * any surrounding text and then the final answer once tools resolve. A
   * provider with no `stream()` (the Noop fallback) falls back to the
   * `complete()`-based loop, emitting the whole answer as one `onToken` call.
   */
  async streamMessage(
    tenantId: string,
    aiConversationId: string,
    dto: SendMessageDto,
    onToken: (delta: string) => void,
  ) {
    const turnStart = Date.now();
    let channel = 'API';
    let modelForMetric = 'noop';
    try {
      const aiConv = await this.aiConversations.findOne({
        where: { id: aiConversationId, tenant: { id: tenantId } },
        relations: { agent: true, conversation: true },
      });
      if (!aiConv) throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI conversation not found' });
      if (aiConv.status !== AI_CONVERSATION_STATUS.ACTIVE) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Cannot send to a conversation in status "${aiConv.status}"`,
        });
      }
      channel = aiConv.channel ?? 'API';
      const agent = aiConv.agent;
      const linkedConversationId = aiConv.conversation?.id;

      await this.usage.assertWithinLimit(tenantId, USAGE_METRIC.AI_TOKENS, 1);

      await this.messages.save(
        this.messages.create({
          ai_conversation_id: aiConversationId,
          tenant: { id: tenantId } as Tenant,
          role: AI_MESSAGE_ROLE.USER,
          content: dto.content,
          tokens_used: 0,
        }),
      );
      if (linkedConversationId) {
        await this.mirrorToTimeline(tenantId, linkedConversationId, 'CUSTOMER', dto.content);
      }

      const ragStart = Date.now();
      const embedTiming: { embeddingMs?: number } = {};
      const chunks = agent ? await this.rag.retrieve(tenantId, agent.id, dto.content, undefined, embedTiming) : [];
      const ragRetrievalMs = Date.now() - ragStart;
      const context = this.rag.assembleContext(chunks);
      const recent = await this.messages.find({
        where: { ai_conversation_id: aiConversationId, tenant: { id: tenantId } },
        order: { created_at: 'DESC' },
        take: 20,
      });
      const messages: AiChatMessage[] = [];
      if (agent?.system_prompt) messages.push({ role: 'system', content: agent.system_prompt });
      if (context) messages.push({ role: 'system', content: `Relevant knowledge:\n${context}` });
      for (const m of recent.reverse()) messages.push({ role: this.mapRole(m.role), content: m.content });

      const provider = this.providers.resolve(agent?.model);
      const model = agent?.model;
      const temperature = agent ? Number(agent.temperature) : undefined;
      const toolCtx: ToolContext = {
        tenantId,
        actorUserId: this.ctx.getUser()?.id,
        permissions: this.ctx.getUser()?.permissions ?? [],
        customerId: this.sessionCustomerId(aiConv.session),
        aiConversationId,
        conversationId: aiConv.conversation?.id,
      };

      let full = '';
      let streamed = false;
      let fallback = false;
      let lastModel = model ?? 'noop';
      let promptTokens = 0;
      let completionTokens = 0;
      let usageFromProvider = false;
      let firstTokenMs: number | undefined;
      let streamingDurationMs: number | undefined;
      let toolCallsCount = 0;
      let toolSuccessCount = 0;
      let toolFailureCount = 0;
      let toolExecMs = 0;
      let lastTool: { name: string; result: Record<string, unknown> } | undefined;

      if (provider.stream) {
        streamed = true;
        const streamStart = Date.now();
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
          let turnContent = '';
          let sawToolCalls: AiToolCall[] = [];
          for await (const chunk of provider.stream({ tenantId, model, temperature, messages, tools: ALL_TOOLS })) {
            if (chunk.delta) {
              if (firstTokenMs === undefined) firstTokenMs = Date.now() - turnStart;
              turnContent += chunk.delta;
              onToken(chunk.delta);
            }
            if (chunk.done) {
              if (chunk.toolCalls?.length) sawToolCalls = chunk.toolCalls;
              if (chunk.usage) {
                promptTokens += chunk.usage.promptTokens;
                completionTokens += chunk.usage.completionTokens;
                usageFromProvider = true;
              }
              if (chunk.model) lastModel = chunk.model;
            }
          }
          if (sawToolCalls.length === 0) {
            full = turnContent;
            break;
          }
          messages.push({ role: 'assistant', content: turnContent || null, tool_calls: sawToolCalls });
          for (const call of sawToolCalls) {
            const [result, ms] = await this.timedToolCall(toolCtx, call);
            toolCallsCount += 1;
            toolExecMs += ms;
            if (result.success === false) toolFailureCount += 1;
            else toolSuccessCount += 1;
            lastTool = { name: call.name, result };
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result) });
          }
          if (i === MAX_TOOL_ITERATIONS - 1) full = turnContent || 'I have processed your request.';
        }
        streamingDurationMs = Date.now() - streamStart;
      } else {
        // No streaming support (Noop fallback) — SAME complete()-based tool loop as sendMessage.
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
          const completion = await provider.complete({ tenantId, model, temperature, messages, tools: ALL_TOOLS });
          promptTokens += completion.promptTokens;
          completionTokens += completion.completionTokens;
          usageFromProvider = true;
          lastModel = completion.model;
          fallback = completion.fallback ?? fallback;

          const calls = completion.toolCalls ?? [];
          if (calls.length === 0) {
            full = completion.content;
            break;
          }
          messages.push({ role: 'assistant', content: completion.content || null, tool_calls: calls });
          for (const call of calls) {
            const [result, ms] = await this.timedToolCall(toolCtx, call);
            toolCallsCount += 1;
            toolExecMs += ms;
            if (result.success === false) toolFailureCount += 1;
            else toolSuccessCount += 1;
            lastTool = { name: call.name, result };
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result) });
          }
          if (i === MAX_TOOL_ITERATIONS - 1) full = completion.content || 'I have processed your request.';
        }
        if (full) onToken(full);
      }

      // Streaming APIs don't always return real usage — fall back to char-based
      // estimates (~4 chars/token) only when the provider didn't report usage.
      if (!usageFromProvider) {
        completionTokens = full ? Math.max(1, Math.ceil(full.length / 4)) : 0;
        promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
      }
      const totalTokens = promptTokens + completionTokens;
      modelForMetric = lastModel;

      const costUsd = this.computeCost(promptTokens, completionTokens, lastModel);
      const assistant = await this.dataSource.transaction(async (manager) => {
        const saved = await manager.getRepository(AiMessage).save(
          manager.getRepository(AiMessage).create({
            ai_conversation_id: aiConversationId,
            tenant: { id: tenantId } as Tenant,
            role: AI_MESSAGE_ROLE.ASSISTANT,
            content: full,
            tokens_used: completionTokens,
          }),
        );
        if (agent) await this.recordUsage(manager, tenantId, agent.id, totalTokens);
        await this.recordCost(manager, tenantId, costUsd, promptTokens, completionTokens);
        return saved;
      });

      await this.usage.increment(tenantId, USAGE_METRIC.AI_TOKENS, totalTokens);
      if (linkedConversationId && full) {
        await this.mirrorToTimeline(tenantId, linkedConversationId, 'BOT', full);
      }

      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: lastModel,
        streamed,
        fallback,
        success: true,
        promptTokens,
        completionTokens,
        costUsd,
        ragRetrievalMs,
        embeddingMs: embedTiming.embeddingMs,
        toolCallsCount,
        toolSuccessCount,
        toolFailureCount,
        toolExecMs,
        firstTokenMs,
        streamingDurationMs,
        totalLatencyMs: Date.now() - turnStart,
      });

      return {
        message: assistant,
        retrievedChunks: chunks.length,
        usage: { promptTokens, completionTokens, totalTokens },
        streamed,
        lastTool,
      };
    } catch (err) {
      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: modelForMetric,
        streamed: false,
        fallback: false,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        toolCallsCount: 0,
        toolSuccessCount: 0,
        toolFailureCount: 0,
        toolExecMs: 0,
        totalLatencyMs: Date.now() - turnStart,
      });
      throw err;
    }
  }

  /**
   * Best-effort mirror of an AI turn into the unified Conversation/Message
   * timeline (sender_type CUSTOMER or BOT). `ai_messages` remains the AI engine's
   * own store; the `messages` mirror is what agents / inbox / search / analytics
   * read. A mirror failure must NOT break the AI turn (the bot stays available),
   * so it is logged rather than thrown.
   */
  private async mirrorToTimeline(
    tenantId: string,
    conversationId: string,
    senderType: 'CUSTOMER' | 'BOT',
    content: string,
  ): Promise<void> {
    try {
      await this.timeline.recordChannelMessage(tenantId, conversationId, senderType, content);
    } catch (err) {
      this.logger.warn(
        `timeline mirror (${senderType}) failed for conversation ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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

  /** Single pricing formula — shared by `recordCost` and the metrics recorder. */
  private computeCost(inputTokens: number, outputTokens: number, model: string): number {
    const price = priceFor(model);
    return +((inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output).toFixed(6);
  }

  /**
   * Atomically increment the monthly cost row (tenant-level). Same race-safety
   * rationale as recordUsage; conflict target is UNIQUE(tenantId, period_month).
   * `cost` is pre-computed via `computeCost` (shared with the metrics recorder,
   * so both stores always agree on the same figure for the same turn).
   */
  private async recordCost(
    manager: EntityManager,
    tenantId: string,
    cost: number,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
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
