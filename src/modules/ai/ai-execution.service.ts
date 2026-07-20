import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AiRagService } from './ai-rag.service';
import { AiProviderFactory } from './providers/ai-provider.factory';
import { AiChatMessage, AiCompletionResult } from './providers/ai-provider.interface';
import { SendMessageDto } from './dto/send-message.dto';
import { UsageService } from '../subscription-billing/usage.service';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { AiToolDispatchService, ToolContext } from './tools/ai-tool-dispatch.service';
import { AI_TOOLS } from './tools/ai-tools.constants';
import {
  AI_ADMIN_TOOLS,
  AI_ADMIN_TOOL_PERMISSION,
  AiAdminToolName,
} from './tools/ai-admin-tools.constants';
import { AiMetricsService } from './ai-metrics.service';
import { AiToolCall, AiToolDefinition } from './providers/ai-provider.interface';
import {
  AI_CONVERSATION_STATUS,
  AI_MESSAGE_ROLE,
  currentPeriodMonth,
} from './ai.constants';
import { HandoverCustomerRepliedEvent } from '../../events/handover.events';
import { AiPromptBudgetService, PromptBudgetTelemetry } from './prompt/ai-prompt-budget.service';
import { AiCostLedgerService } from './cost/ai-cost-ledger.service';
import { PRICING_STATUS } from './cost/ai-price-catalog.service';
import { AiRequestExecutionService } from './idempotency/ai-request-execution.service';
import { AiModelRouterService } from './routing/ai-model-router.service';

/** Bounds the tool-calling loop so a misbehaving model can't spin indefinitely. */
const MAX_TOOL_ITERATIONS = 4;

interface TurnAccounting {
  cachedInputTokens: number;
  cachedRequestCount: number;
  providerAttempts: number;
  toolLoops: number;
  costMicrousd: bigint | null;
  pricingStatus: 'PRICED' | 'UNPRICED';
}

