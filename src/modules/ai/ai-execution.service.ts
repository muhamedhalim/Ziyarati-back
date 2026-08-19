import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Message } from '../../entities/Conversations/Message';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AiRagService } from './ai-rag.service';
import { AiProviderFactory } from './providers/ai-provider.factory';
import {
  AiChatMessage,
  AiCompletionResult,
} from './providers/ai-provider.interface';
import { SendMessageDto } from './dto/send-message.dto';
import { UsageService } from '../subscription-billing/usage.service';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import { SubscriptionService } from '../subscription-billing/subscription.service';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import {
  AiToolDispatchService,
  ToolContext,
} from './tools/ai-tool-dispatch.service';
import { AI_TOOLS, AI_TOOL_PERMISSION } from './tools/ai-tools.constants';
import {
  AI_PUBLIC_BOOKING_TOOLS,
  PUBLIC_DISCOVERY_TOOL_NAMES,
} from './tools/ai-public-booking-tools.constants';
import {
  AI_ADMIN_TOOLS,
  AI_ADMIN_TOOL_PERMISSION,
  AiAdminToolName,
} from './tools/ai-admin-tools.constants';
import { AiMetricsService } from './ai-metrics.service';
import {
  AiToolCall,
  AiToolDefinition,
} from './providers/ai-provider.interface';
import {
  AI_CONVERSATION_STATUS,
  AI_MESSAGE_ROLE,
  currentPeriodMonth,
} from './ai.constants';
import { HandoverCustomerRepliedEvent } from '../../events/handover.events';
import {
  AiPromptBudgetService,
  PromptBudgetTelemetry,
} from './prompt/ai-prompt-budget.service';
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

export type AiExecutionTransport =
  | 'REST'
  | 'WEBSOCKET'
  | 'WHATSAPP'
  | 'BACKGROUND_JOB';
export type AiMemoryContextLoader = () => Promise<
  Array<{
    type?: string;
    content: string;
    score?: number;
  }>
