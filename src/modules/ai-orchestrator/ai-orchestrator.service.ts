import { Injectable, Logger } from '@nestjs/common';

import { AiConversationService } from '../ai/ai-conversation.service';
import { AiExecutionService } from '../ai/ai-execution.service';
import { ConversationSessionService } from './conversation-session.service';
import { AgentRouterService } from './agent-router.service';
import { AiMemoryService } from '../ai-memory/ai-memory.service';
import { AiChannel, AiSession } from './ai-channel.constants';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';

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
  origin?: { waMessageId?: string; messageType?: string };
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
  ) {}

  /** Synchronous turn (REST). Delegates to the engine's sendMessage. */
  async handle(tenantId: string, input: OrchestrateInput) {
    const { conversationId, session, routedRole, handedOver } = await this.prepare(tenantId, input);
    if (handedOver) {
      await this.execution.recordInboundWhileHandedOver(tenantId, conversationId, input.content);
      return this.handedOverEnvelope(input.channel, conversationId, session, routedRole);
    }
    const result = await this.execution.sendMessage(tenantId, conversationId, { content: input.content });
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
  async handleStream(tenantId: string, input: OrchestrateInput, onToken: (delta: string) => void) {
    const { conversationId, session, routedRole, handedOver } = await this.prepare(tenantId, input);
    if (handedOver) {
      await this.execution.recordInboundWhileHandedOver(tenantId, conversationId, input.content);
      return this.handedOverEnvelope(input.channel, conversationId, session, routedRole);
    }
    const result = await this.execution.streamMessage(
      tenantId,
      conversationId,
      { content: input.content },
      onToken,
      input.origin,
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
      handedOver: true as const,
    };
  }

  /**
   * Shared orchestration: resolve/create the channel-scoped conversation (routing
   * a specialized agent on first turn — Feature 7), omnichannel touch (Phase 3),
   * optional per-turn re-routing, and opt-in long-term memory recall (Feature 5).
   * Returns the conversation id + merged session. No provider/RAG/booking here.
   */
  private async prepare(tenantId: string, input: OrchestrateInput) {
    let routedRole: string | null = null;
    let conv;
    if (input.aiConversationId) {
      conv = await this.conversations.findOne(tenantId, input.aiConversationId);
    } else {
      let agentId = input.agentId;
      if (!agentId) {
        const routed = await this.router.route(tenantId, input.content);
        agentId = routed.agentId ?? undefined;
        routedRole = routed.role;
      }
      conv = await this.conversations.start(tenantId, { agentId, conversationId: input.conversationId });
      if (routedRole) await this.sessions.setAgent(tenantId, conv.id, conv.agent?.id ?? null, routedRole);
    }

    await this.sessions.touchChannel(tenantId, conv.id, {
      channel: input.channel,
      language: input.language,
      device: input.device,
      timezone: input.timezone,
    });
    if (input.sessionPatch) await this.sessions.patch(tenantId, conv.id, input.sessionPatch);

    if (input.autoRoute && input.aiConversationId) {
      const current = await this.sessions.get(tenantId, conv.id);
      const routed = await this.router.route(tenantId, input.content, current);
      if (routed.agentId && routed.agentId !== conv.agent?.id) {
        await this.sessions.setAgent(tenantId, conv.id, routed.agentId, routed.role ?? undefined);
        routedRole = routed.role;
      }
    }

    if (input.useMemory) {
      const current = await this.sessions.get(tenantId, conv.id);
      const recalled = await this.memory
        .recall(tenantId, { query: input.content, limit: 5, customerId: current.context?.customerId as string | undefined })
        .catch(() => []);
      if (recalled.length) {
        await this.sessions.patch(tenantId, conv.id, {
          context: {
            ...(current.context ?? {}),
            recalledMemories: recalled.map((m) => ({ type: m.type, content: m.content, score: m.score })),
          },
        });
      }
    }

    const session = await this.sessions.get(tenantId, conv.id);
    return {
      conversationId: conv.id,
      session,
      routedRole,
      handedOver: conv.status === AI_CONVERSATION_STATUS.HANDED_OVER,
    };
  }
}