export type AiExecutionTransport = 'REST' | 'WEBSOCKET' | 'WHATSAPP' | 'BACKGROUND_JOB';
export type AiMemoryContextLoader = () => Promise<Array<{
  type?: string;
  content: string;
  score?: number;
}>>;

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
    private readonly budgets: AiPromptBudgetService,
    private readonly costs: AiCostLedgerService,
    private readonly requests: AiRequestExecutionService,
    private readonly modelRouter: AiModelRouterService,
  ) {}

  async sendMessage(
    tenantId: string,
    aiConversationId: string,
    dto: SendMessageDto,
    transport: AiExecutionTransport = 'REST',
    memoryLoader?: AiMemoryContextLoader,
  ) {
    const turnStart = Date.now();
    const requestKey = dto.idempotencyKey ?? randomUUID();
    let requestClaimed = false;
    let providerStarted = false;
    let channel = transport;
    let logicalChannel = 'API';
    let routeForMetric = 'ai.chat.api';
    let modelForMetric = 'noop';
    let providerForMetric = 'unknown';
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
      logicalChannel = aiConv.channel ?? 'API';
      routeForMetric = `ai.chat.${logicalChannel.toLowerCase()}`;
      const claim = await this.requests.claim(tenantId, requestKey, 'chat', channel);
      if (claim === 'COMPLETED') {
        const replay = await this.requests.completedResponse<{
          message: AiMessage; retrievedChunks: number;
          usage: { promptTokens: number; completionTokens: number; totalTokens: number };
          fallback: boolean; lastTool?: { name: string; result: Record<string, unknown> };
        }>(tenantId, requestKey);
        if (replay) return replay;
      }
      if (claim !== 'CLAIMED') {
        throw new AppError(ErrorCode.CONFLICT, {
          message: claim === 'UNKNOWN'
            ? 'A previous AI attempt has an unknown provider outcome and requires verification.'
            : 'The same AI request is already in progress.',
        });
      }
      requestClaimed = true;
      const agent: AiAgent | undefined = aiConv.agent;
      // When the AI session is linked to a messaging Conversation, every turn is
      // mirrored into the unified Message timeline (see mirrorToTimeline).
      const linkedConversationId = aiConv.conversation?.id;

      // Quota pre-check (blocks a tenant already over its monthly token cap).
      await this.usage.assertWithinLimit(tenantId, USAGE_METRIC.AI_TOKENS, 1);
      // From this point onward the turn can persist input, buy a RAG embedding,
      // or execute a provider/tool. A crash has an unknown replay outcome.
      await this.requests.markProviderStarted(tenantId, requestKey);
      providerStarted = true;

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
      const embedTiming: { embeddingMs?: number; embeddingTokens?: number; embeddingCacheHits?: number } = {};
      const chunks = agent ? await this.rag.retrieve(
        tenantId, agent.id, dto.content, undefined, embedTiming,
        { channel, aiConversationId, idempotencyKey: requestKey },
      ) : [];
      const ragRetrievalMs = Date.now() - ragStart;
      // 3) Fetch a wider recent window, then let the centralized token budget
      // retain complete recent turns rather than relying on a message count.
      const recent = await this.messages.find({
        where: { ai_conversation_id: aiConversationId, tenant: { id: tenantId } },
        order: { created_at: 'DESC' },
        take: 50,
      });
      const memories = memoryLoader ? await memoryLoader() : [];
      const built = this.budgets.build({
        systemPrompt: agent?.system_prompt,
        ragChunks: chunks,
        memories,
        history: recent.reverse().map((m) => ({ role: this.mapRole(m.role), content: m.content })),
        tools: this.availableTools(),
      });
      let messages: AiChatMessage[] = built.messages;
      const tools = built.tools;
      let truncatedPromptTokens = this.totalTruncated(built.telemetry);

      // 4) tool-calling loop: complete → execute tool calls → feed results → repeat
      //    until the model returns a plain answer (or the iteration cap is hit).
      const route = routeForMetric;
      const routed = this.modelRouter.resolve({
        tenantId, conversationId: aiConversationId, legacyModel: agent?.model,
        feature: 'chat', route,
      });
      const provider = this.providers.resolve(routed.model);
      providerForMetric = provider.name;
      modelForMetric = routed.model ?? provider.name;
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
      let lastModel = routed.model ?? 'noop';
      let fallback = false;
      let finalContent = '';
      let toolCallsCount = 0;
      let toolSuccessCount = 0;
      let toolFailureCount = 0;
      let toolExecMs = 0;
      let lastTool: { name: string; result: Record<string, unknown> } | undefined;
      const accounting: TurnAccounting = {
        cachedInputTokens: 0, cachedRequestCount: 0, providerAttempts: 0, toolLoops: 0,
        costMicrousd: 0n, pricingStatus: PRICING_STATUS.PRICED,
      };

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
        const fitted = this.budgets.fitRuntime(messages, tools);
        messages = fitted.messages;
        truncatedPromptTokens += fitted.truncatedTokens;
        const completion = await provider.complete({
          tenantId,
          model: routed.model,
          temperature: agent ? Number(agent.temperature) : undefined,
          messages,
          tools,
          maxOutputTokens: this.budgets.maxOutputTokens,
          idempotencyKey: `${requestKey}:loop:${i}`,
          feature: 'chat', route, channel,
        });
        promptTokens += completion.promptTokens;
        completionTokens += completion.completionTokens;
        lastModel = completion.model;
        fallback = completion.fallback ?? fallback;
        accounting.cachedInputTokens += completion.cachedPromptTokens ?? 0;
        if ((completion.cachedPromptTokens ?? 0) > 0) accounting.cachedRequestCount += 1;
        accounting.providerAttempts += completion.providerAttempts ?? 1;
        await this.recordCompletionCost(
          tenantId, aiConversationId, requestKey, channel, route, i,
          provider.name, completion, accounting,
        );

        const calls = completion.toolCalls ?? [];
        if (calls.length === 0) {
          finalContent = completion.content;
          break;
        }
        accounting.toolLoops += 1;

        // Record the assistant's tool-call turn, execute each call, feed results back.
        messages.push({ role: 'assistant', content: completion.content || null, tool_calls: calls });
        for (const call of calls) {
          const [result, ms] = await this.timedToolCall(toolCtx, call);
          toolCallsCount += 1;
          toolExecMs += ms;
          if (result.success === false) toolFailureCount += 1;
          else toolSuccessCount += 1;
          lastTool = { name: call.name, result };
          const toolOutput = this.budgets.truncateToolResult(result);
          truncatedPromptTokens += toolOutput.truncatedTokens;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: toolOutput.content,
          });
        }
        if (i === MAX_TOOL_ITERATIONS - 1) {
          finalContent = completion.content || 'I have processed your request.';
        }
      }
      modelForMetric = lastModel;

      // 5) persist the assistant message + meter usage/cost in one short transaction.
      const totalTokens = promptTokens + completionTokens;
      const costUsd = AiCostLedgerService.toUsdNumber(accounting.costMicrousd);
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
        feature: 'chat', route, idempotencyKey: requestKey,
        streamed: false,
        fallback,
        success: true,
        promptTokens,
        completionTokens,
        cachedInputTokens: accounting.cachedInputTokens,
        embeddingTokens: embedTiming.embeddingTokens,
        costUsd,
        costMicrousd: accounting.costMicrousd,
        pricingStatus: accounting.pricingStatus,
        toolLoopCount: accounting.toolLoops,
        providerAttempts: accounting.providerAttempts,
        cachedRequestCount: accounting.cachedRequestCount + (embedTiming.embeddingCacheHits ?? 0),
        truncatedPromptTokens,
        ragRetrievalMs,
        embeddingMs: embedTiming.embeddingMs,
        toolCallsCount,
        toolSuccessCount,
        toolFailureCount,
        toolExecMs,
        totalLatencyMs: Date.now() - turnStart,
      });

      const response = {
        message: assistant,
        retrievedChunks: chunks.length,
        usage: { promptTokens, completionTokens, totalTokens },
        fallback,
        lastTool,
      };
      await this.requests.complete(tenantId, requestKey, response);
      return response;
    } catch (err) {
      if (providerStarted) {
        await this.costs.record({
          tenantId, aiConversationId, idempotencyKey: `${requestKey}:failure`,
          requestKind: 'CHAT', provider: providerForMetric, model: modelForMetric,
          feature: 'chat', route: routeForMetric, channel,
          success: false, errorCode: 'UNKNOWN_PROVIDER_OUTCOME',
          quote: {
            status: PRICING_STATUS.UNPRICED, provider: providerForMetric,
            requestedModel: modelForMetric, executionMode: 'STANDARD', costMicrousd: null,
          },
        });
      }
      if (requestClaimed) {
        await this.requests.fail(
          tenantId, requestKey,
          providerStarted ? 'UNKNOWN_OUTCOME' : (err instanceof AppError ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE'),
          providerStarted ? 'PROVIDER_OR_POST_PROVIDER_FAILURE' : (err instanceof AppError ? 'PERMANENT_PRE_PROVIDER_FAILURE' : 'RETRYABLE_PRE_PROVIDER_FAILURE'),
        ).catch(() => undefined);
      }
      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: modelForMetric,
        streamed: false,
        fallback: false,
        success: false,
        errorMessage: providerStarted
          ? 'AI_PROVIDER_OR_POST_PROVIDER_FAILURE'
          : 'AI_PRE_PROVIDER_FAILURE',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        toolCallsCount: 0,
        toolSuccessCount: 0,
        toolFailureCount: 0,
        toolExecMs: 0,
        totalLatencyMs: Date.now() - turnStart,
      });
      throw err instanceof AppError
        ? err
        : new AppError(ErrorCode.INTERNAL_ERROR, { message: 'The AI request could not be completed.' });
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
    /**
     * Provider facts about the inbound message (WhatsApp `wamid`, media type).
     * Internal-only: deliberately NOT part of SendMessageDto, because that DTO
     * is bound from HTTP request bodies and a client must never be able to
     * assert someone else's `wa_message_id` (it is a uniqueness/dedup key).
     */
    origin?: { waMessageId?: string; messageType?: string },
    transport: AiExecutionTransport = 'WEBSOCKET',
    memoryLoader?: AiMemoryContextLoader,
  ) {
    const turnStart = Date.now();
    const requestKey = dto.idempotencyKey ?? origin?.waMessageId ?? randomUUID();
    let requestClaimed = false;
    let providerStarted = false;
    let channel = transport;
    let logicalChannel = 'API';
    let routeForMetric = 'ai.chat.api';
    let modelForMetric = 'noop';
    let providerForMetric = 'unknown';
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
      logicalChannel = aiConv.channel ?? 'API';
      routeForMetric = `ai.chat.${logicalChannel.toLowerCase()}`;
      const claim = await this.requests.claim(tenantId, requestKey, 'chat', channel);
      if (claim === 'COMPLETED') {
        const replay = await this.requests.completedResponse<{
          message: AiMessage; retrievedChunks: number;
          usage: { promptTokens: number; completionTokens: number; totalTokens: number };
          streamed: boolean; lastTool?: { name: string; result: Record<string, unknown> };
        }>(tenantId, requestKey);
        if (replay) {
          if (replay.message?.content) onToken(replay.message.content);
          return replay;
        }
      }
      if (claim !== 'CLAIMED') {
        throw new AppError(ErrorCode.CONFLICT, {
          message: claim === 'UNKNOWN'
            ? 'A previous AI attempt has an unknown provider outcome and requires verification.'
            : 'The same AI request is already in progress.',
        });
      }
      requestClaimed = true;
      const agent = aiConv.agent;
      const linkedConversationId = aiConv.conversation?.id;

      await this.usage.assertWithinLimit(tenantId, USAGE_METRIC.AI_TOKENS, 1);
      await this.requests.markProviderStarted(tenantId, requestKey);
      providerStarted = true;

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
        await this.mirrorToTimeline(
          tenantId,
          linkedConversationId,
          'CUSTOMER',
          dto.content,
          origin,
        );
      }

      const ragStart = Date.now();
      const embedTiming: { embeddingMs?: number; embeddingTokens?: number; embeddingCacheHits?: number } = {};
      const chunks = agent ? await this.rag.retrieve(
        tenantId, agent.id, dto.content, undefined, embedTiming,
        { channel, aiConversationId, idempotencyKey: requestKey },
      ) : [];
      const ragRetrievalMs = Date.now() - ragStart;
      const recent = await this.messages.find({
        where: { ai_conversation_id: aiConversationId, tenant: { id: tenantId } },
        order: { created_at: 'DESC' },
        take: 50,
      });
      const memories = memoryLoader ? await memoryLoader() : [];
      const built = this.budgets.build({
        systemPrompt: agent?.system_prompt,
        ragChunks: chunks,
        memories,
        history: recent.reverse().map((m) => ({ role: this.mapRole(m.role), content: m.content })),
        tools: this.availableTools(),
      });
      let messages: AiChatMessage[] = built.messages;
      const tools = built.tools;
      let truncatedPromptTokens = this.totalTruncated(built.telemetry);

      const route = routeForMetric;
      const routed = this.modelRouter.resolve({
        tenantId, conversationId: aiConversationId, legacyModel: agent?.model,
        feature: 'chat', route,
      });
      const provider = this.providers.resolve(routed.model);
      providerForMetric = provider.name;
      const model = routed.model;
      modelForMetric = model ?? provider.name;
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
      const accounting: TurnAccounting = {
        cachedInputTokens: 0, cachedRequestCount: 0, providerAttempts: 0, toolLoops: 0,
        costMicrousd: 0n, pricingStatus: PRICING_STATUS.PRICED,
      };

      if (provider.stream) {
        streamed = true;
        const streamStart = Date.now();
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
          const fitted = this.budgets.fitRuntime(messages, tools);
          messages = fitted.messages;
          truncatedPromptTokens += fitted.truncatedTokens;
          let turnContent = '';
          let sawToolCalls: AiToolCall[] = [];
          let turnUsage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number; providerAttempts?: number } | undefined;
          for await (const chunk of provider.stream({
            tenantId, model, temperature, messages, tools,
            maxOutputTokens: this.budgets.maxOutputTokens,
            idempotencyKey: `${requestKey}:loop:${i}`,
            feature: 'chat', route, channel,
          })) {
            if (chunk.delta) {
              if (firstTokenMs === undefined) firstTokenMs = Date.now() - turnStart;
              turnContent += chunk.delta;
              onToken(chunk.delta);
            }
            if (chunk.done) {
              if (chunk.toolCalls?.length) sawToolCalls = chunk.toolCalls;
              if (chunk.usage) {
                turnUsage = chunk.usage;
                promptTokens += chunk.usage.promptTokens;
                completionTokens += chunk.usage.completionTokens;
                usageFromProvider = true;
              }
              if (chunk.model) lastModel = chunk.model;
            }
          }
          if (turnUsage) {
            accounting.cachedInputTokens += turnUsage.cachedPromptTokens ?? 0;
            if ((turnUsage.cachedPromptTokens ?? 0) > 0) accounting.cachedRequestCount += 1;
            accounting.providerAttempts += turnUsage.providerAttempts ?? 1;
            await this.recordCompletionCost(
              tenantId, aiConversationId, requestKey, channel, route, i,
              provider.name,
              {
                model: lastModel,
                promptTokens: turnUsage.promptTokens,
                completionTokens: turnUsage.completionTokens,
                cachedPromptTokens: turnUsage.cachedPromptTokens,
                providerAttempts: turnUsage.providerAttempts,
              },
              accounting,
            );
          }
          if (sawToolCalls.length === 0) {
            full = turnContent;
            break;
          }
          accounting.toolLoops += 1;
          messages.push({ role: 'assistant', content: turnContent || null, tool_calls: sawToolCalls });
          for (const call of sawToolCalls) {
            const [result, ms] = await this.timedToolCall(toolCtx, call);
            toolCallsCount += 1;
            toolExecMs += ms;
            if (result.success === false) toolFailureCount += 1;
            else toolSuccessCount += 1;
            lastTool = { name: call.name, result };
            const toolOutput = this.budgets.truncateToolResult(result);
            truncatedPromptTokens += toolOutput.truncatedTokens;
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toolOutput.content });
          }
          if (i === MAX_TOOL_ITERATIONS - 1) full = turnContent || 'I have processed your request.';
        }
        streamingDurationMs = Date.now() - streamStart;
      } else {
        // No streaming support (Noop fallback) — SAME complete()-based tool loop as sendMessage.
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
          const fitted = this.budgets.fitRuntime(messages, tools);
          messages = fitted.messages;
          truncatedPromptTokens += fitted.truncatedTokens;
          const completion = await provider.complete({
            tenantId, model, temperature, messages, tools,
            maxOutputTokens: this.budgets.maxOutputTokens,
            idempotencyKey: `${requestKey}:loop:${i}`,
            feature: 'chat', route, channel,
          });
          promptTokens += completion.promptTokens;
          completionTokens += completion.completionTokens;
          usageFromProvider = true;
          lastModel = completion.model;
          fallback = completion.fallback ?? fallback;
          accounting.cachedInputTokens += completion.cachedPromptTokens ?? 0;
          if ((completion.cachedPromptTokens ?? 0) > 0) accounting.cachedRequestCount += 1;
          accounting.providerAttempts += completion.providerAttempts ?? 1;
          await this.recordCompletionCost(
            tenantId, aiConversationId, requestKey, channel, route, i,
            provider.name, completion, accounting,
          );

          const calls = completion.toolCalls ?? [];
          if (calls.length === 0) {
            full = completion.content;
            break;
          }
          accounting.toolLoops += 1;
          messages.push({ role: 'assistant', content: completion.content || null, tool_calls: calls });
          for (const call of calls) {
            const [result, ms] = await this.timedToolCall(toolCtx, call);
            toolCallsCount += 1;
            toolExecMs += ms;
            if (result.success === false) toolFailureCount += 1;
            else toolSuccessCount += 1;
            lastTool = { name: call.name, result };
            const toolOutput = this.budgets.truncateToolResult(result);
            truncatedPromptTokens += toolOutput.truncatedTokens;
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toolOutput.content });
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

      if (!usageFromProvider && lastModel !== 'noop') {
        accounting.costMicrousd = null;
        accounting.pricingStatus = PRICING_STATUS.UNPRICED;
      }
      const costUsd = AiCostLedgerService.toUsdNumber(accounting.costMicrousd);
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
        feature: 'chat', route, idempotencyKey: requestKey,
        streamed,
        fallback,
        success: true,
        promptTokens,
        completionTokens,
        cachedInputTokens: accounting.cachedInputTokens,
        embeddingTokens: embedTiming.embeddingTokens,
        costUsd,
        costMicrousd: accounting.costMicrousd,
        pricingStatus: accounting.pricingStatus,
        toolLoopCount: accounting.toolLoops,
        providerAttempts: accounting.providerAttempts,
        cachedRequestCount: accounting.cachedRequestCount + (embedTiming.embeddingCacheHits ?? 0),
        truncatedPromptTokens,
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

      const response = {
        message: assistant,
        retrievedChunks: chunks.length,
        usage: { promptTokens, completionTokens, totalTokens },
        streamed,
        lastTool,
      };
      await this.requests.complete(tenantId, requestKey, response);
      return response;
    } catch (err) {
      if (providerStarted) {
        await this.costs.record({
          tenantId, aiConversationId, idempotencyKey: `${requestKey}:failure`,
          requestKind: 'CHAT', provider: providerForMetric, model: modelForMetric,
          feature: 'chat', route: routeForMetric, channel,
          success: false, errorCode: 'UNKNOWN_PROVIDER_OUTCOME',
          quote: {
            status: PRICING_STATUS.UNPRICED, provider: providerForMetric,
            requestedModel: modelForMetric, executionMode: 'STANDARD', costMicrousd: null,
          },
        });
      }
      if (requestClaimed) {
        await this.requests.fail(
          tenantId, requestKey,
          providerStarted ? 'UNKNOWN_OUTCOME' : (err instanceof AppError ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE'),
          providerStarted ? 'PROVIDER_OR_POST_PROVIDER_FAILURE' : (err instanceof AppError ? 'PERMANENT_PRE_PROVIDER_FAILURE' : 'RETRYABLE_PRE_PROVIDER_FAILURE'),
        ).catch(() => undefined);
      }
      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: modelForMetric,
        streamed: false,
        fallback: false,
        success: false,
        errorMessage: providerStarted
          ? 'AI_PROVIDER_OR_POST_PROVIDER_FAILURE'
          : 'AI_PRE_PROVIDER_FAILURE',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        toolCallsCount: 0,
        toolSuccessCount: 0,
        toolFailureCount: 0,
        toolExecMs: 0,
        totalLatencyMs: Date.now() - turnStart,
      });
      throw err instanceof AppError
        ? err
        : new AppError(ErrorCode.INTERNAL_ERROR, { message: 'The AI request could not be completed.' });
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
    origin?: { waMessageId?: string; messageType?: string },
  ): Promise<void> {
    try {
      await this.timeline.recordChannelMessage(
        tenantId,
        conversationId,
        senderType,
        content,
        undefined,
        origin,
      );
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
   * Never spend prompt tokens advertising dashboard tools the current actor is
   * not authorized to execute. The dispatcher remains the enforcement point;
   * this is defense-in-depth and keeps the authorized set within its budget.
   */
  private availableTools(): AiToolDefinition[] {
    const permissions = new Set(this.ctx.getUser()?.permissions ?? []);
    const admin = AI_ADMIN_TOOLS.filter((tool) => {
      const required = AI_ADMIN_TOOL_PERMISSION[tool.name as AiAdminToolName];
      return required ? permissions.has(required) : false;
    });
    return [...AI_TOOLS, ...admin];
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
  private async recordCompletionCost(
    tenantId: string,
    aiConversationId: string,
    requestKey: string,
    channel: string,
    route: string,
    loop: number,
    provider: string,
    completion: Pick<AiCompletionResult, 'model' | 'promptTokens' | 'completionTokens' | 'cachedPromptTokens' | 'providerAttempts'>,
    accounting: TurnAccounting,
  ): Promise<void> {
    const quote = this.costs.quoteChat(
      completion.model, completion.promptTokens, completion.completionTokens,
      completion.cachedPromptTokens ?? 0, provider,
    );
    await this.costs.record({
      tenantId, aiConversationId, idempotencyKey: `${requestKey}:chat:${loop}`,
      requestKind: 'CHAT', provider, model: completion.model,
      feature: 'chat', route, channel,
      inputTokens: completion.promptTokens,
      cachedInputTokens: completion.cachedPromptTokens ?? 0,
      outputTokens: completion.completionTokens,
      cachedRequestCount: (completion.cachedPromptTokens ?? 0) > 0 ? 1 : 0,
      toolLoopIndex: loop,
      providerAttempts: completion.providerAttempts ?? 1,
      success: true, quote,
    });
    if ((completion.providerAttempts ?? 1) > 1) {
      await this.costs.record({
        tenantId, aiConversationId, idempotencyKey: `${requestKey}:chat:${loop}:retry-uncertainty`,
        requestKind: 'CHAT', provider, model: completion.model,
        feature: 'chat', route, channel,
        success: false, errorCode: 'RETRY_USAGE_UNKNOWN',
        quote: { status: PRICING_STATUS.UNPRICED, provider, requestedModel: completion.model, executionMode: 'STANDARD', costMicrousd: null },
      });
      accounting.pricingStatus = PRICING_STATUS.UNPRICED;
    }
    if (quote.costMicrousd === null) {
      accounting.costMicrousd = null;
      accounting.pricingStatus = PRICING_STATUS.UNPRICED;
    } else if (accounting.costMicrousd !== null) {
      accounting.costMicrousd += quote.costMicrousd;
    }
  }

  private totalTruncated(t: PromptBudgetTelemetry): number {
    return t.truncatedSystemTokens + t.truncatedHistoryTokens + t.truncatedRagTokens
      + t.truncatedMemoryTokens + t.truncatedToolTokens + t.truncatedToolSchemaTokens;
  }

  /**
   * Atomically increment the monthly cost row (tenant-level). Same race-safety
   * rationale as recordUsage; conflict target is UNIQUE(tenantId, period_month).
   * `cost` is pre-computed via `computeCost` (shared with the metrics recorder,
   * so both stores always agree on the same figure for the same turn).
   */
}
