import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { AppError, ErrorCode } from '../../common/errors';
import { AiChannel, AiSession, CHANNEL_HISTORY_CAP } from './ai-channel.constants';

/**
 * Conversation Session Manager (Phase 5).
 *
 * Owns the ACTIVE state of an AI conversation (selected clinic/branch/doctor,
 * current intent, language, current booking draft, auth state, working context).
 * State lives inline on `ai_conversations.session` (jsonb) so a turn reads it
 * without an extra table; this service is the single place it is merged.
 *
 * This is NOT long-term memory (that is Phase 7, a separate embeddings store).
 * Tenant isolation: every read/write is tenant-scoped on the conversation.
 */
@Injectable()
export class ConversationSessionService {
  constructor(
    @InjectRepository(AiConversation)
    private readonly conversations: Repository<AiConversation>,
  ) {}

  /** Current session state (empty object when none yet). */
  async get(tenantId: string, aiConversationId: string): Promise<AiSession> {
    const conv = await this.load(tenantId, aiConversationId);
    return (conv.session as AiSession) ?? {};
  }

  /** Shallow-merge a partial session patch and persist it. Returns the merged state. */
  async patch(
    tenantId: string,
    aiConversationId: string,
    partial: Partial<AiSession>,
  ): Promise<AiSession> {
    const conv = await this.load(tenantId, aiConversationId);
    const current = (conv.session as AiSession) ?? {};
    const cleaned = this.clean(partial);
    const merged: AiSession = {
      ...current,
      ...cleaned,
      ...(cleaned.context
        ? { context: { ...(current.context ?? {}), ...cleaned.context } }
        : {}),
    };
    conv.session = merged as Record<string, unknown>;
    await this.conversations.save(conv);
    return merged;
  }

  /**
   * Omnichannel touch (Feature 3): records that this turn arrives on `channel`,
   * maintaining active/last channel + a capped channel-switch history so ONE
   * conversation continues seamlessly across WhatsApp / website / dashboard.
   * Also mirrors language/device/timezone into the session for tool access.
   */
  async touchChannel(
    tenantId: string,
    aiConversationId: string,
    meta: { channel: AiChannel; language?: string; device?: string; timezone?: string },
  ): Promise<AiSession> {
    const conv = await this.load(tenantId, aiConversationId);
    const session: AiSession = { ...(conv.session as AiSession) };

    if (session.activeChannel && session.activeChannel !== meta.channel) {
      session.lastChannel = session.activeChannel;
    }
    session.activeChannel = meta.channel;
    const history = session.channelHistory ?? [];
    if (history[history.length - 1]?.channel !== meta.channel) {
      history.push({ channel: meta.channel, at: new Date().toISOString() });
    }
    session.channelHistory = history.slice(-CHANNEL_HISTORY_CAP);
    if (meta.language) session.language = meta.language;
    if (meta.device) session.device = meta.device;
    if (meta.timezone) session.timezone = meta.timezone;

    conv.channel = meta.channel;
    if (meta.language) conv.language = meta.language;
    conv.session = session as Record<string, unknown>;
    await this.conversations.save(conv);
    return session;
  }

  /**
   * Bind (or clear) the conversation's active agent — used by the agent router
   * (Feature 7) so a turn runs under the right specialized agent. The engine
   * reloads the conversation each turn, so this switch takes effect immediately
   * WITHOUT modifying AiExecutionService.
   */
  async setAgent(
    tenantId: string,
    aiConversationId: string,
    agentId: string | null,
    role?: string,
  ): Promise<void> {
    const conv = await this.load(tenantId, aiConversationId);
    conv.agent = agentId ? ({ id: agentId } as AiAgent) : undefined;
    if (role) {
      conv.session = { ...(conv.session as AiSession), currentAgentRole: role } as Record<string, unknown>;
    }
    await this.conversations.save(conv);
  }

  /** Clear the session (e.g. after a completed booking flow). */
  async reset(tenantId: string, aiConversationId: string): Promise<void> {
    const conv = await this.load(tenantId, aiConversationId);
    conv.session = null as unknown as Record<string, unknown>;
    await this.conversations.save(conv);
  }

  private async load(tenantId: string, aiConversationId: string): Promise<AiConversation> {
    const conv = await this.conversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
    });
    if (!conv) throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI conversation not found' });
    return conv;
  }

  /** Drop undefined keys so a patch never overwrites state with `undefined`. */
  private clean(partial: Partial<AiSession>): Partial<AiSession> {
    return Object.fromEntries(
      Object.entries(partial).filter(([, v]) => v !== undefined),
    ) as Partial<AiSession>;
  }
}
