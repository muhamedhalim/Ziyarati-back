import { Injectable, Logger, Optional } from '@nestjs/common';
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
import {
  AI_TOOLS,
  AI_TOOL_PERMISSION,
  WHATSAPP_CHANNEL_TOOL_NAMES,
  WHATSAPP_ONLY_TOOL_NAMES,
} from './tools/ai-tools.constants';
import {
  AI_PUBLIC_BOOKING_TOOLS,
  BOOKING_CONTEXT_MUTATING_TOOLS,
  PUBLIC_DISCOVERY_TOOL_NAMES,
} from './tools/ai-public-booking-tools.constants';
import { PublicBookingContextService } from '../public-booking/public-booking-context.service';
import {
  AI_ADMIN_TOOLS,
  AI_ADMIN_TOOL_PERMISSION,
  AiAdminToolName,
} from './tools/ai-admin-tools.constants';
import { AiMetricsService } from './ai-metrics.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  AiToolCall,
  AiToolDefinition,
} from './providers/ai-provider.interface';
import {
  AI_CONVERSATION_STATUS,
  AI_MESSAGE_ROLE,
  currentPeriodMonth,
} from './ai.constants';
import {
  AI_FEATURE,
  AiFeature,
  featureForChannel,
} from './execution/ai-execution.constants';
import {
  AiProcessingPolicyService,
  DEFAULT_PROCESSING_DESCRIPTOR,
  ProcessingDescriptor,
} from './execution/ai-processing-policy.service';
import { HandoverCustomerRepliedEvent } from '../../events/handover.events';
import {
  AiPromptBudgetService,
  PromptBudgetTelemetry,
} from './prompt/ai-prompt-budget.service';
import {
  composeClinicInstructions,
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
  DEFAULT_WHATSAPP_SYSTEM_PROMPT,
} from './prompt/default-system-prompt';
import {
  buildDisclosureIndex,
  checkDisclosure,
  type DisclosureIndex,
} from './guardrails/prompt-disclosure';
import {
  looksLikeCode,
  scopeRefusal,
  screenUserMessage,
  type ScopeCategory,
} from './guardrails/scope-guard';
import { describeToday } from './prompt/turn-clock';
import { AiCostLedgerService } from './cost/ai-cost-ledger.service';
import { PRICING_STATUS } from './cost/ai-price-catalog.service';
import { AiRequestExecutionService } from './idempotency/ai-request-execution.service';
import { AiModelRouterService } from './routing/ai-model-router.service';
import { findModel } from './routing/ai-model-registry';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';

/**
 * Bounds the ROUNDS of tool calls in a turn so a misbehaving model can't spin
 * indefinitely. A turn that spends them all gets ONE more, tool-less completion
 * (see TOOL_BUDGET_SPENT_NOTICE), so a turn makes at most MAX_TOOL_ITERATIONS + 1
 * provider calls.
 */
const MAX_TOOL_ITERATIONS = 4;

/**
 * F-15. What the model is told on the extra, tool-less completion that follows a
 * spent tool budget.
 *
 * WHY THERE IS ONE. The loop used to stop at the end of the LAST tool round and
 * answer with a canned line — so whatever that round did (a booking included) was
 * executed and never shown to the model, and the patient was told nothing about
 * it. The WhatsApp booking chain (branches → doctors/services/insurance →
 * availability → book) needs four tool rounds and then an answer, which is one
 * completion more than the loop allowed: the book call ran on the last round and
 * its outcome was thrown away. Tools are withheld on this completion, so it cannot
 * extend the loop — it can only report.
 */
const TOOL_BUDGET_SPENT_NOTICE =
  'Tool calls are no longer available for this reply. Answer the person now, using only what the tool results above returned. If something is still missing, say exactly what and ask for it. Never say an action succeeded unless a tool result above says so.';

/**
 * F-15. The last resort when even the tool-less completion comes back empty.
 * Deliberately claims nothing — no success, no failure, no time, no promise — and
 * covers both product languages, as the WhatsApp turn-failed fallback does.
 */
const TOOL_LOOP_FALLBACK_TEXT =
  'Sorry, I could not finish that reply. Please send your last message again, or ask to speak with the clinic team.\n' +
  'عذرًا، لم أتمكن من إكمال الرد. يُرجى إعادة إرسال رسالتك الأخيرة أو طلب التحدث مع فريق العيادة.';

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
 * Progress signal for ONE tool call inside a streaming turn.
 *
 * WHAT IT CARRIES AND WHY THAT'S ALL. The tool NAME and nothing else — never
 * arguments, never results. Arguments on the public booking surface routinely
 * hold a patient's name and phone (`book_public_appointment`), and results hold
 * clinic data; neither belongs on a socket that exists to drive a spinner.
 * A name alone is enough for the client to say "checking available times".
 *
 * WHY IT EXISTS. Before this, the only turn-level signals were `ai:thinking`,
 * `ai:token` and `ai:done`, so a turn that spent four seconds in
 * `search_public_availability` looked identical to a hung one. The alternative
 * — cycling plausible status messages on a client-side timer — would be
 * fabricated progress: the UI would claim work that might not be happening.
 * This makes the claim true by sourcing it from the actual call.
 *
 * `end` is emitted from a `finally`, so a tool that throws still clears the
 * client's status rather than leaving it stuck on the last thing it tried.
 */
