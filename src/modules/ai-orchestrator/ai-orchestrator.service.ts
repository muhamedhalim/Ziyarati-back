import { Injectable, Logger } from '@nestjs/common';

import { AiConversationService } from '../ai/ai-conversation.service';
import { AiConversationAccessService } from '../ai/ai-conversation-access.service';
import {
  AiExecutionService,
  type AiToolProgressListener,
} from '../ai/ai-execution.service';
import { ConversationSessionService } from './conversation-session.service';
import { AgentRouterService } from './agent-router.service';
import { AiMemoryService } from '../ai-memory/ai-memory.service';
import { AI_CHANNELS, AiChannel, AiSession } from './ai-channel.constants';
import { AppError, ErrorCode } from '../../common/errors';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { HandoverRequestService } from '../ai/handover-request.service';
import { promisesHumanContact } from './human-contact-promise.util';

export interface OrchestrateInput {
  channel: AiChannel;
  content: string;
  /** Resume an existing session; when absent a new channel-scoped one is created. */
  aiConversationId?: string;
  /** Bind a new session to an agent + unified messaging conversation. */
  agentId?: string;
  conversationId?: string;
  language?: string;
  device?: string;
  timezone?: string;
  /** When true, re-route to the best specialized agent on every turn (Feature 7). */
  autoRoute?: boolean;
  /** When true, recall long-term memory for this turn and attach it to context (Feature 5). */
  useMemory?: boolean;
  /** Client-provided session updates (e.g. user picked a clinic in the UI). */
  sessionPatch?: Partial<AiSession>;
  /**
   * Provider facts about the inbound message, when it arrived over a real
   * messaging channel (currently WhatsApp): the `wamid` and the media type.
   *
   * Set ONLY by trusted server-side bridges (the WhatsApp webhook worker) — it
   * is not part of any HTTP-bound DTO, because `waMessageId` is a uniqueness /
   * de-duplication key that a client must not be able to assert.
   */
  origin?: {
    waMessageId?: string;
    messageType?: string;
    /** Epoch ms after which no further tool round starts (WhatsApp turns). */
    deadlineAt?: number;
  };
  /**
   * Session updates from a TRUSTED SERVER-SIDE CALLER, applied UNFILTERED —
   * unlike `sessionPatch`, which always passes through
   * `ConversationSessionService.patchFromClient` and therefore has
   * `SESSION_CONTEXT_SERVER_ONLY_KEYS` (e.g. `context.customerId`) stripped
   * out before it ever reaches the session.
   *
   * Set ONLY by trusted server-side bridges (the WhatsApp webhook worker,
   * binding the WhatsApp contact's own linked Customer) — same trust model
   * and same reason as `origin` above: it is not part of any HTTP-bound DTO,
   * because `context.customerId` is the server-bound booking subject
   * (`AiExecutionService.sessionCustomerId`) that every write tool prefers
   * over a model-supplied id. A client-writable path here would let a
   * WhatsApp turn's `sessionPatch` silently rebind the conversation's
   * booking subject to an arbitrary customer id — exactly the customer-
   * impersonation gap this field exists to close (the WhatsApp bridge is the
   * only caller today; it previously bound the customer through the ordinary
   * `sessionPatch`, where `patchFromClient` discarded it before it could
   * ever reach the session).
   */
  trustedSessionPatch?: Partial<AiSession>;
  /**
   * F-13. Set ONLY by a trusted server-side bridge that genuinely IS the channel
   * it names (today: the WhatsApp webhook worker) — never bound from a DTO or a
   * socket frame, same trust model as `origin` and `trustedSessionPatch` above.
   *
   * `channel` is the one field a client fills in for itself, and it chooses the
   * prompt, the toolset, the metering route and (through routing) the model
   * tier. Without this, any dashboard user could send `channel: 'WHATSAPP'` and
   * be handed the WhatsApp assistant. A channel a bridge owns is now accepted
   * only from that bridge.
   */
  trustedChannel?: boolean;
  idempotencyKey?: string;
}