>;

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
  /** AI-023 (FR-048): the per-round-trip tool-call fan-out cap, read from config. */
  private readonly maxToolCallsPerIteration: number;

  constructor(
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
    @InjectRepository(AiMessage)
    private readonly messages: Repository<AiMessage>,
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
    private readonly subscriptions: SubscriptionService,
    private readonly access: AccessControlService,
    private readonly config: ConfigService,
  ) {
    // AI-023 (FR-048, R7): read once at construction — same posture as
    // MAX_TOOL_ITERATIONS being a fixed module constant; this bound is
    // config-driven (env-tunable) rather than a hardcoded constant, but is
    // not expected to change at runtime within one process's lifetime.
    this.maxToolCallsPerIteration = Number(
      this.config.get('AI_MAX_TOOL_CALLS_PER_ITERATION', 10),
    );
  }

  /**
   * THE entitlement gate for an AI turn, on every transport.
   *
   * `AiOrchestratorService` funnels the REST controller, the `ai:message`
   * socket event, the WhatsApp inbound bridge, the guest-chat widget and the
   * queued `ai.execute` job into the two methods below — so this one call
   * covers all of them, and a sixth transport added later inherits it. Before
   * this existed, the only checks here were `assertBillableActionAllowed`
   * (grace-expiry, which permits everything when there is no subscription row
   * at all) and the token quota: a tenant whose AI capability was never granted
   * — or was administratively SUSPENDED mid-incident — kept running AI turns on
   * every path that did not pass through the HTTP guard.
   *
   * Deliberately raises the platform's standard access-denied error rather than
   * a bespoke one: the public payload names only the source and the capability,
   * and `decision.reason` (which names subscription status) stays in
   * `internalContext`. The public-facing guest chat resolves the CLINIC's
   * policy here, so this response is seen by unauthenticated visitors and must
   * not describe the clinic's billing state.
   */
  private async assertAiEntitled(tenantId: string): Promise<void> {
    await this.access.assertAccess(tenantId, FeatureKey.AI_ASSISTANT, {
      surface: 'service',
      detail: 'AiExecutionService.turn',
    });
  }

  /**
   * Maps a failed turn to the error the caller sees WITHOUT losing the real
   * cause. Both turn paths (`sendMessage`, `streamMessage`) used to collapse
   * any non-`AppError` into a bare INTERNAL_ERROR and drop the original
   * exception on the floor, which made every infrastructure failure — a
   * missing table, a driver error, a provider outage — indistinguishable in
   * the server logs from any other failure. That is what hid a plain
   * `relation "ai_request_executions" does not exist` behind "The AI request
   * could not be completed." for every AI turn.
   *
   * The CLIENT-facing message is deliberately unchanged: no internal detail is
   * ever disclosed. The cause travels two server-only channels instead —
   * `AppError.cause` + `internalContext` (both contractually never serialized
   * into a response; see `AppError`'s docblock and
   * `AllExceptionsFilter.writeLog`), and an explicit `logger.error` here.
   *
   * The explicit log is NOT redundant with the filter: `AllExceptionsFilter`
   * is an HTTP filter, and the transport that carries most AI turns is
   * Socket.IO — `AiRealtimeGateway.runMessage` catches the throw itself and
   * only ever logs the (already generic) message, so nothing upstream of this
   * point would otherwise record what actually failed on a realtime turn.
   */
  private failedTurn(
    err: unknown,
    diagnostics: {
      method: 'sendMessage' | 'streamMessage';
      tenantId: string;
      aiConversationId: string;
      channel: string;
      /** Whether the provider call had already been dispatched when this threw. */
      providerStarted: boolean;
      model: string;
      provider: string;
    },
  ): AppError {
    if (err instanceof AppError) return err;

    const cause = err instanceof Error ? err : new Error(String(err));
    const phase = diagnostics.providerStarted
      ? 'PROVIDER_OR_POST_PROVIDER'
      : 'PRE_PROVIDER';
    // Identifiers and phase only — never prompt content, never credentials.
    const internalContext = { ...diagnostics, phase, cause: cause.name };

    this.logger.error(
      `AI turn failed (${diagnostics.method}, phase=${phase}, ` +
        `tenant=${diagnostics.tenantId}, conversation=${diagnostics.aiConversationId}, ` +
        `channel=${diagnostics.channel}, provider=${diagnostics.provider}, ` +
        `model=${diagnostics.model}): ${cause.name}: ${cause.message}`,
      cause.stack,
    );

    return new AppError(ErrorCode.INTERNAL_ERROR, {
      message: 'The AI request could not be completed.',
      internalContext,
      cause,
    });
  }

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
    let quotaReserved = false;
    const channel = transport;
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
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'AI conversation not found',
        });
      }
      if (aiConv.status !== AI_CONVERSATION_STATUS.ACTIVE) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Cannot send to a conversation in status "${aiConv.status}"`,
        });
      }
      logicalChannel = aiConv.channel ?? 'API';
      routeForMetric = `ai.chat.${logicalChannel.toLowerCase()}`;
      const claim = await this.requests.claim(
        tenantId,
        requestKey,
        'chat',
        channel,
      );
      if (claim === 'COMPLETED') {
        const replay = await this.requests.completedResponse<{
          message: AiMessage;
          retrievedChunks: number;
          usage: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          };
          fallback: boolean;
          lastTool?: { name: string; result: Record<string, unknown> };
        }>(tenantId, requestKey);
        if (replay) return replay;
      }
      if (claim !== 'CLAIMED') {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            claim === 'UNKNOWN'
              ? 'A previous AI attempt has an unknown provider outcome and requires verification.'
              : 'The same AI request is already in progress.',
        });
      }
      requestClaimed = true;
      const agent: AiAgent | undefined = aiConv.agent;
      // When the AI session is linked to a messaging Conversation, every turn is
      // mirrored into the unified Message timeline (see mirrorToTimeline).
      const linkedConversationId = aiConv.conversation?.id;

      // Entitlement first: "may this clinic use AI at all?" precedes "is this
      // clinic's billing in good standing?" and "is it under its token cap?".
      await this.assertAiEntitled(tenantId);

      // FND-031: also enforced at the route level (SubscriptionAccessGuard,
      // for the HTTP path) — repeated here so a QUEUED/worker-triggered call
      // into this same seam is covered too.
      await this.subscriptions.assertBillableActionAllowed(tenantId);

      // Quota pre-check (blocks a tenant already over its monthly token cap).
      // FND-034: reserves 1 token's worth of headroom ATOMICALLY (closing the
      // check-then-act race — see UsageService.incrementIfWithinLimit). The
      // true cost (totalTokens) is only known after the provider call
      // completes, so the final tally below adds the REMAINDER
      // (totalTokens - 1), and the catch block releases this reservation if
      // the turn fails before reaching that point.
      const admission = await this.usage.incrementIfWithinLimit(
        tenantId,
        USAGE_METRIC.AI_TOKENS,
        1,
      );
      if (!admission.applied) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Usage limit reached for ${USAGE_METRIC.AI_TOKENS} (${admission.used}/${admission.limit})`,
          publicContext: {
            metric: USAGE_METRIC.AI_TOKENS,
            used: admission.used,
            limit: admission.limit,
            requested: 1,
          },
        });
      }
      quotaReserved = true;
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
        await this.mirrorToTimeline(
          tenantId,
          linkedConversationId,
          'CUSTOMER',
          dto.content,
        );
      }

      // 2) RAG retrieval (read-only) — timed for Advanced AI Monitoring.
      const ragStart = Date.now();
      const embedTiming: {
        embeddingMs?: number;
        embeddingTokens?: number;
        embeddingCacheHits?: number;
        retrievalMode?: 'vector' | 'keyword';
      } = {};
      const chunks = agent
        ? await this.rag.retrieve(
            tenantId,
            agent.id,
            dto.content,
            undefined,
            embedTiming,
            { channel, aiConversationId, idempotencyKey: requestKey },
          )
        : [];
      const ragRetrievalMs = Date.now() - ragStart;
      // 3) Fetch a wider recent window, then let the centralized token budget
      // retain complete recent turns rather than relying on a message count.
      const recent = await this.messages.find({
        where: {
          ai_conversation_id: aiConversationId,
          tenant: { id: tenantId },
        },
        order: { created_at: 'DESC' },
        take: 50,
      });
      const memories = memoryLoader ? await memoryLoader() : [];
      const built = this.budgets.build({
        systemPrompt: agent?.system_prompt,
        ragChunks: chunks,
        memories,
        history: recent
          .reverse()
          .map((m) => ({ role: this.mapRole(m.role), content: m.content })),
        tools: this.availableTools(),
      });
      let messages: AiChatMessage[] = built.messages;
      const tools = built.tools;
      let truncatedPromptTokens = this.totalTruncated(built.telemetry);

      // 4) tool-calling loop: complete → execute tool calls → feed results → repeat
      //    until the model returns a plain answer (or the iteration cap is hit).
      const route = routeForMetric;
      const routed = this.modelRouter.resolve({
        tenantId,
        conversationId: aiConversationId,
        legacyModel: agent?.model,
        feature: 'chat',
        route,
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
        // Public booking tools need the principal itself: for a guest, tenant
        // scoping proves nothing (every guest shares the discovery tenant), so
        // ownership is checked against `session.guestSubject`.
        principal: this.ctx.getUser() ?? undefined,
      };

      let promptTokens = 0;
      let completionTokens = 0;
      let lastModel = routed.model ?? 'noop';
      let fallback = false;
      let finalContent = '';
      let toolCallsCount = 0;
      let toolSuccessCount = 0;
      let toolFailureCount = 0;
      let toolCallsTruncated = 0;
      /** AI-009 (FR-087, SD-1 point 6): the disclosure check tripped and redacted this turn's reply. */
      let promptDisclosureBlocked = false;
      let toolExecMs = 0;
      let lastTool:
        | { name: string; result: Record<string, unknown> }
        | undefined;
      const accounting: TurnAccounting = {
        cachedInputTokens: 0,
        cachedRequestCount: 0,
        providerAttempts: 0,
        toolLoops: 0,
        costMicrousd: 0n,
        pricingStatus: PRICING_STATUS.PRICED,
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
          feature: 'chat',
          route,
          channel,
        });
        promptTokens += completion.promptTokens;
        completionTokens += completion.completionTokens;
        lastModel = completion.model;
        fallback = completion.fallback ?? fallback;
        accounting.cachedInputTokens += completion.cachedPromptTokens ?? 0;
        if ((completion.cachedPromptTokens ?? 0) > 0)
          accounting.cachedRequestCount += 1;
        accounting.providerAttempts += completion.providerAttempts ?? 1;
        await this.recordCompletionCost(
          tenantId,
          aiConversationId,
          requestKey,
          channel,
          route,
          i,
          provider.name,
          completion,
          accounting,
        );

        const calls = completion.toolCalls ?? [];
        if (calls.length === 0) {
          // AI-009 (FR-043, FR-045): checked before persistence and before
          // return, so both the persisted message and the client-visible
          // reply carry the redacted form when this trips.
          const checked = this.applyPromptDisclosureCheck(
            completion.content,
            agent?.system_prompt,
            tools,
          );
          finalContent = checked.content;
          promptDisclosureBlocked = checked.blocked;
          break;
        }
        accounting.toolLoops += 1;

        // Record the assistant's tool-call turn, execute each call, feed results back.
        messages.push({
          role: 'assistant',
          content: completion.content || null,
          tool_calls: calls,
        });
        // AI-023 (FR-048, FR-049): calls beyond the fan-out cap are refused
        // deterministically below, never silently dropped from the transcript.
        const { accepted, refused } = this.capToolCalls(calls);
        toolCallsTruncated += refused.length;
        for (const call of refused) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: this.fanOutRefusalMessage(),
          });
        }
        for (const call of accepted) {
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
          const checked = this.applyPromptDisclosureCheck(
            completion.content || 'I have processed your request.',
            agent?.system_prompt,
            tools,
          );
          finalContent = checked.content;
          promptDisclosureBlocked = promptDisclosureBlocked || checked.blocked;
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
        if (agent)
          await this.recordUsage(manager, tenantId, agent.id, totalTokens);
        return saved;
      });

      // 1 was already reserved atomically by the pre-check above — add only
      // the remainder so the total recorded equals totalTokens, exactly as
      // before this fix (a no-op via increment()'s own guard if totalTokens
      // is somehow <= 1).
      await this.usage.increment(
        tenantId,
        USAGE_METRIC.AI_TOKENS,
        totalTokens - 1,
      );

      // Mirror the bot reply into the unified timeline (after the assistant row is
      // committed, so its timestamp follows the customer turn).
      if (linkedConversationId && finalContent) {
        await this.mirrorToTimeline(
          tenantId,
          linkedConversationId,
          'BOT',
          finalContent,
        );
      }

      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: lastModel,
        feature: 'chat',
        route,
        idempotencyKey: requestKey,
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
        cachedRequestCount:
          accounting.cachedRequestCount + (embedTiming.embeddingCacheHits ?? 0),
        truncatedPromptTokens,
        ragRetrievalMs,
        embeddingMs: embedTiming.embeddingMs,
        retrievalMode: embedTiming.retrievalMode,
        toolCallsCount,
        toolSuccessCount,
        toolFailureCount,
        toolCallsTruncated,
        promptDisclosureBlocked,
        toolExecMs,
        totalLatencyMs: Date.now() - turnStart,
        // AI-016/AI-017 (M2, FR-030, FR-033, FR-034): same id as the
        // ai_tool_calls rows for this turn; acting STAFF principal only —
        // explicit null for guests (never their own principal id), a
        // value, not an omission. `getUser()` returns the guest's own
        // synthesized principal during a guest turn (it is set via the
        // same `setPrincipal` staff turns use), so `.guest` must be
        // checked — matching the realtime gateway's identical guard.
        correlationId: this.ctx.getCorrelationId(),
        actorUserId: this.ctx.getUser()?.guest
          ? null
          : (this.ctx.getUser()?.id ?? null),
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
      if (quotaReserved) {
        // FND-034: the turn didn't reach the final tally, so the 1-token
        // reservation above was never topped up or consumed — release it.
        // Best-effort: a release failure must not mask the real error.
        await this.usage
          .release(tenantId, USAGE_METRIC.AI_TOKENS, 1)
          .catch(() => undefined);
      }
      if (providerStarted) {
        await this.costs.record({
          tenantId,
          aiConversationId,
          idempotencyKey: `${requestKey}:failure`,
          requestKind: 'CHAT',
          provider: providerForMetric,
          model: modelForMetric,
          feature: 'chat',
          route: routeForMetric,
          channel,
          success: false,
          errorCode: 'UNKNOWN_PROVIDER_OUTCOME',
          quote: {
            status: PRICING_STATUS.UNPRICED,
            provider: providerForMetric,
            requestedModel: modelForMetric,
            executionMode: 'STANDARD',
            costMicrousd: null,
          },
        });
      }
      if (requestClaimed) {
        await this.requests
          .fail(
            tenantId,
            requestKey,
            providerStarted
              ? 'UNKNOWN_OUTCOME'
              : err instanceof AppError
                ? 'FAILED_PERMANENT'
                : 'FAILED_RETRYABLE',
            providerStarted
              ? 'PROVIDER_OR_POST_PROVIDER_FAILURE'
              : err instanceof AppError
                ? 'PERMANENT_PRE_PROVIDER_FAILURE'
                : 'RETRYABLE_PRE_PROVIDER_FAILURE',
          )
          .catch(() => undefined);
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
        toolCallsTruncated: 0,
        promptDisclosureBlocked: false,
        toolExecMs: 0,
        totalLatencyMs: Date.now() - turnStart,
        // AI-016/AI-017 (M2, FR-030, FR-033, FR-034): same id as the
        // ai_tool_calls rows for this turn; acting STAFF principal only —
        // explicit null for guests (never their own principal id), a
        // value, not an omission. `getUser()` returns the guest's own
        // synthesized principal during a guest turn (it is set via the
        // same `setPrincipal` staff turns use), so `.guest` must be
        // checked — matching the realtime gateway's identical guard.
        correlationId: this.ctx.getCorrelationId(),
        actorUserId: this.ctx.getUser()?.guest
          ? null
          : (this.ctx.getUser()?.id ?? null),
      });
      throw this.failedTurn(err, {
        method: 'sendMessage',
        tenantId,
        aiConversationId,
        channel,
        providerStarted,
        model: modelForMetric,
        provider: providerForMetric,
      });
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
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'AI conversation not found',
      });
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
      await this.mirrorToTimeline(
        tenantId,
        linkedConversationId,
        'CUSTOMER',
        content,
      );
      // Requirement #10 (notifications): let the assigned agent's channels
      // (WhatsApp/email, per their NotificationRule) know the customer
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
   * AI-009 (FR-043, FR-044, FR-091-FR-093, SD-1): local, dependency-free
   * check for a reply reproducing the assembled system prompt or the
   * caller's permission-filtered tool-schema text for THIS turn — both
   * already in memory, so cost is bounded by reply length alone, never by
   * knowledge-base or conversation size (FR-091). Deliberately NOT an
   * embedding call (FR-093) or an LLM-judge call (FR-092, Principle XXXIV —
   * a model must not be the control that decides whether a model leaked).
   *
   * Method: normalized word-shingle overlap (a bounded, cheap "does the
   * reply contain chunks of the source" measure) — the fraction of the
   * reply's own shingles that also appear in the source's shingle set. A
   * short reply that is mostly copied source text scores high even against
   * a much larger source; an ordinary answer sharing a few incidental words
   * (e.g. clinic hours) does not, because it has few or no matching
   * `AI_PROMPT_SIMILARITY_SHINGLE_SPAN`-word runs in common.
   */
  private checkPromptDisclosure(
    reply: string,
    systemPrompt: string | undefined,
    tools: AiToolDefinition[],
  ): { blocked: boolean; overlapRatio: number } {
    const shingleSpan = Number(
      this.config.get('AI_PROMPT_SIMILARITY_SHINGLE_SPAN', 8),
    );
    const threshold = Number(
      this.config.get('AI_PROMPT_SIMILARITY_THRESHOLD', 0.6),
    );
    const sourceText = `${systemPrompt ?? ''}\n${JSON.stringify(tools)}`;
    const sourceShingles = this.shingleSet(sourceText, shingleSpan);
    const replyShingles = this.shingles(reply, shingleSpan);
    if (sourceShingles.size === 0 || replyShingles.length === 0) {
      return { blocked: false, overlapRatio: 0 };
    }
    let hits = 0;
    for (const shingle of replyShingles) {
      if (sourceShingles.has(shingle)) hits += 1;
    }
    const overlapRatio = hits / replyShingles.length;
    return { blocked: overlapRatio >= threshold, overlapRatio };
  }

  /** Lowercased, punctuation-stripped word list — the shingle unit is a word, not a character. */
  private normalizeForShingles(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  /** Sliding-window word n-grams. A text shorter than `span` still yields one shingle (itself). */
  private shingles(text: string, span: number): string[] {
    const words = this.normalizeForShingles(text);
    if (words.length === 0) return [];
    if (words.length < span) return [words.join(' ')];
    const result: string[] = [];
    for (let i = 0; i <= words.length - span; i += 1) {
      result.push(words.slice(i, i + span).join(' '));
    }
    return result;
  }

  private shingleSet(text: string, span: number): Set<string> {
    return new Set(this.shingles(text, span));
  }

  /** The redacted stand-in for a reply the disclosure check blocks — never the raw leaked content. */
  private readonly PROMPT_DISCLOSURE_REDACTED_MESSAGE =
    "I can't share my internal instructions or configuration. Is there something else I can help you with?";

  /**
   * Applies the check to a fully-assembled (non-streaming) reply and
   * records whether it blocked, for T103's turn-metric visibility. Callers
   * on the non-streaming paths (sendMessage, the Noop-provider fallback
   * branch) call this once, synchronously, before persisting or returning.
   */
  private applyPromptDisclosureCheck(
    content: string,
    systemPrompt: string | undefined,
    tools: AiToolDefinition[],
  ): { content: string; blocked: boolean } {
    const { blocked } = this.checkPromptDisclosure(
      content,
      systemPrompt,
      tools,
    );
    return {
      content: blocked ? this.PROMPT_DISCLOSURE_REDACTED_MESSAGE : content,
      blocked,
    };
  }

  /**
   * SD-1 (`evidence/decisions/SD-1-streaming-disclosure-gate.md`) — the
   * incremental gate for the ONE path where content reaches the client
   * before persistence: the streaming branch. Implements the resolution's 7
   * points exactly:
   *
   *  1. Accumulation is the caller's concern (unchanged) — this gate only
   *     intercepts what gets released to the real `onToken`.
   *  2. Release lags by a hold-back window `W` (characters), derived from
   *     the configured shingle span — never a separate configured value.
   *  3. The check runs at most once per `W` newly-accumulated characters.
   *  4. On a trip, emission stops permanently for this gate's turn/iteration
   *     — the held-back tail is simply never released.
   *  5/6. Handled by the caller: `finalize()` returns the redacted-or-not
   *     final content for the existing `ai:done`/persistence path, and its
   *     `blocked` flag is what the caller records on the turn metric.
   *
   * One gate instance per STREAMING ITERATION (not per whole turn) — an
   * iteration's `turnContent` is exactly what this gate's `buffer` tracks,
   * so `finalize(turnContent)` at the end of an iteration checks precisely
   * the content that iteration is responsible for, matching the existing
   * per-iteration `full = turnContent` assignment this replaces.
   */
  private createStreamingDisclosureGate(
    onToken: (delta: string) => void,
    systemPrompt: string | undefined,
    tools: AiToolDefinition[],
  ): {
    feed: (delta: string) => void;
    finalize: (fullContent: string) => { content: string; blocked: boolean };
  } {
    const shingleSpan = Number(
      this.config.get('AI_PROMPT_SIMILARITY_SHINGLE_SPAN', 8),
    );
    // W (SD-1 point 2, "W >= the similarity check's shingle span"): derived
    // from the shingle span via a fixed average-chars-per-word estimate —
    // not a separately configured value (T098's own instruction).
    const AVG_CHARS_PER_WORD = 6;
    const holdBackWindow = shingleSpan * AVG_CHARS_PER_WORD;

    let buffer = '';
    let released = 0;
    let checkedUpTo = 0;
    let tripped = false;

    const feed = (delta: string): void => {
      if (tripped) return; // point 4: nothing further is ever released
      buffer += delta;
      if (buffer.length - checkedUpTo >= holdBackWindow) {
        checkedUpTo = buffer.length;
        const { blocked } = this.checkPromptDisclosure(
          buffer,
          systemPrompt,
          tools,
        );
        if (blocked) {
          tripped = true;
          return;
        }
      }
      const releasable = buffer.length - holdBackWindow;
      if (releasable > released) {
        const chunk = buffer.slice(released, releasable);
        released = releasable;
        if (chunk) onToken(chunk);
      }
    };

    const finalize = (
      fullContent: string,
    ): { content: string; blocked: boolean } => {
      if (tripped) {
        return { content: this.PROMPT_DISCLOSURE_REDACTED_MESSAGE, blocked: true };
      }
      // Final check on the complete content — the trailing <W tail was
      // accumulated but never individually re-checked past its own
      // cadence tick, so a disclosure completed only in that tail must
      // still be caught here, before persistence/completion (point 4).
      const { blocked } = this.checkPromptDisclosure(
        fullContent,
        systemPrompt,
        tools,
      );
      if (blocked) {
        return { content: this.PROMPT_DISCLOSURE_REDACTED_MESSAGE, blocked: true };
      }
      // The full content passed — safe to flush whatever the hold-back
      // window was still sitting on (including a reply SHORTER than the
      // window, which would otherwise never emit a single onToken delta at
      // all — a real streaming regression the buffer must not cause; SD-1
      // explicitly rejects "removes streaming from a working feature").
      const remaining = buffer.slice(released);
      released = buffer.length;
      if (remaining) onToken(remaining);
      return { content: fullContent, blocked: false };
    };

    return { feed, finalize };
  }

  /**
   * AI-023 (FR-048, FR-049, inspection I-4): bounds how many tool calls ONE
   * provider round-trip may fan out to — independent of MAX_TOOL_ITERATIONS,
   * which bounds how many ROUNDS a turn may take. Without this, a single
   * response's `toolCalls` array (fully provider-controlled) could drive an
   * unbounded amount of work — real bookings, reschedules, cancellations —
   * before the outer round bound ever mattered.
   *
   * Calls beyond the cap are REFUSED, never silently dropped (FR-049): each
   * gets its own deterministic tool-result message fed back, so the model
   * (and the persisted transcript) can see exactly which calls ran and which
   * did not, rather than the excess calls simply vanishing from history.
   */
  private capToolCalls(calls: AiToolCall[]): {
    accepted: AiToolCall[];
    refused: AiToolCall[];
  } {
    if (calls.length <= this.maxToolCallsPerIteration) {
      return { accepted: calls, refused: [] };
    }
    return {
      accepted: calls.slice(0, this.maxToolCallsPerIteration),
      refused: calls.slice(this.maxToolCallsPerIteration),
    };
  }

  /** The deterministic tool-result content fed back for a fan-out-refused call. */
  private fanOutRefusalMessage(): string {
    return JSON.stringify({
      success: false,
      error: `Too many tool calls requested in one turn; only the first ${this.maxToolCallsPerIteration} were executed.`,
    });
  }

  /**
   * The customer this conversation is bound to, when known server-side (e.g.
   * a WhatsApp contact linked via `sessionPatch.context.customerId` — see
   * `WhatsappInboundAiService`). Never trusted from the model; only ever read
   * from the persisted `AiConversation.session` jsonb column.
   */
  private sessionCustomerId(
    session: Record<string, unknown> | undefined,
  ): string | undefined {
    const context = session?.context as Record<string, unknown> | undefined;
    const customerId = context?.customerId;
    return typeof customerId === 'string' && customerId.trim()
      ? customerId
      : undefined;
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
    const requestKey =
      dto.idempotencyKey ?? origin?.waMessageId ?? randomUUID();
    let requestClaimed = false;
    let providerStarted = false;
    let quotaReserved = false;
    const channel = transport;
    let logicalChannel = 'API';
    let routeForMetric = 'ai.chat.api';
    let modelForMetric = 'noop';
    let providerForMetric = 'unknown';
    try {
      const aiConv = await this.aiConversations.findOne({
        where: { id: aiConversationId, tenant: { id: tenantId } },
        relations: { agent: true, conversation: true },
      });
      if (!aiConv)
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'AI conversation not found',
        });
      if (aiConv.status !== AI_CONVERSATION_STATUS.ACTIVE) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Cannot send to a conversation in status "${aiConv.status}"`,
        });
      }
      logicalChannel = aiConv.channel ?? 'API';
      routeForMetric = `ai.chat.${logicalChannel.toLowerCase()}`;
      const claim = await this.requests.claim(
        tenantId,
        requestKey,
        'chat',
        channel,
      );
      if (claim === 'COMPLETED') {
        const replay = await this.requests.completedResponse<{
          message: AiMessage;
          retrievedChunks: number;
          usage: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          };
          streamed: boolean;
          lastTool?: { name: string; result: Record<string, unknown> };
          // FND-023 — optional: a response PERSISTED before this field existed
          // replays without it, which is fine (undefined, not a crash) — the
          // caller already treats a missing/null id as "nothing to attach".
          mirroredMessageId?: string | null;
        }>(tenantId, requestKey);
        if (replay) {
          // AI-009 (SD-1 §Paths not needing the buffer): this content was
          // already checked by the disclosure gate at WRITE time (the
          // original streaming turn that produced `replay.message.content`
          // — a blocked turn's persisted content is already the redacted
          // form, so replaying it can never re-surface the original
          // disclosure). Deliberately NOT re-checked here — paying the
          // check's cost twice for content that already passed (or was
          // already redacted) is pure waste with no security benefit.
          if (replay.message?.content) onToken(replay.message.content);
          return replay;
        }
      }
      if (claim !== 'CLAIMED') {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            claim === 'UNKNOWN'
              ? 'A previous AI attempt has an unknown provider outcome and requires verification.'
              : 'The same AI request is already in progress.',
        });
      }
      requestClaimed = true;
      const agent = aiConv.agent;
      const linkedConversationId = aiConv.conversation?.id;

      // Same entitlement gate as the non-streaming path above — this is the
      // method the WebSocket turn, the WhatsApp inbound bridge and the guest
      // widget all reach.
      await this.assertAiEntitled(tenantId);

      // FND-031: same route-level-plus-worker-path enforcement as the
      // non-streaming path above.
      await this.subscriptions.assertBillableActionAllowed(tenantId);

      // FND-034: same atomic reservation as the non-streaming path above —
      // see its comment for the full rationale.
      const admission = await this.usage.incrementIfWithinLimit(
        tenantId,
        USAGE_METRIC.AI_TOKENS,
        1,
      );
      if (!admission.applied) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Usage limit reached for ${USAGE_METRIC.AI_TOKENS} (${admission.used}/${admission.limit})`,
          publicContext: {
            metric: USAGE_METRIC.AI_TOKENS,
            used: admission.used,
            limit: admission.limit,
            requested: 1,
          },
        });
      }
      quotaReserved = true;
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
      const embedTiming: {
        embeddingMs?: number;
        embeddingTokens?: number;
        embeddingCacheHits?: number;
        retrievalMode?: 'vector' | 'keyword';
      } = {};
      const chunks = agent
        ? await this.rag.retrieve(
            tenantId,
            agent.id,
            dto.content,
            undefined,
            embedTiming,
            { channel, aiConversationId, idempotencyKey: requestKey },
          )
        : [];
      const ragRetrievalMs = Date.now() - ragStart;
      const recent = await this.messages.find({
        where: {
          ai_conversation_id: aiConversationId,
          tenant: { id: tenantId },
        },
        order: { created_at: 'DESC' },
        take: 50,
      });
      const memories = memoryLoader ? await memoryLoader() : [];
      const built = this.budgets.build({
        systemPrompt: agent?.system_prompt,
        ragChunks: chunks,
        memories,
        history: recent
          .reverse()
          .map((m) => ({ role: this.mapRole(m.role), content: m.content })),
        tools: this.availableTools(),
      });
      let messages: AiChatMessage[] = built.messages;
      const tools = built.tools;
      let truncatedPromptTokens = this.totalTruncated(built.telemetry);

      const route = routeForMetric;
      const routed = this.modelRouter.resolve({
        tenantId,
        conversationId: aiConversationId,
        legacyModel: agent?.model,
        feature: 'chat',
        route,
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
        // Public booking tools need the principal itself: for a guest, tenant
        // scoping proves nothing (every guest shares the discovery tenant), so
        // ownership is checked against `session.guestSubject`.
        principal: this.ctx.getUser() ?? undefined,
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
      let toolCallsTruncated = 0;
      /** AI-009 (FR-087, SD-1 point 6): the disclosure check tripped and redacted this turn's reply. */
      let promptDisclosureBlocked = false;
      let toolExecMs = 0;
      let lastTool:
        | { name: string; result: Record<string, unknown> }
        | undefined;
      const accounting: TurnAccounting = {
        cachedInputTokens: 0,
        cachedRequestCount: 0,
        providerAttempts: 0,
        toolLoops: 0,
        costMicrousd: 0n,
        pricingStatus: PRICING_STATUS.PRICED,
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
          let turnUsage:
            | {
                promptTokens: number;
                completionTokens: number;
                cachedPromptTokens?: number;
                providerAttempts?: number;
              }
            | undefined;
          // SD-1: one gate per streaming iteration — its buffer tracks
          // exactly this iteration's turnContent (see the gate's own
          // docblock for why per-iteration, not per-turn).
          const disclosureGate = this.createStreamingDisclosureGate(
            onToken,
            agent?.system_prompt,
            tools,
          );
          for await (const chunk of provider.stream({
            tenantId,
            model,
            temperature,
            messages,
            tools,
            maxOutputTokens: this.budgets.maxOutputTokens,
            idempotencyKey: `${requestKey}:loop:${i}`,
            feature: 'chat',
            route,
            channel,
          })) {
            if (chunk.delta) {
              if (firstTokenMs === undefined)
                firstTokenMs = Date.now() - turnStart;
              turnContent += chunk.delta;
              // AI-009 (SD-1): no delta reaches the real onToken directly —
              // the gate holds back the trailing window and checks at a
              // bounded cadence before releasing anything.
              disclosureGate.feed(chunk.delta);
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
            if ((turnUsage.cachedPromptTokens ?? 0) > 0)
              accounting.cachedRequestCount += 1;
            accounting.providerAttempts += turnUsage.providerAttempts ?? 1;
            await this.recordCompletionCost(
              tenantId,
              aiConversationId,
              requestKey,
              channel,
              route,
              i,
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
            // AI-009 (SD-1 points 4-6): final check on the complete
            // iteration content, before persistence and before the
            // completion reply (ai:done). On a trip the redacted form
            // replaces `full` here; no further deltas were ever released.
            const checked = disclosureGate.finalize(turnContent);
            full = checked.content;
            promptDisclosureBlocked = checked.blocked;
            break;
          }
          accounting.toolLoops += 1;
          messages.push({
            role: 'assistant',
            content: turnContent || null,
            tool_calls: sawToolCalls,
          });
          // AI-023 (FR-048, FR-049): same fan-out cap as sendMessage's loop.
          const { accepted: acceptedStream, refused: refusedStream } =
            this.capToolCalls(sawToolCalls);
          toolCallsTruncated += refusedStream.length;
          for (const call of refusedStream) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: this.fanOutRefusalMessage(),
            });
          }
          for (const call of acceptedStream) {
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
            const checked = disclosureGate.finalize(
              turnContent || 'I have processed your request.',
            );
            full = checked.content;
            promptDisclosureBlocked = promptDisclosureBlocked || checked.blocked;
          }
        }
        streamingDurationMs = Date.now() - streamStart;
      } else {
        // No streaming support (Noop fallback) — SAME complete()-based tool loop as sendMessage.
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
          const fitted = this.budgets.fitRuntime(messages, tools);
          messages = fitted.messages;
          truncatedPromptTokens += fitted.truncatedTokens;
          const completion = await provider.complete({
            tenantId,
            model,
            temperature,
            messages,
            tools,
            maxOutputTokens: this.budgets.maxOutputTokens,
            idempotencyKey: `${requestKey}:loop:${i}`,
            feature: 'chat',
            route,
            channel,
          });
          promptTokens += completion.promptTokens;
          completionTokens += completion.completionTokens;
          usageFromProvider = true;
          lastModel = completion.model;
          fallback = completion.fallback ?? fallback;
          accounting.cachedInputTokens += completion.cachedPromptTokens ?? 0;
          if ((completion.cachedPromptTokens ?? 0) > 0)
            accounting.cachedRequestCount += 1;
          accounting.providerAttempts += completion.providerAttempts ?? 1;
          await this.recordCompletionCost(
            tenantId,
            aiConversationId,
            requestKey,
            channel,
            route,
            i,
            provider.name,
            completion,
            accounting,
          );

          const calls = completion.toolCalls ?? [];
          if (calls.length === 0) {
            // AI-009 (FR-043, FR-045): checked before this branch's single
            // onToken(full) emission below and before persistence.
            const checked = this.applyPromptDisclosureCheck(
              completion.content,
              agent?.system_prompt,
              tools,
            );
            full = checked.content;
            promptDisclosureBlocked = checked.blocked;
            break;
          }
          accounting.toolLoops += 1;
          messages.push({
            role: 'assistant',
            content: completion.content || null,
            tool_calls: calls,
          });
          // AI-023 (FR-048, FR-049, inspection I-4): the third fan-out-cap
          // site — the Noop-provider (no-streaming-support) fallback branch,
          // easy to miss because it is not exercised by a streaming-focused
          // reproduction. Same cap as the other two sites.
          const { accepted: acceptedFallback, refused: refusedFallback } =
            this.capToolCalls(calls);
          toolCallsTruncated += refusedFallback.length;
          for (const call of refusedFallback) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: this.fanOutRefusalMessage(),
            });
          }
          for (const call of acceptedFallback) {
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
            const checked = this.applyPromptDisclosureCheck(
              completion.content || 'I have processed your request.',
              agent?.system_prompt,
              tools,
            );
            full = checked.content;
            promptDisclosureBlocked = promptDisclosureBlocked || checked.blocked;
          }
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
        if (agent)
          await this.recordUsage(manager, tenantId, agent.id, totalTokens);
        return saved;
      });

      // 1 was already reserved atomically by the pre-check above.
      await this.usage.increment(
        tenantId,
        USAGE_METRIC.AI_TOKENS,
        totalTokens - 1,
      );
      let mirroredMessageId: string | null = null;
      if (linkedConversationId && full) {
        const mirrored = await this.mirrorToTimeline(
          tenantId,
          linkedConversationId,
          'BOT',
          full,
        );
        mirroredMessageId = mirrored?.id ?? null;
      }

      await this.metrics.record({
        tenantId,
        aiConversationId,
        channel,
        model: lastModel,
        feature: 'chat',
        route,
        idempotencyKey: requestKey,
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
        cachedRequestCount:
          accounting.cachedRequestCount + (embedTiming.embeddingCacheHits ?? 0),
        truncatedPromptTokens,
        ragRetrievalMs,
        embeddingMs: embedTiming.embeddingMs,
        retrievalMode: embedTiming.retrievalMode,
        toolCallsCount,
        toolSuccessCount,
        toolFailureCount,
        toolCallsTruncated,
        promptDisclosureBlocked,
        toolExecMs,
        firstTokenMs,
        streamingDurationMs,
        totalLatencyMs: Date.now() - turnStart,
        // AI-016/AI-017 (M2, FR-030, FR-033, FR-034): same id as the
        // ai_tool_calls rows for this turn; acting STAFF principal only —
        // explicit null for guests (never their own principal id), a
        // value, not an omission. `getUser()` returns the guest's own
        // synthesized principal during a guest turn (it is set via the
        // same `setPrincipal` staff turns use), so `.guest` must be
        // checked — matching the realtime gateway's identical guard.
        correlationId: this.ctx.getCorrelationId(),
        actorUserId: this.ctx.getUser()?.guest
          ? null
          : (this.ctx.getUser()?.id ?? null),
      });

      const response = {
        message: assistant,
        retrievedChunks: chunks.length,
        usage: { promptTokens, completionTokens, totalTokens },
        streamed,
        lastTool,
        // FND-023 — the mirrored BOT reply's timeline-message id, if one was
        // written this turn. The caller (WhatsappInboundAiService.sendReply)
        // uses it to attach the provider message id once the actual send
        // completes.
        mirroredMessageId,
      };
      await this.requests.complete(tenantId, requestKey, response);
      return response;
    } catch (err) {
      if (quotaReserved) {
        // FND-034: the turn didn't reach the final tally, so the 1-token
        // reservation above was never topped up or consumed — release it.
        // Best-effort: a release failure must not mask the real error.
        await this.usage
          .release(tenantId, USAGE_METRIC.AI_TOKENS, 1)
          .catch(() => undefined);
      }
      if (providerStarted) {
        await this.costs.record({
          tenantId,
          aiConversationId,
          idempotencyKey: `${requestKey}:failure`,
          requestKind: 'CHAT',
          provider: providerForMetric,
          model: modelForMetric,
          feature: 'chat',
          route: routeForMetric,
          channel,
          success: false,
          errorCode: 'UNKNOWN_PROVIDER_OUTCOME',
          quote: {
            status: PRICING_STATUS.UNPRICED,
            provider: providerForMetric,
            requestedModel: modelForMetric,
            executionMode: 'STANDARD',
            costMicrousd: null,
          },
        });
      }
      if (requestClaimed) {
        await this.requests
          .fail(
            tenantId,
            requestKey,
            providerStarted
              ? 'UNKNOWN_OUTCOME'
              : err instanceof AppError
                ? 'FAILED_PERMANENT'
                : 'FAILED_RETRYABLE',
            providerStarted
              ? 'PROVIDER_OR_POST_PROVIDER_FAILURE'
              : err instanceof AppError
                ? 'PERMANENT_PRE_PROVIDER_FAILURE'
                : 'RETRYABLE_PRE_PROVIDER_FAILURE',
          )
          .catch(() => undefined);
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
        toolCallsTruncated: 0,
        promptDisclosureBlocked: false,
        toolExecMs: 0,
        totalLatencyMs: Date.now() - turnStart,
        // AI-016/AI-017 (M2, FR-030, FR-033, FR-034): same id as the
        // ai_tool_calls rows for this turn; acting STAFF principal only —
        // explicit null for guests (never their own principal id), a
        // value, not an omission. `getUser()` returns the guest's own
        // synthesized principal during a guest turn (it is set via the
        // same `setPrincipal` staff turns use), so `.guest` must be
        // checked — matching the realtime gateway's identical guard.
        correlationId: this.ctx.getCorrelationId(),
        actorUserId: this.ctx.getUser()?.guest
          ? null
          : (this.ctx.getUser()?.id ?? null),
      });
      throw this.failedTurn(err, {
        method: 'streamMessage',
        tenantId,
        aiConversationId,
        channel,
        providerStarted,
        model: modelForMetric,
        provider: providerForMetric,
      });
    }
  }

  /**
   * Best-effort mirror of an AI turn into the unified Conversation/Message
   * timeline (sender_type CUSTOMER or BOT). `ai_messages` remains the AI engine's
   * own store; the `messages` mirror is what agents / inbox / search / analytics
   * read. A mirror failure must NOT break the AI turn (the bot stays available),
   * so it is logged rather than thrown.
   */
  /**
   * Returns the mirrored Message row (FND-023) — callers on the OUTBOUND/BOT
   * side use its id to later attach the provider message id once the actual
   * WhatsApp send completes (see `mirroredMessageId` on `streamMessage`'s
   * response), which is what lets a delivery/read webhook find its way back
   * to this reply. `null` on failure (mirroring is best-effort; a timeline
   * write must never fail the AI turn itself).
   */
  private async mirrorToTimeline(
    tenantId: string,
    conversationId: string,
    senderType: 'CUSTOMER' | 'BOT',
    content: string,
    origin?: { waMessageId?: string; messageType?: string },
  ): Promise<Message | null> {
    try {
      return await this.timeline.recordChannelMessage(
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
      return null;
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
    const user = this.ctx.getUser();
    const permissions = new Set(user?.permissions ?? []);

    // F-7: an ANONYMOUS visitor gets the public booking toolset — and only that.
    // Previously `AI_TOOLS` was spread in unconditionally, so a guest was
    // offered `book_appointment` / `reschedule_appointment` /
    // `cancel_appointment`, every one of which returns "Forbidden" at dispatch.
    // That wasted prompt-schema budget and, worse, invited the model to promise
    // a booking it could not perform.
    if (user?.guest) {
      return [
        ...AI_TOOLS.filter((t) => PUBLIC_DISCOVERY_TOOL_NAMES.includes(t.name)),
        ...AI_PUBLIC_BOOKING_TOOLS,
      ];
    }

    // Authenticated principals: the staff booking tools, each advertised only
    // when the actor could actually execute it. The dispatcher remains the
    // enforcement point; this is defense-in-depth and keeps the authorized set
    // within its prompt budget.
    const booking = AI_TOOLS.filter((tool) => {
      const required = AI_TOOL_PERMISSION[tool.name];
      return required ? permissions.has(required) : true;
    });
    const admin = AI_ADMIN_TOOLS.filter((tool) => {
      const required = AI_ADMIN_TOOL_PERMISSION[tool.name as AiAdminToolName];
      return required ? permissions.has(required) : false;
    });
    return [...booking, ...admin];
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
    completion: Pick<
      AiCompletionResult,
      | 'model'
      | 'promptTokens'
      | 'completionTokens'
      | 'cachedPromptTokens'
      | 'providerAttempts'
    >,
    accounting: TurnAccounting,
  ): Promise<void> {
    const quote = this.costs.quoteChat(
      completion.model,
      completion.promptTokens,
      completion.completionTokens,
      completion.cachedPromptTokens ?? 0,
      provider,
    );
    await this.costs.record({
      tenantId,
      aiConversationId,
      idempotencyKey: `${requestKey}:chat:${loop}`,
      requestKind: 'CHAT',
      provider,
      model: completion.model,
      feature: 'chat',
      route,
      channel,
      inputTokens: completion.promptTokens,
      cachedInputTokens: completion.cachedPromptTokens ?? 0,
      outputTokens: completion.completionTokens,
      cachedRequestCount: (completion.cachedPromptTokens ?? 0) > 0 ? 1 : 0,
      toolLoopIndex: loop,
      providerAttempts: completion.providerAttempts ?? 1,
      success: true,
      quote,
    });
    if ((completion.providerAttempts ?? 1) > 1) {
      await this.costs.record({
        tenantId,
        aiConversationId,
        idempotencyKey: `${requestKey}:chat:${loop}:retry-uncertainty`,
        requestKind: 'CHAT',
        provider,
        model: completion.model,
        feature: 'chat',
        route,
        channel,
        success: false,
        errorCode: 'RETRY_USAGE_UNKNOWN',
        quote: {
          status: PRICING_STATUS.UNPRICED,
          provider,
          requestedModel: completion.model,
          executionMode: 'STANDARD',
          costMicrousd: null,
        },
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
    return (
      t.truncatedSystemTokens +
      t.truncatedHistoryTokens +
      t.truncatedRagTokens +
      t.truncatedMemoryTokens +
      t.truncatedToolTokens +
      t.truncatedToolSchemaTokens
    );
  }

  /**
   * Atomically increment the monthly cost row (tenant-level). Same race-safety
   * rationale as recordUsage; conflict target is UNIQUE(tenantId, period_month).
   * `cost` is pre-computed via `computeCost` (shared with the metrics recorder,
   * so both stores always agree on the same figure for the same turn).
   */
}
