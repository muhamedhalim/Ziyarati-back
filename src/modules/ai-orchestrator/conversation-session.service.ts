import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { AppError, ErrorCode } from '../../common/errors';
import {
  AiChannel,
  AiSession,
  CHANNEL_HISTORY_CAP,
  SESSION_CLIENT_PATCHABLE_KEYS,
  SESSION_CONTEXT_SERVER_ONLY_KEYS,
} from './ai-channel.constants';

/**
 * AI-006: sentinel a trusted server caller passes to `patch()` to explicitly
 * UNSET a key — distinct from `undefined`, which `clean()` drops precisely
 * to PRESERVE the key's existing value. `selectClinic`'s reset intent
 * ("a new clinic invalidates every downstream choice") used `undefined` for
 * this and silently never worked, because that is what `undefined` means to
 * `clean()` for every other caller.
 *
 * `null`, not a unique symbol (R11 rollback constraint): it round-trips
 * through the `session` jsonb column, and `clean()`'s filter — `v !==
 * undefined` — already lets `null` pass through unfiltered today, before
 * this change. So a rollback of the CALLING code back to writing
 * `SESSION_UNSET` still stores exactly what it intended, and every existing
 * reader of `selected*` fields already treats a `null`/absent value as "not
 * selected" via a plain truthy check — nothing downstream needs to change
 * for the sentinel to be tolerated by pre-change code.
 */
export const SESSION_UNSET = null;

/**
 * `patch()`'s input shape: every `AiSession` key may be set to its normal
 * value, left absent (preserves the current value), or explicitly
 * `SESSION_UNSET` (clears it). `Partial<AiSession>` remains assignable here,
 * so every existing caller (including `patchFromClient`) is unaffected.
 */
export type SessionPatch = {
  [K in keyof AiSession]?: AiSession[K] | typeof SESSION_UNSET;
};

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
    partial: SessionPatch,
  ): Promise<AiSession> {
    const conv = await this.load(tenantId, aiConversationId);
    const current = (conv.session as AiSession) ?? {};
    const cleaned = this.clean(partial);
    const merged = {
      ...current,
      ...cleaned,
      ...(cleaned.context
        ? { context: { ...(current.context ?? {}), ...cleaned.context } }
        : {}),
    } as AiSession;
    // Re-asserting an unchanged value (the WhatsApp customer binding is applied
    // on every turn) must not cost a write.
    if (JSON.stringify(merged) === JSON.stringify(current)) return merged;
    conv.session = merged as Record<string, unknown>;
    await this.conversations.save(conv);
    return merged;
  }

  /**
   * The ONLY entry point any client-facing path may use to merge a session
   * patch — REST `PATCH /ai/orchestrator/:id/session`, and the orchestrator's
   * `input.sessionPatch`.
   *
   * `patch()` itself stays unfiltered because trusted server code legitimately
   * writes the protected keys (`touchChannel` → channel history, `prepare` →
   * `guestSubject`, the `select_*` booking tools → `selected*`). Splitting the
   * two is what lets the whitelist be strict without breaking those writers.
   */
  async patchFromClient(
    tenantId: string,
    aiConversationId: string,
    partial: Partial<AiSession>,
  ): Promise<AiSession> {
    return this.patch(
      tenantId,
      aiConversationId,
      this.stripServerOwned(partial),
    );
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
    meta: {
      channel: AiChannel;
      language?: string;
      device?: string;
      timezone?: string;
    },
  ): Promise<AiSession> {
    const conv = await this.load(tenantId, aiConversationId);
    const before = JSON.stringify(conv.session ?? {});
    const beforeChannel = conv.channel;
    const beforeLanguage = conv.language;
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
    // Same channel as last turn and nothing new to record: no write.
    if (
      JSON.stringify(session) === before &&
      conv.channel === beforeChannel &&
      conv.language === beforeLanguage
    ) {
      return session;
    }
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
      conv.session = {
        ...(conv.session as AiSession),
        currentAgentRole: role,
      } as Record<string, unknown>;
    }
    await this.conversations.save(conv);
  }

  /** Clear the session (e.g. after a completed booking flow). */
  async reset(tenantId: string, aiConversationId: string): Promise<void> {
    const conv = await this.load(tenantId, aiConversationId);
    conv.session = null as unknown as Record<string, unknown>;
    await this.conversations.save(conv);
  }

  private async load(
    tenantId: string,
    aiConversationId: string,
  ): Promise<AiConversation> {
    const conv = await this.conversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
    });
    if (!conv)
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'AI conversation not found',
      });
    return conv;
  }

  /**
   * Drop undefined keys so a patch never overwrites state with `undefined` —
   * unchanged for every caller (FR-020). A key set to the `SESSION_UNSET`
   * sentinel is NOT dropped (`null !== undefined`): it passes through and
   * overwrites the key's stored value, genuinely clearing it — which is
   * exactly what `undefined` was meant to do here and silently never did
   * (AI-006).
   */
  private clean(partial: SessionPatch): SessionPatch {
    return Object.fromEntries(
      Object.entries(partial).filter(([, v]) => v !== undefined),
    ) as SessionPatch;
  }

  /**
   * Whitelist a client-supplied patch down to
   * `SESSION_CLIENT_PATCHABLE_KEYS`, then strip the server-owned keys out of
   * its nested `context`. Unknown/protected keys are dropped SILENTLY rather
   * than rejected — a rejection would tell a prober which keys are
   * security-bearing.
   */
  private stripServerOwned(partial: Partial<AiSession>): Partial<AiSession> {
    const allowed = new Set<string>(SESSION_CLIENT_PATCHABLE_KEYS);
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(partial ?? {})) {
      if (!allowed.has(key)) continue;
      out[key] = value;
    }

    if (out.context && typeof out.context === 'object') {
      const context = { ...(out.context as Record<string, unknown>) };
      for (const key of SESSION_CONTEXT_SERVER_ONLY_KEYS) delete context[key];
      out.context = context;
    }

    return out as Partial<AiSession>;
  }
}