/**
 * F-13. Channels a client may NAME for itself, by who it is.
 *
 * An anonymous visitor reaches the AI from exactly one place — the public
 * website widget — so that is the only channel it may claim. Everything else in
 * `AI_CHANNELS` is open to a signed-in staff principal except the channels a
 * bridge owns (`BRIDGE_OWNED_CHANNELS`).
 */
const GUEST_CHANNELS: readonly AiChannel[] = ['WEBSITE'];
const BRIDGE_OWNED_CHANNELS: readonly AiChannel[] = ['WHATSAPP'];

/**
 * AI Orchestrator (Phase 2) — the SINGLE cross-channel entry point for AI
 * execution. Every channel (website, dashboard, WhatsApp, REST, future
 * mobile/voice) funnels through `handle()`:
 *
 *   resolve/create channel-scoped conversation → load + patch session →
 *   delegate to the existing engine (AiExecutionService: intent-free RAG +
 *   tool-calling + provider + usage/cost metering) → return a unified envelope.
 *
 * It is NOT another AI service: it owns NO RAG, NO provider calls, NO booking,
 * NO metering. All of that stays in `AiExecutionService` — the orchestrator only
 * coordinates channel + session around it, so no controller calls a provider
 * directly. Adding a new channel = calling `handle()` with a new `channel` value.
 */
