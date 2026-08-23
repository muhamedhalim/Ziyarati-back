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
import { AiChannel, AiSession } from './ai-channel.constants';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

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
  /**
   * Ids of files the visitor uploaded through the guest attachment endpoint
   * and wants this turn to consider. Opaque and safe to accept from a client:
   * they are redeemed against a staging key derived from the CALLER's own
   * verified subject, single-use, and every value the model ends up seeing
   * (filename, extracted text) was produced server-side at upload time.
   */
  attachmentIds?: string[];
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
  origin?: { waMessageId?: string; messageType?: string };
  idempotencyKey?: string;
}

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
  ) {}

  /** Synchronous turn (REST). Delegates to the engine's sendMessage. */
  async handle(tenantId: string, input: OrchestrateInput) {
    const transport = input.channel === 'WHATSAPP' ? 'WHATSAPP' : 'REST';
    const { conversationId, session, routedRole, handedOver, memoryLoader } =
      await this.prepare(tenantId, input, transport);
    if (handedOver) {
      await this.execution.recordInboundWhileHandedOver(
        tenantId,
        conversationId,
        input.content,
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
        attachmentIds: input.attachmentIds,
      },
      transport,
      memoryLoader,
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
    const transport = input.channel === 'WHATSAPP' ? 'WHATSAPP' : 'WEBSOCKET';
    const { conversationId, session, routedRole, handedOver, memoryLoader } =
      await this.prepare(tenantId, input, transport);
    if (handedOver) {
      await this.execution.recordInboundWhileHandedOver(
        tenantId,
        conversationId,
        input.content,
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
        attachmentIds: input.attachmentIds,
      },
      onToken,
      input.origin,
      transport,
      memoryLoader,
      onToolEvent,
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