export interface AiToolProgressEvent {
  name: string;
  phase: 'start' | 'end';
}
export type AiToolProgressListener = (event: AiToolProgressEvent) => void;

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
    // WHICH model (modelRouter) and HOW it is processed (processingPolicy) are
    // two independent decisions — a model can change without changing a
    // workload's processing policy, and vice versa.
    private readonly processingPolicy: AiProcessingPolicyService,
    private readonly subscriptions: SubscriptionService,
    private readonly access: AccessControlService,
    private readonly config: ConfigService,
    private readonly platformSettings: SystemSettingService,
    /**
     * Supplies the server-verified booking state that is pinned into every
     * public turn's prompt. The selections have always been persisted; this is
     * what finally shows them to the model.
     */
    private readonly bookingContext: PublicBookingContextService,
    /** Fleet-level counters. Optional: a missing counter must never cost a turn. */
    @Optional() private readonly platformMetrics?: MetricsService,
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
   * A per-agent `temperature` always wins (seeded from `AI_DEFAULT_TEMP` at
   * agent-creation time, then editable independently). When there is no
   * agent row at all — the guest/public widget always hits this, since it
   * runs against the discovery tenant with no `AiAgent` — the platform
   * setting must still be consulted here rather than left to
   * `OpenAiChatProvider`'s own `?? 0.2` fallback, or a super admin changing
   * `ai.default_temperature` would never affect that surface.
   */
  private async resolveTemperature(agent?: AiAgent): Promise<number> {
    if (agent) return Number(agent.temperature);
    return this.platformSettings.getTyped<number>(SettingKey.AI_DEFAULT_TEMP);
  }

  /**
   * The platform's configured model — `ai.default_model` from
   * `/platform/system-settings` — handed to the router as the default it lands
   * on when nothing more specific applies.
   *
   * The exact counterpart of `resolveTemperature` above, and it exists for the
   * same reason: the guest/public widget runs against the discovery tenant with
   * no `AiAgent` row, so without this the setting would govern only agents
   * created after it was changed, and the widget would run on whatever
   * `AI_FALLBACK_MODEL` said. That is what made the setting a seed value rather
   * than the platform's model configuration.
   *
   * `getTyped` is served from `SystemSettingService`'s 30 s in-process cache, so
   * this adds no per-message query (see the caching note on that class).
   */
  private async resolveDefaultModel(): Promise<string> {
    return this.platformSettings.getTyped<string>(SettingKey.AI_DEFAULT_MODEL);
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
    let quotaFundedBy: 'plan' | 'credit' | 'none' = 'plan';
    const channel = transport;
    let logicalChannel = 'API';
    let routeForMetric = 'ai.chat.api';
    // The logical AI_FEATURE for this turn. Every call site used to pass the
    // literal 'chat', which made AI_POWERFUL_FEATURES an all-or-nothing switch
    // (it can only match one value) and left the cost ledger unable to tell a
    // guest booking turn from a staff dashboard turn. `route` stays the finer
    // key; this is the coarse, policy-facing one.
    let featureForMetric: AiFeature = AI_FEATURE.CHAT;
    let processing: ProcessingDescriptor = DEFAULT_PROCESSING_DESCRIPTOR;
    let modelForMetric = 'noop';
    let providerForMetric = 'unknown';
    // F-20: WHO the cost/usage rows of this turn are attributed to. The conversation
    // tenant unless a guest has chosen a clinic (see `meterTenantFor`) — assigned once
    // that is known, so a turn that fails earlier still lands on the conversation tenant.
    let meterTenantId = tenantId;
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
      featureForMetric = this.featureForChannel(logicalChannel);
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
        if (replay) {
          this.assertReplayBelongsTo(replay, aiConversationId);
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

      // HOW this turn is processed — resolved here, BEFORE the quota
      // reservation and before a single token is spent, so a residency refusal
      // (required region unavailable, or the tenant not entitled to it) costs
      // nothing and lands as a clean PRE_PROVIDER failure. Residency used to be
      // applied invisibly inside the provider's client resolution, which meant
      // it threw only after the user message had been persisted and a RAG
      // embedding bought.
      //
      // `IMMEDIATE`: a human is waiting on this reply, so it can never be
      // routed to the asynchronous batch route regardless of feature mapping.
      processing = await this.processingPolicy.resolve({
        tenantId,
        feature: featureForMetric,
        route: routeForMetric,
        latencyRequirement: 'IMMEDIATE',
        dataSensitivity: 'SENSITIVE',
      });

      // F-10: an unambiguous role-change, prompt-extraction, code, creative-writing,
      // arithmetic or trivia ask on a surface strangers reach is answered with a
      // fixed redirect HERE — before the quota is reserved, before retrieval, before
      // any model or tool call — so it costs nothing and cannot be talked round.
      if (this.scopeGuardActive(channel)) {
        const verdict = screenUserMessage(dto.content);
        if (verdict.blocked && verdict.category) {
          return await this.answerOutOfScope({
            tenantId,
            session: aiConv.session,
            aiConversationId,
            linkedConversationId,
            content: dto.content,
            requestKey,
            channel,
            route: routeForMetric,
            feature: featureForMetric,
            processing,
            turnStart,
            category: verdict.category,
          });
        }
      }

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
      quotaFundedBy = admission.fundedBy;
      // From this point onward the turn can persist input, buy a RAG embedding,
      // or execute a provider/tool. A crash has an unknown replay outcome.
      await this.requests.markProviderStarted(tenantId, requestKey);
      providerStarted = true;

      // 1) persist the user message (own write — not held across the LLM round-trips).
      //    Its id is this turn's identity for the tool confirmation gate (F-04).
      const userMessage = await this.messages.save(
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
      // Knowledge is agent-OPTIONAL (chunks may be bound to an agent or left
      // unbound), so retrieval must NOT be gated on an agent existing — that
      // gate is what made a tenant's own Knowledge unreachable on every surface
      // that has no Admin-provisioned agent. `retrieve` takes `string | null`
      // and matches "this agent OR unbound", both tenant-scoped.
      const knowledgeTenantId = await this.resolveKnowledgeScope(
        aiConv.session,
        tenantId,
      );
      meterTenantId = this.meterTenantFor(tenantId, knowledgeTenantId);
      const chunks = await this.rag.retrieve(
        knowledgeTenantId,
        agent?.id ?? null,
        dto.content,
        undefined,
        embedTiming,
        { channel, aiConversationId, idempotencyKey: requestKey },
      );
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

      // 4) WHICH model. Resolved BEFORE the prompt is assembled so the budget
      //    can bound the prompt against the chosen model's real context window
      //    instead of one global AI_MODEL_CONTEXT_WINDOW_TOKENS figure. The
      //    processing descriptor is passed as a CONSTRAINT: a model that cannot
      //    satisfy the required mode/region is substituted or refused — the
      //    processing decision is never weakened to accommodate a model.
      const route = routeForMetric;
      const routed = this.modelRouter.resolve({
        tenantId,
        conversationId: aiConversationId,
        legacyModel: agent?.model,
        platformDefaultModel: await this.resolveDefaultModel(),
        feature: featureForMetric,
        route,
        processing: {
          executionMode: processing.executionMode,
          residencyRequired: processing.residencyRequired,
          region: processing.region,
        },
      });
      // `definition` is present only when routing is active; on the flag-off
      // path the registry is consulted directly so per-model budgeting applies
      // either way. Always resolves now: `routed.model` is guaranteed to be a
      // registered id on every branch.
      const modelDefinition = routed.definition ?? findModel(routed.model);
      const temperature = await this.resolveTemperature(agent);

      // The prompt this turn ACTUALLY runs under. Computed once because two
      // things must agree on it: what is sent to the model, and what
      // `applyPromptDisclosureCheck` protects from being recited back. Passing
      // the default to the former but `undefined` to the latter would have made
      // the platform prompt the one prompt the disclosure gate did not cover.
      const { corePrompt, clinicInstructions, effectiveSystemPrompt } =
        this.composeSystemPrompt(channel, agent);
      // F-10: the redirect a code reply is swapped for — set only where the guard applies.
      const scopeRedirect = this.scopeGuardActive(channel)
        ? scopeRefusal(dto.content)
        : undefined;

      // The booking selections this conversation already established, re-proved
      // against the database. Pinned into the prompt so a public turn continues
      // the flow instead of rediscovering it — tool results are not persisted as
      // messages, so this block is the ONLY way that state survives a turn.
      const bookingContext = await this.buildBookingContext(
        tenantId,
        aiConversationId,
        channel,
      );

      const built = this.budgets.build({
        systemPrompt: corePrompt,
        agentInstructions: clinicInstructions,
        bookingContext,
        ragChunks: chunks,
        memories,
        history: recent
          .reverse()
          .map((m) => ({ role: this.mapRole(m.role), content: m.content })),
        tools: this.availableTools(channel),
        model: modelDefinition,
      });
      let messages: AiChatMessage[] = built.messages;
      const tools = built.tools;
      let truncatedPromptTokens = this.totalTruncated(built.telemetry);

      // 5) tool-calling loop: complete → execute tool calls → feed results → repeat
      //    until the model returns a plain answer (or the iteration cap is hit).
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
        channel,
        turnId: userMessage?.id,
        // Only what this turn offered the model may be executed (see ToolContext).
        allowedTools: tools.map((t) => t.name),
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

      for (let i = 0; i <= MAX_TOOL_ITERATIONS; i += 1) {
        // F-15: the round after the last tool round is the tool-less wrap-up.
        const wrapUp = i === MAX_TOOL_ITERATIONS;
        if (wrapUp) {
          messages = [
            ...messages,
            { role: 'system', content: TOOL_BUDGET_SPENT_NOTICE },
          ];
        }
        const fitted = this.budgets.fitRuntime(
          messages,
          wrapUp ? [] : tools,
          modelDefinition,
        );
        messages = fitted.messages;
        truncatedPromptTokens += fitted.truncatedTokens;
        const completion = await provider.complete({
          tenantId,
          model: routed.model,
          temperature,
          // Capabilities travel WITH the request: a reasoning model rejects an
          // explicit temperature outright, so the agent's configured value must
          // be dropped by the provider rather than sent and 400'd.
          supportsTemperature: modelDefinition?.supportsTemperature,
          reasoningEffort: modelDefinition?.reasoningEffort,
          messages,
          tools: wrapUp ? [] : tools,
          maxOutputTokens: this.budgets.maxOutputTokens,
          idempotencyKey: `${requestKey}:loop:${i}`,
          feature: featureForMetric,
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
        await this.recordCompletionCost({
          tenantId: meterTenantId,
          aiConversationId,
          requestKey,
          channel,
          route,
          feature: featureForMetric,
          loop: i,
          provider: provider.name,
          completion,
          accounting,
          processing,
        });

        // A wrap-up completion never runs tools, whatever the provider sent back.
        const calls = wrapUp ? [] : (completion.toolCalls ?? []);
        if (calls.length === 0) {
          // AI-009 (FR-043, FR-045): checked before persistence and before
          // return, so both the persisted message and the client-visible
          // reply carry the redacted form when this trips.
          const checked = this.applyPromptDisclosureCheck(
            wrapUp
              ? completion.content?.trim() || TOOL_LOOP_FALLBACK_TEXT
              : completion.content,
            effectiveSystemPrompt,
            tools,
            scopeRedirect,
          );
          finalContent = checked.content;
          promptDisclosureBlocked = checked.blocked;
          if (checked.scopeBlocked)
            this.logScopeBlock(tenantId, aiConversationId, 'reply-code');
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
        // A select_* (or a city-recording search_clinics) just moved the
        // server-side selection on. Re-prove it and replace the pinned block so
        // the next iteration reads one consistent account of the booking.
        messages = await this.refreshBookingContext(
          messages,
          tenantId,
          aiConversationId,
          accepted,
        );
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
        await this.recordUsage(
          manager,
          meterTenantId,
          agent?.id ?? null,
          totalTokens,
        );
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
      if (quotaFundedBy === 'credit') {
        // FIN-011: the credit-funded turn pays its real cost, not 1 unit.
        await this.usage
          .settleCreditRemainder(tenantId, USAGE_METRIC.AI_TOKENS, totalTokens - 1)
          .catch(() => undefined);
      }

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
        tenantId: meterTenantId,
        aiConversationId,
        channel,
        model: lastModel,
        feature: featureForMetric,
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
        processing,
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
          .release(tenantId, USAGE_METRIC.AI_TOKENS, 1, quotaFundedBy)
          .catch(() => undefined);
      }
      if (providerStarted) {
        await this.costs.record({
          tenantId: meterTenantId,
          aiConversationId,
          idempotencyKey: `${requestKey}:failure`,
          requestKind: 'CHAT',
          provider: providerForMetric,
          model: modelForMetric,
          feature: featureForMetric,
          route: routeForMetric,
          channel,
          executionMode: processing.executionMode,
          region: processing.region,
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
        tenantId: meterTenantId,
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
        processing,
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
   * A person answered the patient directly from the inbox, on a conversation the
   * AI has been serving. Adds their message to that AI session's own history
   * (role `assistant`, attributed to the person via `agent_user_id`, exactly as a
   * handover reply is), so that when the AI answers again it knows what the
   * clinic already said instead of repeating or contradicting it.
   *
   * The timeline already holds the message (the caller saved it); this writes
   * only the AI-side history. Returns false — and writes nothing — when the
   * conversation has no AI session. Tenant-scoped.
   */
  async recordStaffMessage(
    tenantId: string,
    conversationId: string,
    userId: string,
    content: string,
  ): Promise<boolean> {
    const aiConv = await this.aiConversations.findOne({
      where: { conversation: { id: conversationId }, tenant: { id: tenantId } },
      order: { created_at: 'DESC' },
      // `created_at` must be selected too: TypeORM sorts a relation-filtered
      // lookup through a DISTINCT subquery and fails on an unselected sort column.
      select: { id: true, created_at: true },
    });
    if (!aiConv) return false;
    await this.messages.save(
      this.messages.create({
        ai_conversation_id: aiConv.id,
        tenant: { id: tenantId } as Tenant,
        role: AI_MESSAGE_ROLE.ASSISTANT,
        content,
        tokens_used: 0,
        agent_user_id: userId,
      }),
    );
    return true;
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
    /**
     * Provider facts (WhatsApp `wamid`) when the message arrived over a channel
     * bridge. The bridge has already stored the message on the timeline under
     * that `wamid`, so passing it makes the mirror below a no-op instead of a
     * second copy of the same patient message.
     */
    origin?: { waMessageId?: string; messageType?: string },
  ): Promise<{ handedOver: true }> {
    const aiConv = await this.aiConversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
      relations: { conversation: { assigned_to: true, tenant: true } },
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
      // The timeline and the notification belong to the tenant that OWNS the
      // linked conversation. That is `tenantId` for every channel except a web
      // guest handed over to a clinic (F-07): the guest's AI conversation is in
      // the discovery tenant, the conversation the clinic's staff are working in
      // is the clinic's, and writing to it under the guest's tenant would be
      // refused.
      const timelineTenantId = aiConv.conversation?.tenant?.id ?? tenantId;
      await this.mirrorToTimeline(
        timelineTenantId,
        linkedConversationId,
        'CUSTOMER',
        content,
        origin,
      );
      // Requirement #10 (notifications): let the assigned agent's channels
      // (WhatsApp/email, per their NotificationRule) know the customer
      // replied — the realtime WS push only reaches an already-online agent.
      this.emitter.emit(
        HandoverCustomerRepliedEvent.eventName,
        new HandoverCustomerRepliedEvent(
          timelineTenantId,
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
   * AI-009 (FR-043, FR-044, FR-091-FR-093, SD-1) + F-11: the index of what a reply
   * must not recite — the assembled system prompt and this turn's tool catalogue.
   * Built ONCE per turn iteration (the streaming gate used to rebuild the source's
   * shingle set on every check). The three signals and their limits are documented
   * in `guardrails/prompt-disclosure.ts`.
   */
  private disclosureIndex(
    systemPrompt: string | undefined,
    tools: AiToolDefinition[],
  ): DisclosureIndex {
    return buildDisclosureIndex(systemPrompt, tools, {
      span: Number(this.config.get('AI_PROMPT_SIMILARITY_SHINGLE_SPAN', 8)),
      threshold: Number(this.config.get('AI_PROMPT_SIMILARITY_THRESHOLD', 0.6)),
    });
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
    /** F-10: the redirect to use if this reply turns out to be code (public/WhatsApp only). */
    scopeRedirect?: string,
  ): { content: string; blocked: boolean; scopeBlocked?: boolean } {
    const { blocked } = checkDisclosure(
      this.disclosureIndex(systemPrompt, tools),
      content,
    );
    if (blocked) {
      return { content: this.PROMPT_DISCLOSURE_REDACTED_MESSAGE, blocked };
    }
    if (scopeRedirect && looksLikeCode(content)) {
      return { content: scopeRedirect, blocked: false, scopeBlocked: true };
    }
    return { content, blocked: false };
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
    /**
     * F-10: when set (public/WhatsApp turns), the gate ALSO refuses to carry code
     * to the client and answers with this redirect instead. It rides the same
     * hold-back window and cadence as the disclosure check, so a fenced block is
     * stopped at its first checked tick, not after it has all been streamed.
     */
    scopeRedirect?: string,
  ): {
    feed: (delta: string) => void;
    finalize: (fullContent: string) => {
      content: string;
      blocked: boolean;
      scopeBlocked?: boolean;
    };
  } {
    const shingleSpan = Number(
      this.config.get('AI_PROMPT_SIMILARITY_SHINGLE_SPAN', 8),
    );
    // W (SD-1 point 2, "W >= the similarity check's shingle span"): derived
    // from the shingle span via a fixed average-chars-per-word estimate —
    // not a separately configured value (T098's own instruction).
    const AVG_CHARS_PER_WORD = 6;
    const holdBackWindow = shingleSpan * AVG_CHARS_PER_WORD;

    // One index for the whole iteration: the source does not change between checks.
    const index = this.disclosureIndex(systemPrompt, tools);
    let buffer = '';
    let released = 0;
    let checkedUpTo = 0;
    let tripped: false | 'disclosure' | 'scope' = false;

    const feed = (delta: string): void => {
      if (tripped) return; // point 4: nothing further is ever released
      buffer += delta;
      if (buffer.length - checkedUpTo >= holdBackWindow) {
        checkedUpTo = buffer.length;
        const { blocked } = checkDisclosure(index, buffer);
        if (blocked) {
          tripped = 'disclosure';
          return;
        }
        if (scopeRedirect && looksLikeCode(buffer)) {
          tripped = 'scope';
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
    ): { content: string; blocked: boolean; scopeBlocked?: boolean } => {
      if (tripped === 'scope' && scopeRedirect) {
        return { content: scopeRedirect, blocked: false, scopeBlocked: true };
      }
      if (tripped) {
        return {
          content: this.PROMPT_DISCLOSURE_REDACTED_MESSAGE,
          blocked: true,
        };
      }
      // Final check on the complete content — the trailing <W tail was
      // accumulated but never individually re-checked past its own
      // cadence tick, so a disclosure completed only in that tail must
      // still be caught here, before persistence/completion (point 4).
      const { blocked } = checkDisclosure(index, fullContent);
      if (blocked) {
        return {
          content: this.PROMPT_DISCLOSURE_REDACTED_MESSAGE,
          blocked: true,
        };
      }
      if (scopeRedirect && looksLikeCode(fullContent)) {
        return { content: scopeRedirect, blocked: false, scopeBlocked: true };
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

  /** Whether a turn keyed `key` has already started — i.e. this is a replay. */
  hasRequestClaim(tenantId: string, key: string): Promise<boolean> {
    return this.requests.exists(tenantId, key);
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
    origin?: {
      waMessageId?: string;
      messageType?: string;
      /** Epoch ms after which no further tool round starts (WhatsApp turns). */
      deadlineAt?: number;
    },
    transport: AiExecutionTransport = 'WEBSOCKET',
    memoryLoader?: AiMemoryContextLoader,
    /**
     * Optional per-tool progress signal (see {@link AiToolProgressEvent}).
     * Optional, and trailing, so every existing caller — the WhatsApp bridge,
     * the dashboard socket, the tests — is unaffected by its addition.
     */
    onToolEvent?: AiToolProgressListener,
  ) {
    const turnStart = Date.now();
    const requestKey =
      dto.idempotencyKey ?? origin?.waMessageId ?? randomUUID();
    /**
     * Runs one tool call, bracketed by its progress signal.
     *
     * A local wrapper rather than a change to `timedToolCall`, which is shared
     * with the non-streaming `sendMessage` path that has no listener to notify
     * — widening it there would mean threading a parameter through a method
     * whose other caller can never use it. `finally` guarantees the client's
     * status clears even when a tool throws.
     */
    const runTool = async (
      ctx: Parameters<typeof this.timedToolCall>[0],
      call: Parameters<typeof this.timedToolCall>[1],
    ) => {
      onToolEvent?.({ name: call.name, phase: 'start' });
      try {
        return await this.timedToolCall(ctx, call);
      } finally {
        onToolEvent?.({ name: call.name, phase: 'end' });
      }
    };
    let requestClaimed = false;
    let providerStarted = false;
    let quotaReserved = false;
    let quotaFundedBy: 'plan' | 'credit' | 'none' = 'plan';
    const channel = transport;
    let logicalChannel = 'API';
    let routeForMetric = 'ai.chat.api';
    // The logical AI_FEATURE for this turn. Every call site used to pass the
    // literal 'chat', which made AI_POWERFUL_FEATURES an all-or-nothing switch
    // (it can only match one value) and left the cost ledger unable to tell a
    // guest booking turn from a staff dashboard turn. `route` stays the finer
    // key; this is the coarse, policy-facing one.
    let featureForMetric: AiFeature = AI_FEATURE.CHAT;
    let processing: ProcessingDescriptor = DEFAULT_PROCESSING_DESCRIPTOR;
    let modelForMetric = 'noop';
    let providerForMetric = 'unknown';
    // F-20: WHO the cost/usage rows of this turn are attributed to. The conversation
    // tenant unless a guest has chosen a clinic (see `meterTenantFor`) — assigned once
    // that is known, so a turn that fails earlier still lands on the conversation tenant.
    let meterTenantId = tenantId;
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
      featureForMetric = this.featureForChannel(logicalChannel);
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
          this.assertReplayBelongsTo(replay, aiConversationId);
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
          internalContext: { claimState: claim },
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

      // Same pre-spend processing decision as the non-streaming path above —
      // see its comment for the full rationale. Streaming turns are `IMMEDIATE`
      // by definition: a batch route cannot stream.
      processing = await this.processingPolicy.resolve({
        tenantId,
        feature: featureForMetric,
        route: routeForMetric,
        latencyRequirement: 'IMMEDIATE',
        dataSensitivity: 'SENSITIVE',
      });

      // F-10: an unambiguous role-change, prompt-extraction, code, creative-writing,
      // arithmetic or trivia ask on a surface strangers reach is answered with a
      // fixed redirect HERE — before the quota is reserved, before retrieval, before
      // any model or tool call — so it costs nothing and cannot be talked round.
      if (this.scopeGuardActive(channel)) {
        const verdict = screenUserMessage(dto.content);
        if (verdict.blocked && verdict.category) {
          return await this.answerOutOfScope({
            tenantId,
            session: aiConv.session,
            aiConversationId,
            linkedConversationId,
            content: dto.content,
            origin,
            onToken,
            requestKey,
            channel,
            route: routeForMetric,
            feature: featureForMetric,
            processing,
            turnStart,
            category: verdict.category,
          });
        }
      }

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
      quotaFundedBy = admission.fundedBy;
      await this.requests.markProviderStarted(tenantId, requestKey);
      providerStarted = true;

      const userMessage = await this.messages.save(
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
      // Same agent-optional retrieval as the non-streaming path above — see its
      // comment. This is the method the public widget, the dashboard realtime
      // chat and the WhatsApp bridge all reach, so the gate had to go here too.
      const knowledgeTenantId = await this.resolveKnowledgeScope(
        aiConv.session,
        tenantId,
      );
      meterTenantId = this.meterTenantFor(tenantId, knowledgeTenantId);
      const chunks = await this.rag.retrieve(
        knowledgeTenantId,
        agent?.id ?? null,
        dto.content,
        undefined,
        embedTiming,
        { channel, aiConversationId, idempotencyKey: requestKey },
      );
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

      // Same order as the non-streaming path: model first, so the prompt budget
      // is bounded by the chosen model's own context window, and the processing
      // descriptor is applied as a capability constraint on that choice.
      const route = routeForMetric;
      const routed = this.modelRouter.resolve({
        tenantId,
        conversationId: aiConversationId,
        legacyModel: agent?.model,
        platformDefaultModel: await this.resolveDefaultModel(),
        feature: featureForMetric,
        route,
        processing: {
          executionMode: processing.executionMode,
          residencyRequired: processing.residencyRequired,
          region: processing.region,
        },
      });
      const modelDefinition = routed.definition ?? findModel(routed.model);

      // Same single source of truth for "the prompt this turn runs under" as
      // the non-streaming path above — see its comment.
      const { corePrompt, clinicInstructions, effectiveSystemPrompt } =
        this.composeSystemPrompt(channel, agent);
      // F-10: the redirect a code reply is swapped for — set only where the guard applies.
      const scopeRedirect = this.scopeGuardActive(channel)
        ? scopeRefusal(dto.content)
        : undefined;

      // Same server-verified booking state as the non-streaming path — this is
      // the method the public widget actually reaches, so it had to go here too.
      const bookingContext = await this.buildBookingContext(
        tenantId,
        aiConversationId,
        channel,
      );

      const built = this.budgets.build({
        systemPrompt: corePrompt,
        agentInstructions: clinicInstructions,
        bookingContext,
        ragChunks: chunks,
        memories,
        history: recent
          .reverse()
          .map((m) => ({ role: this.mapRole(m.role), content: m.content })),
        tools: this.availableTools(channel),
        model: modelDefinition,
      });
      let messages: AiChatMessage[] = built.messages;
      const tools = built.tools;
      let truncatedPromptTokens = this.totalTruncated(built.telemetry);

      const provider = this.providers.resolve(routed.model);
      providerForMetric = provider.name;
      const model = routed.model;
      modelForMetric = model ?? provider.name;
      const temperature = await this.resolveTemperature(agent);
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
        channel,
        turnId: userMessage?.id,
        // Only what this turn offered the model may be executed (see ToolContext).
        allowedTools: tools.map((t) => t.name),
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
        for (let i = 0; i <= MAX_TOOL_ITERATIONS; i += 1) {
          // F-15: the round after the last tool round is the tool-less wrap-up.
          const wrapUp =
            i === MAX_TOOL_ITERATIONS ||
            (origin?.deadlineAt !== undefined &&
              Date.now() >= origin.deadlineAt);
          if (wrapUp) {
            messages = [
              ...messages,
              { role: 'system', content: TOOL_BUDGET_SPENT_NOTICE },
            ];
          }
          const fitted = this.budgets.fitRuntime(
            messages,
            wrapUp ? [] : tools,
            modelDefinition,
          );
          messages = fitted.messages;
          truncatedPromptTokens += fitted.truncatedTokens;
          let turnContent = '';
          let sawToolCalls: AiToolCall[] = [];
          let turnUsage:
            | {
                promptTokens: number;
                completionTokens: number;
                cachedPromptTokens?: number;
                cacheWriteTokens?: number;
                providerAttempts?: number;
              }
            | undefined;
          // SD-1: one gate per streaming iteration — its buffer tracks
          // exactly this iteration's turnContent (see the gate's own
          // docblock for why per-iteration, not per-turn).
          const disclosureGate = this.createStreamingDisclosureGate(
            onToken,
            effectiveSystemPrompt,
            tools,
            scopeRedirect,
          );
          for await (const chunk of provider.stream({
            tenantId,
            model,
            temperature,
            supportsTemperature: modelDefinition?.supportsTemperature,
            reasoningEffort: modelDefinition?.reasoningEffort,
            messages,
            tools: wrapUp ? [] : tools,
            maxOutputTokens: this.budgets.maxOutputTokens,
            idempotencyKey: `${requestKey}:loop:${i}`,
            feature: featureForMetric,
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
            await this.recordCompletionCost({
              tenantId: meterTenantId,
              aiConversationId,
              requestKey,
              channel,
              route,
              feature: featureForMetric,
              loop: i,
              provider: provider.name,
              completion: {
                model: lastModel,
                promptTokens: turnUsage.promptTokens,
                completionTokens: turnUsage.completionTokens,
                cachedPromptTokens: turnUsage.cachedPromptTokens,
                // Streaming is the DOMINANT chat path here (dashboard WS,
                // WhatsApp, guest widget all stream), so omitting this would
                // under-bill cache writes almost everywhere while the
                // non-streaming path looked correct.
                cacheWriteTokens: turnUsage.cacheWriteTokens,
                providerAttempts: turnUsage.providerAttempts,
              },
              accounting,
              processing,
            });
          }
          // A wrap-up completion never runs tools, whatever the provider sent back.
          if (wrapUp || sawToolCalls.length === 0) {
            // AI-009 (SD-1 points 4-6): final check on the complete
            // iteration content, before persistence and before the
            // completion reply (ai:done). On a trip the redacted form
            // replaces `full` here; no further deltas were ever released.
            //
            // F-15: an empty wrap-up gets the fixed fallback, and — unlike the
            // model's own text — it was never fed through the gate, so it is
            // released to the client here.
            const emptyWrapUp = wrapUp && !turnContent.trim();
            const checked = disclosureGate.finalize(
              emptyWrapUp ? TOOL_LOOP_FALLBACK_TEXT : turnContent,
            );
            full = checked.content;
            promptDisclosureBlocked = checked.blocked;
            if (checked.scopeBlocked)
              this.logScopeBlock(tenantId, aiConversationId, 'reply-code');
            if (emptyWrapUp && !checked.blocked) onToken(full);
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
            const [result, ms] = await runTool(toolCtx, call);
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
          // Same refresh as the non-streaming loop — see its comment.
          messages = await this.refreshBookingContext(
            messages,
            tenantId,
            aiConversationId,
            acceptedStream,
          );
        }
        streamingDurationMs = Date.now() - streamStart;
      } else {
        // No streaming support (Noop fallback) — SAME complete()-based tool loop as sendMessage.
        for (let i = 0; i <= MAX_TOOL_ITERATIONS; i += 1) {
          // F-15: the round after the last tool round is the tool-less wrap-up.
          const wrapUp =
            i === MAX_TOOL_ITERATIONS ||
            (origin?.deadlineAt !== undefined &&
              Date.now() >= origin.deadlineAt);
          if (wrapUp) {
            messages = [
              ...messages,
              { role: 'system', content: TOOL_BUDGET_SPENT_NOTICE },
            ];
          }
          const fitted = this.budgets.fitRuntime(
            messages,
            wrapUp ? [] : tools,
            modelDefinition,
          );
          messages = fitted.messages;
          truncatedPromptTokens += fitted.truncatedTokens;
          const completion = await provider.complete({
            tenantId,
            model,
            temperature,
            supportsTemperature: modelDefinition?.supportsTemperature,
            reasoningEffort: modelDefinition?.reasoningEffort,
            messages,
            tools: wrapUp ? [] : tools,
            maxOutputTokens: this.budgets.maxOutputTokens,
            idempotencyKey: `${requestKey}:loop:${i}`,
            feature: featureForMetric,
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
          await this.recordCompletionCost({
            tenantId: meterTenantId,
            aiConversationId,
            requestKey,
            channel,
            route,
            feature: featureForMetric,
            loop: i,
            provider: provider.name,
            completion,
            accounting,
            processing,
          });

          // A wrap-up completion never runs tools, whatever the provider sent back.
          const calls = wrapUp ? [] : (completion.toolCalls ?? []);
          if (calls.length === 0) {
            // AI-009 (FR-043, FR-045): checked before this branch's single
            // onToken(full) emission below and before persistence.
            const checked = this.applyPromptDisclosureCheck(
              wrapUp
                ? completion.content?.trim() || TOOL_LOOP_FALLBACK_TEXT
                : completion.content,
              effectiveSystemPrompt,
              tools,
              scopeRedirect,
            );
            full = checked.content;
            promptDisclosureBlocked = checked.blocked;
            if (checked.scopeBlocked)
              this.logScopeBlock(tenantId, aiConversationId, 'reply-code');
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
            const [result, ms] = await runTool(toolCtx, call);
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
          // Same refresh as the other two loops — see the non-streaming one.
          messages = await this.refreshBookingContext(
            messages,
            tenantId,
            aiConversationId,
            acceptedFallback,
          );
        }
        if (full) onToken(full);
      }

      // Streaming APIs don't always return real usage. When none is reported the
      // turn stays UNPRICED (below) — these numbers are telemetry only, never a
      // billing basis. Estimated with the SAME mixed-script estimator the prompt
      // budget uses (~1 token per 2 UTF-8 bytes for non-ASCII) rather than a flat
      // 4-chars-per-token rule, which undercounted every Arabic turn by roughly
      // half and made AR/EN token dashboards non-comparable.
      if (!usageFromProvider) {
        completionTokens = full ? Math.max(1, this.budgets.estimate(full)) : 0;
        promptTokens = this.budgets.estimateMessages(messages);
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
        await this.recordUsage(
          manager,
          meterTenantId,
          agent?.id ?? null,
          totalTokens,
        );
        return saved;
      });

      // 1 was already reserved atomically by the pre-check above.
      await this.usage.increment(
        tenantId,
        USAGE_METRIC.AI_TOKENS,
        totalTokens - 1,
      );
      if (quotaFundedBy === 'credit') {
        // FIN-011: the credit-funded turn pays its real cost, not 1 unit.
        await this.usage
          .settleCreditRemainder(tenantId, USAGE_METRIC.AI_TOKENS, totalTokens - 1)
          .catch(() => undefined);
      }
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
        tenantId: meterTenantId,
        aiConversationId,
        channel,
        model: lastModel,
        feature: featureForMetric,
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
        processing,
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
          .release(tenantId, USAGE_METRIC.AI_TOKENS, 1, quotaFundedBy)
          .catch(() => undefined);
      }
      if (providerStarted) {
        await this.costs.record({
          tenantId: meterTenantId,
          aiConversationId,
          idempotencyKey: `${requestKey}:failure`,
          requestKind: 'CHAT',
          provider: providerForMetric,
          model: modelForMetric,
          feature: featureForMetric,
          route: routeForMetric,
          channel,
          executionMode: processing.executionMode,
          region: processing.region,
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
        tenantId: meterTenantId,
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
        processing,
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

  /**
   * Delegates to the shared channel→feature map. `route`
   * (`ai.chat.<channel>`) remains the finer per-channel key; this coarse value
   * is what the feature-keyed policies consume.
   */
  private featureForChannel(channel: string): AiFeature {
    return featureForChannel(channel);
  }

  private mapRole(role: string): 'system' | 'user' | 'assistant' {
    if (role === AI_MESSAGE_ROLE.ASSISTANT) return 'assistant';
    if (role === AI_MESSAGE_ROLE.SYSTEM) return 'system';
    return 'user';
  }

  /**
   * Never spend prompt tokens advertising dashboard tools the current actor is
   * not authorized to execute. The dispatcher remains the enforcement point;
   * this is defense-in-depth and keeps the authorized set within its budget.
   *
   * `channel` is REQUIRED (not defaulted) so a call site that forgets to pass
   * it fails to compile rather than silently falling through to the staff
   * branch — the exact mistake that would hand a WhatsApp turn the
   * cross-tenant discovery tools this method exists to keep off that channel.
   */
  private availableTools(channel: AiExecutionTransport): AiToolDefinition[] {
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

    // WhatsApp: the tenant's own bot actor is AUTHENTICATED (never a guest),
    // so without this branch it would fall into the staff branch below and
    // inherit `search_clinics` / `get_clinic_details` /
    // `search_public_availability` — cross-tenant discovery tools that carry
    // no entry in AI_TOOL_PERMISSION and so pass the staff filter unchecked.
    // A patient messaging Clinic A's own WhatsApp number must never be able
    // to have the model surface Clinic B. Checked here, before the staff
    // branch, on purpose. See WHATSAPP_CHANNEL_TOOL_NAMES' own docblock for
    // why the toolset is tenant-scoped discovery + booking, not a filtered
    // AI_TOOLS.
    if (channel === 'WHATSAPP') {
      return AI_TOOLS.filter((t) =>
        WHATSAPP_CHANNEL_TOOL_NAMES.includes(t.name),
      );
    }

    // Authenticated principals: the staff booking tools, each advertised only
    // when the actor could actually execute it. The dispatcher remains the
    // enforcement point; this is defense-in-depth and keeps the authorized set
    // within its prompt budget.
    const booking = AI_TOOLS.filter((tool) => {
      // Own-clinic discovery is WhatsApp-only — the dashboard has its own
      // operational surfaces for branches/doctors/services, and without this
      // exclusion these three would default-include below exactly like every
      // other permission-less AI_TOOLS entry (search_clinics,
      // check_availability, etc. — all pre-existing staff tools).
      if (WHATSAPP_ONLY_TOOL_NAMES.includes(tool.name)) return false;
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
   * The platform default system prompt for a turn whose agent supplies none.
   *
   * Mirrors `availableTools()`'s own branching so the instructions always
   * describe the toolset the model was actually handed: only the public widget
   * is told about `list_cities`, because only it is offered that tool; only
   * WhatsApp is told to start from `list_clinic_branches`, because only it is
   * offered that (own-clinic, not cross-tenant) discovery toolset.
   *
   * Platform-owned code constants, never a clinic-selectable `ai_prompts` row —
   * agents, models and prompts are Admin-controlled configuration.
   */
  private defaultSystemPrompt(channel: AiExecutionTransport): string {
    if (this.ctx.getUser()?.guest) return DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT;
    if (channel === 'WHATSAPP') return DEFAULT_WHATSAPP_SYSTEM_PROMPT;
    return DEFAULT_ASSISTANT_SYSTEM_PROMPT;
  }

  /**
   * F-12: the prompt a turn runs under = the platform core for its surface, with
   * the clinic's agent text (when there is one) ON TOP of it.
   *
   * Before, `agent.system_prompt || default` — the agent text REPLACED the core,
   * so a clinic Owner's one-line persona removed the clinical-safety boundary, the
   * no-invention rule and the WhatsApp own-clinic rules. `corePrompt` and
   * `clinicInstructions` are returned apart because the budget truncates them
   * separately; `effectiveSystemPrompt` is both together, which is what the
   * disclosure check has to protect from being recited.
   */
  private composeSystemPrompt(
    channel: AiExecutionTransport,
    agent: AiAgent | undefined,
  ): {
    corePrompt: string;
    clinicInstructions: string | undefined;
    effectiveSystemPrompt: string;
  } {
    const corePrompt = this.defaultSystemPrompt(channel);
    const clinicInstructions = composeClinicInstructions(agent?.system_prompt);
    return {
      corePrompt,
      clinicInstructions,
      effectiveSystemPrompt: clinicInstructions
        ? `${corePrompt}\n\n${clinicInstructions}`
        : corePrompt,
    };
  }

  /**
   * F-10: does the scope guard apply to this turn? The two surfaces a stranger
   * reaches — the public widget (a guest principal) and a clinic's WhatsApp number
   * (the bridge-only transport, see F-13) — and never the signed-in staff
   * assistant. `AI_SCOPE_GUARD_ENABLED=false` is the operator's kill switch.
   */
  private scopeGuardActive(channel: AiExecutionTransport): boolean {
    if (String(this.config.get('AI_SCOPE_GUARD_ENABLED', 'true')) === 'false') {
      return false;
    }
    return !!this.ctx.getUser()?.guest || channel === 'WHATSAPP';
  }

  /** What tripped, never what was said: the message itself stays out of the log. */
  private logScopeBlock(
    tenantId: string,
    aiConversationId: string,
    kind: ScopeCategory | 'reply-code',
  ): void {
    this.logger.warn(
      `scope guard: ${kind} (tenant=${tenantId}, conversation=${aiConversationId})`,
    );
    this.platformMetrics?.recordAiScopeBlock(
      this.ctx.getUser()?.guest ? 'public' : 'whatsapp',
      kind,
    );
  }

  /**
   * F-10: finish a turn the scope guard refused, WITHOUT a model.
   *
   * It is still a turn — the visitor's message and the redirect are persisted (and
   * mirrored to the inbox on WhatsApp), the request is completed so a retry of the
   * same key replays it, and a metrics row records it with zero tokens. What it is
   * not: no quota was reserved (the caller checks before that), no retrieval, no
   * tool, no provider call and no cost row, and no usage row — nothing was spent.
   */
  private async answerOutOfScope(p: {
    tenantId: string;
    session: Record<string, unknown> | undefined;
    aiConversationId: string;
    linkedConversationId: string | undefined;
    content: string;
    origin?: { waMessageId?: string; messageType?: string };
    onToken?: (delta: string) => void;
    requestKey: string;
    channel: AiExecutionTransport;
    route: string;
    feature: AiFeature;
    processing: ProcessingDescriptor;
    turnStart: number;
    category: ScopeCategory;
  }) {
    this.logScopeBlock(p.tenantId, p.aiConversationId, p.category);
    const reply = scopeRefusal(p.content);
    await this.messages.save(
      this.messages.create({
        ai_conversation_id: p.aiConversationId,
        tenant: { id: p.tenantId } as Tenant,
        role: AI_MESSAGE_ROLE.USER,
        content: p.content,
        tokens_used: 0,
      }),
    );
    if (p.linkedConversationId) {
      await this.mirrorToTimeline(
        p.tenantId,
        p.linkedConversationId,
        'CUSTOMER',
        p.content,
        p.origin,
      );
    }
    const assistant = await this.messages.save(
      this.messages.create({
        ai_conversation_id: p.aiConversationId,
        tenant: { id: p.tenantId } as Tenant,
        role: AI_MESSAGE_ROLE.ASSISTANT,
        content: reply,
        tokens_used: 0,
      }),
    );
    let mirroredMessageId: string | null = null;
    if (p.linkedConversationId) {
      const mirrored = await this.mirrorToTimeline(
        p.tenantId,
        p.linkedConversationId,
        'BOT',
        reply,
      );
      mirroredMessageId = mirrored?.id ?? null;
    }
    p.onToken?.(reply);
    await this.metrics.record({
      tenantId: this.meterTenantFor(
        p.tenantId,
        await this.resolveKnowledgeScope(p.session, p.tenantId),
      ),
      aiConversationId: p.aiConversationId,
      channel: p.channel,
      model: 'scope-guard',
      feature: p.feature,
      route: p.route,
      idempotencyKey: p.requestKey,
      streamed: false,
      fallback: false,
      success: true,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      toolCallsCount: 0,
      toolSuccessCount: 0,
      toolFailureCount: 0,
      toolCallsTruncated: 0,
      promptDisclosureBlocked: false,
      toolExecMs: 0,
      totalLatencyMs: Date.now() - p.turnStart,
      correlationId: this.ctx.getCorrelationId(),
      actorUserId: this.ctx.getUser()?.guest
        ? null
        : (this.ctx.getUser()?.id ?? null),
      processing: p.processing,
    });
    const response = {
      message: assistant,
      retrievedChunks: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      streamed: false,
      fallback: false,
      lastTool: undefined as
        | { name: string; result: Record<string, unknown> }
        | undefined,
      mirroredMessageId,
    };
    await this.requests.complete(p.tenantId, p.requestKey, response);
    return response;
  }

  /**
   * F-20: which tenant this turn's COST and USAGE rows belong to.
   *
   * An anonymous visitor's conversation lives in the shared guest-discovery tenant
   * — it owns the chat rows and nothing else — so every guest turn's cost, usage
   * and metrics rows landed there (302 rows, none on the clinic) while the
   * booking tool call, and the retrieval embedding, already named the clinic. A
   * clinic could not see what its public assistant cost.
   *
   * Once the visitor has chosen a clinic, `resolveKnowledgeScope` has re-proved it
   * against live data (approved, active, opted in to public booking), and that is
   * the tenant to attribute to; before that, or if the choice no longer holds, it
   * stays the conversation's own tenant. Only ever re-attributes a GUEST turn —
   * a staff or WhatsApp turn is always its own tenant's.
   *
   * WHAT THIS DOES NOT MOVE. The quota counter (`UsageService`, the plan's AI-token
   * cap) and the entitlement check still use the conversation tenant. Charging a
   * clinic's purchased quota for anonymous visitors — and refusing a visitor
   * mid-conversation because the clinic ran out — is a commercial decision, not a
   * bookkeeping fix; see the Phase 3 log.
   */
  private meterTenantFor(
    conversationTenantId: string,
    resolvedTenantId: string,
  ): string {
    return this.ctx.getUser()?.guest ? resolvedTenantId : conversationTenantId;
  }

  /**
   * The ESTABLISHED BOOKING CONTEXT block for a PUBLIC turn, or `undefined`.
   *
   * Public surfaces only: it is built from the anonymous booking session, which
   * no authenticated staff turn has. Never throws — a turn must still be
   * answerable when this cannot be produced, so a failure degrades to no block
   * rather than to no reply.
   */
  private async buildBookingContext(
    tenantId: string,
    aiConversationId: string,
    channel?: AiExecutionTransport,
  ): Promise<string | undefined> {
    const user = this.ctx.getUser();
    // F-28: a WhatsApp patient is not a guest, but their turns have the same
    // amnesia — the own-clinic working set is that channel's pinned block. It
    // always carries today's date, so a WhatsApp turn never resolves "tomorrow"
    // from the model's memory.
    const ownClinic = !user?.guest && !!user && channel === 'WHATSAPP';
    if (!user?.guest && !ownClinic) return undefined;
    try {
      if (ownClinic) {
        return (
          (await this.dispatch.describeOwnClinicContext(
            tenantId,
            aiConversationId,
          )) ?? undefined
        );
      }
      return (
        (await this.bookingContext.describeSelection(
          tenantId,
          aiConversationId,
          user,
        )) ?? undefined
      );
    } catch (err) {
      this.logger.warn(
        `booking context unavailable for ${aiConversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // The working set could not be read, the date still can: a turn must not
      // lose its clock because a branch lookup failed.
      return ownClinic
        ? `ESTABLISHED BOOKING CONTEXT\n- ${describeToday()}`
        : undefined;
    }
  }

  /**
   * Rebuilds the pinned booking-context system message IN PLACE after a tool
   * call changed the selection, so the model never sees a fresh tool result
   * sitting beside a stale statement of what has been established.
   *
   * Identified by position, not by content: it is the SECOND system message,
   * the only other one being the turn's own system prompt. Replaced when the
   * refreshed block still has content, removed when the selection has become
   * empty — leaving the old text in place would be worse than having none.
   */
  private async refreshBookingContext(
    messages: AiChatMessage[],
    tenantId: string,
    aiConversationId: string,
    calls: AiToolCall[],
  ): Promise<AiChatMessage[]> {
    if (!calls.some((c) => BOOKING_CONTEXT_MUTATING_TOOLS.has(c.name))) {
      return messages;
    }
    const refreshed = await this.buildBookingContext(
      tenantId,
      aiConversationId,
    );
    const systemIndexes = messages
      .map((m, i) => (m.role === 'system' ? i : -1))
      .filter((i) => i >= 0);
    const slot = systemIndexes[1];

    if (slot === undefined) {
      // No block was pinned at assembly time (nothing had been selected yet) —
      // a `select_*` inside this very turn has now created one.
      if (!refreshed) return messages;
      const after = systemIndexes[0] ?? -1;
      const next = [...messages];
      next.splice(after + 1, 0, { role: 'system', content: refreshed });
      return next;
    }
    const next = [...messages];
    if (refreshed) next[slot] = { role: 'system', content: refreshed };
    else next.splice(slot, 1);
    return next;
  }

  /**
   * WHICH tenant's Knowledge this turn may retrieve.
   *
   * For every authenticated surface this is simply the conversation's own
   * tenant — unchanged, and the only value RAG has ever been given.
   *
   * The public widget is the exception. An anonymous visitor's socket is
   * authenticated into the shared `__guest_discovery__` tenant, which owns the
   * chat rows and NOTHING else — so retrieving under it can only ever return
   * zero chunks, which is exactly why a clinic's Knowledge never reached the
   * public chatbot. Once the visitor has actually chosen a clinic, that
   * clinic's own Knowledge becomes the right scope.
   *
   * Why `selectedClinicId` is safe to scope on, and why it is not a client
   * `tenantId` override:
   *  - It is absent from `SESSION_CLIENT_PATCHABLE_KEYS`, so `patchFromClient`
   *    silently drops it: no socket payload, DTO or tool argument can write it.
   *  - Its ONLY writer is `AiToolDispatchService.selectClinic`, via
   *    `PublicBookingContextService.patchSelection`, and only AFTER
   *    `PublicDiscoveryService.clinicDetail` has proven the clinic is APPROVED,
   *    active, not soft-deleted and opted in to public booking.
   *  - It is re-validated HERE on every turn against live data, not trusted as
   *    recorded, so an opt-out or deactivation mid-conversation takes effect
   *    immediately — the same posture as
   *    `PublicBookingContextService.resolveTenantFromBranch`.
   *
   * Fails closed: before a clinic is selected, or if the recorded one is no
   * longer publicly bookable, the scope stays the conversation's own tenant.
   * Exactly ONE tenant id is ever returned, so retrieval remains single-tenant
   * and cross-clinic reads are impossible.
   */
  private async resolveKnowledgeScope(
    session: Record<string, unknown> | undefined,
    conversationTenantId: string,
  ): Promise<string> {
    const selected = session?.selectedClinicId;
    if (typeof selected !== 'string' || !selected.trim()) {
      return conversationTenantId;
    }
    if (selected === conversationTenantId) return conversationTenantId;

    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT t.id
         FROM tenants t
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE t.id = $1
          AND t.approval_status = 'APPROVED'
          AND t.is_active = true
          AND t.deleted_at IS NULL
          AND COALESCE(ts.public_booking_enabled, false) = true
        LIMIT 1`,
      [selected],
    );
    return rows[0]?.id ?? conversationTenantId;
  }

  /**
   * Atomically increment the monthly usage row for (tenant, agent).
   *
   * Was find-then-save, which lost updates under concurrent turns (two turns read
   * the same row → last write wins → tokens undercounted) or hit 23505. A single
   * `INSERT … ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x` against the existing
   * UNIQUE(tenantId, agentId, period_month) is race-safe — the running total can
   * never be lost. Runs inside the caller's transaction.
   *
   * AGENT-OPTIONAL. Callers used to skip this entirely when a turn had no agent
   * (`if (agent) recordUsage(...)`), so every guest/public turn and every turn
   * on a tenant with no Admin-provisioned agent went UNRECORDED. `agentId` is
   * nullable on the table, so those turns are now recorded with a NULL agent.
   *
   * The NULL case needs its own upsert: Postgres treats NULLs as DISTINCT in a
   * unique index, so `ON CONFLICT ("tenantId","agentId",period_month)` can never
   * match a NULL-agent row and would insert a fresh row per turn. It is done as
   * UPDATE-then-INSERT instead. Two concurrent first-turns of a period can both
   * miss the UPDATE and insert, leaving two rows for that period — no tokens are
   * lost (every reader aggregates with `SUM(...)`, and `topAgents` filters
   * `agent IS NOT NULL`), it is only an extra row. Removing even that would take
   * a partial unique index on (tenantId, period_month) WHERE agentId IS NULL,
   * which is schema surface this fix does not need.
   */
  private async recordUsage(
    manager: EntityManager,
    tenantId: string,
    agentId: string | null,
    tokens: number,
  ): Promise<void> {
    const period = currentPeriodMonth();

    if (agentId === null) {
      const result: unknown = await manager.query(
        `UPDATE ai_usage_logs
            SET total_tokens   = total_tokens   + $3,
                total_requests = total_requests + 1
          WHERE "tenantId" = $1 AND "agentId" IS NULL AND period_month = $2
        RETURNING id`,
        [tenantId, period, tokens],
      );
      // TypeORM's Postgres driver answers an UPDATE … RETURNING with a TUPLE,
      // `[rows, affectedCount]`, not the bare row array a SELECT gives. This used
      // to read `.length` of the tuple — always 2 — so it took "the row exists"
      // as a fact and returned, and the INSERT below never ran: no agent-less turn
      // (every guest turn, every clinic without an agent) was ever written to
      // `ai_usage_logs`, so the clinic's AI usage analytics for them stayed empty.
      const touched =
        Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
      if (Array.isArray(touched) && touched.length > 0) return;

      await manager.query(
        `INSERT INTO ai_usage_logs ("tenantId", "agentId", period_month, total_tokens, total_requests)
         VALUES ($1, NULL, $2, $3, 1)`,
        [tenantId, period, tokens],
      );
      return;
    }

    await manager.query(
      `INSERT INTO ai_usage_logs ("tenantId", "agentId", period_month, total_tokens, total_requests)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT ("tenantId", "agentId", period_month)
       DO UPDATE SET total_tokens   = ai_usage_logs.total_tokens   + EXCLUDED.total_tokens,
                     total_requests = ai_usage_logs.total_requests + 1`,
      [tenantId, agentId, period, tokens],
    );
  }

  /**
   * Single pricing formula — shared by `recordCost` and the metrics recorder.
   *
   * Takes one options object rather than a positional list: this call carries
   * the turn's identity (tenant/conversation/key), its attribution (feature,
   * route, channel) AND its processing descriptor (execution mode + residency
   * region), and a nine-plus-argument positional signature made every added
   * dimension a silent mis-ordering risk at three call sites.
   */
  private async recordCompletionCost(input: {
    tenantId: string;
    aiConversationId: string;
    requestKey: string;
    channel: string;
    route: string;
    feature: AiFeature;
    loop: number;
    provider: string;
    completion: Pick<
      AiCompletionResult,
      | 'model'
      | 'promptTokens'
      | 'completionTokens'
      | 'cachedPromptTokens'
      | 'cacheWriteTokens'
      | 'providerAttempts'
    >;
    accounting: TurnAccounting;
    processing: ProcessingDescriptor;
  }): Promise<void> {
    const {
      tenantId,
      aiConversationId,
      requestKey,
      channel,
      route,
      feature,
      loop,
      provider,
      completion,
      accounting,
      processing,
    } = input;
    // Priced at the rate set for THIS turn's processing dimensions. A residency
    // turn against a model with no residency rates comes back UNPRICED rather
    // than billed at the global rate — the same guarantee batch already had.
    const quote = this.costs.quoteChat(
      completion.model,
      completion.promptTokens,
      completion.completionTokens,
      completion.cachedPromptTokens ?? 0,
      provider,
      processing.executionMode,
      processing.residencyRequired,
      // Costs nothing for every model that bills cache writes at the input rate;
      // charged as a surcharge only where the catalog declares a distinct rate.
      completion.cacheWriteTokens ?? 0,
    );
    await this.costs.record({
      tenantId,
      aiConversationId,
      idempotencyKey: `${requestKey}:chat:${loop}`,
      requestKind: 'CHAT',
      provider,
      model: completion.model,
      feature,
      route,
      channel,
      // G11: `ai_cost_entries` has carried these two columns since the batch
      // migration, but the chat path never populated them — so a turn processed
      // under an enforced regional deployment was still recorded as global.
      executionMode: processing.executionMode,
      region: processing.region,
      inputTokens: completion.promptTokens,
      cachedInputTokens: completion.cachedPromptTokens ?? 0,
      cacheWriteTokens: completion.cacheWriteTokens ?? 0,
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
        feature,
        route,
        channel,
        executionMode: processing.executionMode,
        region: processing.region,
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

  /**
   * A stored idempotent response may only be replayed into the conversation
   * that produced it.
   *
   * The request ledger is keyed by `(tenant, idempotencyKey)` and the key is
   * client-supplied. The conversation this call names has already been proven
   * to be the caller's, but nothing tied the KEY to it — so a caller who
   * presented a key belonging to a different conversation in the same tenant
   * was handed that conversation's stored reply, including its last tool
   * result (a booking confirmation carries the appointment id and payment
   * link). Every anonymous visitor shares one tenant, which makes that a
   * visitor-to-visitor boundary rather than a same-clinic one. Refused with the
   * same CONFLICT an in-flight duplicate gets, so the answer says nothing about
   * whose key it was.
   */
  private assertReplayBelongsTo(
    replay: { message?: { ai_conversation_id?: string } | null },
    aiConversationId: string,
  ): void {
    if (replay.message?.ai_conversation_id === aiConversationId) return;
    throw new AppError(ErrorCode.CONFLICT, {
      message: 'This idempotency key was already used for a different request.',
    });
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