@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger(AiOrchestratorService.name);

  constructor(
    private readonly conversations: AiConversationService,
    private readonly execution: AiExecutionService,
    private readonly sessions: ConversationSessionService,
    private readonly router: AgentRouterService,
    private readonly memory: AiMemoryService,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly access: AiConversationAccessService,
    private readonly handovers: HandoverRequestService,
  ) {}

  /**
   * F-13: the server, not the client, decides which channel a caller may run as.
   *
   * Checked here — the one place the REST controller, the WebSocket gateway and
   * the WhatsApp bridge all funnel through — so a fourth transport inherits it.
   * Throws before any conversation, message or metering row is written.
   */
  private assertChannelAllowed(input: OrchestrateInput): void {
    if (!AI_CHANNELS.includes(input.channel)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Unknown channel',
      });
    }
    const forbidden = () =>
      new AppError(ErrorCode.FORBIDDEN, {
        message: 'This channel is not available to the caller',
      });
    if (
      BRIDGE_OWNED_CHANNELS.includes(input.channel) &&
      input.trustedChannel !== true
    ) {
      throw forbidden();
    }
    if (
      this.tenantContext.getUser()?.guest &&
      !GUEST_CHANNELS.includes(input.channel)
    ) {
      throw forbidden();
    }
  }

  /** Synchronous turn (REST). Delegates to the engine's sendMessage. */
  async handle(tenantId: string, input: OrchestrateInput) {
    this.assertChannelAllowed(input);
    const transport = input.channel === 'WHATSAPP' ? 'WHATSAPP' : 'REST';
    const { conversationId, session, routedRole, handedOver, memoryLoader } =
      await this.prepare(tenantId, input, transport);
    if (handedOver) {
      await this.execution.recordInboundWhileHandedOver(
        tenantId,
        conversationId,
        input.content,
        input.origin,
      );
      return this.handedOverEnvelope(
        input.channel,
        conversationId,
        session,
        routedRole,
      );
    }
    const result = await this.execution.sendMessage(
      tenantId,
      conversationId,
      {
        content: input.content,
        idempotencyKey: input.idempotencyKey,
      },
      transport,
      memoryLoader,
    );
    await this.maybeEscalateOnPromisedContact(
      tenantId,
      conversationId,
      result.message.content,
    );
    return {
      channel: input.channel,
      aiConversationId: conversationId,
      agentRole: session.currentAgentRole ?? routedRole ?? null,
      session,
      reply: {
        id: result.message.id,
        role: result.message.role,
        content: result.message.content,
        createdAt: result.message.created_at,
      },
      usage: result.usage,
      retrievedChunks: result.retrievedChunks,
      fallback: result.fallback,
      lastTool: result.lastTool,
      handedOver: false as const,
    };
  }

  /** Whether a turn keyed `key` (a WhatsApp wamid) already started: a replay. */
  hasRequestClaim(tenantId: string, key: string): Promise<boolean> {
    return this.execution.hasRequestClaim(tenantId, key);
  }

  /**
   * Streaming turn (WebSocket, Feature 2). SAME orchestration (channel/session/
   * routing/memory) as `handle`, but delegates to the engine's `streamMessage`
   * so tokens flow to `onToken` as they are produced. The gateway calls THIS —
   * it never touches AiExecutionService directly.
   *
   * Live Agent Handover (#12 AI Pause): when the conversation is HANDED_OVER,
   * neither `sendMessage` nor `streamMessage` is called — the model must not
   * execute tools or answer. The inbound message is still persisted (both into
   * the AI's own history and the unified timeline) via
   * `AiExecutionService.recordInboundWhileHandedOver`, so nothing is lost and a
   * later "Return to AI" sees the full conversation with zero gaps.
   */
  async handleStream(
    tenantId: string,
    input: OrchestrateInput,
    onToken: (delta: string) => void,
    /**
     * Optional per-tool progress signal, passed straight through to the
     * engine. Trailing and optional so no existing caller changes.
     */
    onToolEvent?: AiToolProgressListener,
  ) {
    this.assertChannelAllowed(input);
    const transport = input.channel === 'WHATSAPP' ? 'WHATSAPP' : 'WEBSOCKET';
    const { conversationId, session, routedRole, handedOver, memoryLoader } =
      await this.prepare(tenantId, input, transport);
    if (handedOver) {
      await this.execution.recordInboundWhileHandedOver(
        tenantId,
        conversationId,
        input.content,
        input.origin,
      );
      return this.handedOverEnvelope(
        input.channel,
        conversationId,
        session,
        routedRole,
      );
    }
    const result = await this.execution.streamMessage(
      tenantId,
      conversationId,
      {
        content: input.content,
        idempotencyKey: input.idempotencyKey ?? input.origin?.waMessageId,
      },
      onToken,
      input.origin,
      transport,
      memoryLoader,
      onToolEvent,
    );
    await this.maybeEscalateOnPromisedContact(
      tenantId,
      conversationId,
      result.message.content,
    );
    return {
      channel: input.channel,
      aiConversationId: conversationId,
      agentRole: session.currentAgentRole ?? routedRole ?? null,
      session,
      reply: {
        id: result.message.id,
        role: result.message.role,
        content: result.message.content,
        createdAt: result.message.created_at,
      },
      usage: result.usage,
      retrievedChunks: result.retrievedChunks,
      streamed: result.streamed,
      lastTool: result.lastTool,
      // FND-023 — the mirrored BOT reply's timeline-message id (or null),
      // passed straight through so a channel bridge (e.g.
      // WhatsappInboundAiService.sendReply) can attach the provider message
      // id once its own send completes.
      mirroredMessageId: result.mirroredMessageId,
      handedOver: false as const,
    };
  }

  /**
   * Persists an inbound message the assistant must NOT answer, without calling
   * the model: into the AI's own history (so nothing is missing if the
   * conversation is later returned to the AI) and, when a person is assigned, a
   * "customer replied" notification for them.
   *
   * For a caller that has already decided — through its own policy check — that
   * a person owns the conversation. It is the same persistence a HANDED_OVER
   * turn performs inside `handle`/`handleStream`, reached before the turn
   * instead of from within it; no parallel path.
   */
  recordInboundWithoutAnswer(
    tenantId: string,
    aiConversationId: string,
    content: string,
    origin?: OrchestrateInput['origin'],
  ) {
    return this.execution.recordInboundWhileHandedOver(
      tenantId,
      aiConversationId,
      content,
      origin,
    );
  }

  /**
   * Live Agent Handover's SECOND trigger: the assistant told the patient a
   * clinic person will contact them, without calling `request_human_handover`
   * itself. Runs on the FINAL reply of every turn, for both `handle` and
   * `handleStream` — the one place both channels converge.
   *
   * Deliberately reuses `HandoverRequestService.requestForCustomer` — the
   * EXACT method the tool (`AiToolDispatchService.requestHumanHandover`) and
   * the socket's `ai:handover` event already call. That keeps this a second
   * TRIGGER for the same one escalation path, not a second notification
   * mechanism: the same domain event, the same realtime broadcast, and the
   * same persisted internal notification fire either way.
   *
   * Guarded on the conversation's CURRENT status (re-read fresh, not the
   * turn's own `handedOver: false` envelope constant) so this never fires
   * twice for one escalation: if `request_human_handover` already ran earlier
   * in this same turn, the conversation is already HANDED_OVER by the time
   * this runs, and `create()`'s own idempotency guard covers everything else
   * (a retried/duplicated turn, a double-tap on the same message).
   *
   * Never allowed to fail the turn: the reply was already sent to the patient.
   */
  private async maybeEscalateOnPromisedContact(
    tenantId: string,
    aiConversationId: string | undefined,
    replyContent: string | null | undefined,
  ): Promise<void> {
    if (!aiConversationId || !promisesHumanContact(replyContent)) return;
    try {
      const aiConv = await this.conversations.findOne(tenantId, aiConversationId);
      if (aiConv.status === AI_CONVERSATION_STATUS.HANDED_OVER) return;
      await this.handovers.requestForCustomer(tenantId, this.tenantContext.getUser(), {
        aiConversationId,
        reason:
          'Auto-detected: the assistant told the patient the clinic would contact them.',
      });
    } catch (err) {
      this.logger.warn(
        `Auto-escalation on a promised human callback failed (aiConversationId=${aiConversationId}): ${(err as Error)?.message}`,
      );
    }
  }

  /** Shared envelope for a turn that was persisted but NOT answered (handed over). */
  private handedOverEnvelope(
    channel: AiChannel,
    conversationId: string,
    session: AiSession,
    routedRole: string | null,
  ) {
    return {
      channel,
      aiConversationId: conversationId,
      agentRole: session.currentAgentRole ?? routedRole ?? null,
      session,
      reply: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      retrievedChunks: 0,
      streamed: false,
      lastTool: undefined,
      // No bot reply is sent when handed over (see class docblock) — nothing
      // to attach a provider id to.
      mirroredMessageId: null,
      handedOver: true as const,
    };
  }

  /**
   * Shared orchestration: resolve/create the channel-scoped conversation (routing
   * a specialized agent on first turn — Feature 7), omnichannel touch (Phase 3),
   * optional per-turn re-routing, and opt-in long-term memory recall (Feature 5).
   * Returns the conversation id + merged session. No provider/RAG/booking here.
   */
  private async prepare(
    tenantId: string,
    input: OrchestrateInput,
    transport: 'REST' | 'WEBSOCKET' | 'WHATSAPP',
  ) {
    let routedRole: string | null = null;
    let conv;
    if (input.aiConversationId) {
      // F-1: resuming is the one path where the conversation id is CLIENT-supplied,
      // so tenant scoping alone is not an ownership check — every anonymous
      // visitor shares the single guest discovery tenant. `assertAccess` adds the
      // FND-001 `guestSubject` comparison for guest principals and raises the same
      // NOT_FOUND an unknown id raises, so it leaks nothing.
      conv = await this.access.assertAccess(
        tenantId,
        input.aiConversationId,
        this.tenantContext.getUser(),
      );
      // A trusted bridge that owns the unified-timeline thread binds a resumed
      // session to it the first time it knows the thread (a WhatsApp session
      // that predates timeline storage has none). `trustedChannel` is the same
      // server-only flag that gates BRIDGE_OWNED_CHANNELS — `conversationId` is
      // client-fillable on the HTTP/WS DTOs, so an untrusted caller can never
      // re-bind a session through here. Compare-and-set: an already-linked
      // session (e.g. to a handover thread) is left alone.
      if (
        input.trustedChannel === true &&
        input.conversationId &&
        !conv.conversation
      ) {
        await this.conversations.linkTimelineConversation(
          tenantId,
          conv.id,
          input.conversationId,
        );
      }
    } else {
      let agentId = input.agentId;
      if (!agentId) {
        const routed = await this.router.route(tenantId, input.content);
        agentId = routed.agentId ?? undefined;
        routedRole = routed.role;
      }
      conv = await this.conversations.start(tenantId, {
        agentId,
        conversationId: input.conversationId,
      });
      // FND-001: bind an anonymous guest conversation to the guest session that
      // created it. Guest conversion later requires this to equal the `sub` of
      // the presented `guest_token`, which is what stops one guest converting
      // another guest's conversation inside the shared discovery tenant. The
      // principal is server-verified (WsAuthService checks the signature before
      // setting `guest`); nothing here is client-asserted.
      const principal = this.tenantContext.getUser();
      if (principal?.guest && principal.id) {
        await this.sessions.patch(tenantId, conv.id, {
          guestSubject: principal.id,
        });
      }
      if (routedRole)
        await this.sessions.setAgent(
          tenantId,
          conv.id,
          conv.agent?.id ?? null,
          routedRole,
        );
    }

    await this.sessions.touchChannel(tenantId, conv.id, {
      channel: input.channel,
      language: input.language,
      device: input.device,
      timezone: input.timezone,
    });
    // N-1: a client patch may never write `guestSubject` (the ownership binding
    // `assertAccess` relies on), the `selected*` booking state, or
    // `context.customerId` — see SESSION_CLIENT_PATCHABLE_KEYS.
    if (input.sessionPatch)
      await this.sessions.patchFromClient(
        tenantId,
        conv.id,
        input.sessionPatch,
      );

    // Applied AFTER (and therefore winning over) any client-controlled
    // `sessionPatch` above, and UNFILTERED (`patch`, not `patchFromClient`) —
    // see `trustedSessionPatch`'s own docblock on OrchestrateInput. Re-applied
    // on every turn, not only when a conversation is first created: a
    // WhatsApp contact's `ai_conversation_id` is resumed on every later
    // inbound message, and re-asserting the binding each turn is a cheap,
    // idempotent merge that also self-heals if anything else ever cleared it.
    if (input.trustedSessionPatch)
      await this.sessions.patch(tenantId, conv.id, input.trustedSessionPatch);

    if (input.autoRoute && input.aiConversationId) {
      const current = await this.sessions.get(tenantId, conv.id);
      const routed = await this.router.route(tenantId, input.content, current);
      if (routed.agentId && routed.agentId !== conv.agent?.id) {
        await this.sessions.setAgent(
          tenantId,
          conv.id,
          routed.agentId,
          routed.role ?? undefined,
        );
        routedRole = routed.role;
      }
    }

    const current = await this.sessions.get(tenantId, conv.id);
    const memoryEnabled =
      input.useMemory &&
      String(this.config.get('AI_MEMORY_RECALL_ENABLED', 'false')) === 'true' &&
      current.context?.memoryConsent === true;
    await this.sessions.patch(tenantId, conv.id, {
      context: { ...(current.context ?? {}), recalledMemories: [] },
    });
    const session = await this.sessions.get(tenantId, conv.id);
    const memoryLoader = memoryEnabled
      ? async () => {
          const recalled = await this.memory
            .recall(
              tenantId,
              {
                query: input.content,
                limit: 5,
                customerId: current.context?.customerId as string | undefined,
              },
              {
                channel: transport,
                aiConversationId: conv.id,
                idempotencyKey: input.idempotencyKey
                  ? `${input.idempotencyKey}:memory`
                  : undefined,
              },
            )
            .catch(() => []);
          const items = recalled.map((m) => ({
            type: m.type,
            content: m.content,
            score: m.score,
          }));
          await this.sessions.patch(tenantId, conv.id, {
            context: { ...(current.context ?? {}), recalledMemories: items },
          });
          session.context = {
            ...(session.context ?? {}),
            recalledMemories: items,
          };
          return items;
        }
      : undefined;
    return {
      conversationId: conv.id,
      session,
      routedRole,
      handedOver: conv.status === AI_CONVERSATION_STATUS.HANDED_OVER,
      memoryLoader,
    };
  }
}
