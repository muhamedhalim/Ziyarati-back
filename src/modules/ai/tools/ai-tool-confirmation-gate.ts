import { randomUUID } from 'node:crypto';

import type { ConversationSessionService } from '../../ai-orchestrator/conversation-session.service';
import type { ToolContext } from './ai-tool-dispatch.service';

/** How long a proposed irreversible action stays confirmable. */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * AI-019/F1/PD-1: the application-issued confirmation gate for irreversible
 * actions (cancel / move). Extracted verbatim from `AiToolDispatchService`; a
 * plain class so the dispatcher's constructor is unchanged.
 */
export class AiToolConfirmationGate {
  constructor(private readonly sessions: ConversationSessionService) {}

  /**
   * Has the person confirmed the exact action in `key`?
   *
   * The application recorded the proposal itself (`issue`), keyed to
   * this conversation, the action and the appointment (and, for a move, the new
   * time), together with the user message it was made in. It counts as confirmed
   * only when ALL of these hold — the model's say-so is never read (FR-073):
   *  - a live, unexpired proposal exists for exactly this key;
   *  - it was made in an EARLIER user turn than this call (F-04). Within one turn
   *    the model could otherwise propose and "confirm" on the patient's behalf
   *    with no human reply in between, which is the gate defeating itself;
   *  - this call can prove its own turn (`ctx.turnId`).
   * Confirmed consumes the proposal, so one "yes" authorises one execution. An
   * expired proposal is dropped so a later call starts clean. A same-turn call
   * leaves the proposal in place — the question is still waiting for its answer.
   *
   * Deliberately takes no token: a tool result does not survive into the next
   * turn, so a model asked to hand one back could not, and every genuine "yes"
   * then read as a fresh request (F-27). Nothing is lost — the token was only
   * ever as trustworthy as the model that carried it.
   */
  async verify(
    ctx: ToolContext,
    key: string,
  ): Promise<'confirmed' | 'same_turn' | 'none'> {
    const session = await this.sessions.get(ctx.tenantId, ctx.aiConversationId);
    const pending = session.pendingConfirmations?.[key];
    if (!pending) return 'none';
    const remaining = { ...(session.pendingConfirmations ?? {}) };
    if (!(new Date(pending.expiresAt).getTime() > Date.now())) {
      delete remaining[key];
      await this.sessions.patch(ctx.tenantId, ctx.aiConversationId, {
        pendingConfirmations: remaining,
      });
      return 'none';
    }
    if (!ctx.turnId || !pending.turnId || pending.turnId === ctx.turnId) {
      return 'same_turn';
    }
    delete remaining[key];
    await this.sessions.patch(ctx.tenantId, ctx.aiConversationId, {
      pendingConfirmations: remaining,
    });
    return 'confirmed';
  }

  /**
   * Records what is being proposed for this (conversation, action, appointment)
   * and the turn it was proposed in, so a LATER turn's identical call can be
   * independently verified. Returns the token for callers that still carry one.
   */
  async issue(ctx: ToolContext, key: string): Promise<string> {
    const token = randomUUID();
    const session = await this.sessions.get(ctx.tenantId, ctx.aiConversationId);
    await this.sessions.patch(ctx.tenantId, ctx.aiConversationId, {
      pendingConfirmations: {
        ...(session.pendingConfirmations ?? {}),
        [key]: {
          token,
          expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
          turnId: ctx.turnId,
        },
      },
    });
    return token;
  }
}
