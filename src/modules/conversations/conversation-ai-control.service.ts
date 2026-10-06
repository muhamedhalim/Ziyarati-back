import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';
import { ActivityAuditService } from '../activity-log/activity-audit.service';

import {
  CONVERSATION_AI_MODE,
  CONVERSATION_OWNER_TYPE,
  ConversationAiMode,
} from './conversation.constants';

/**
 * What staff see about the AI on one conversation. `effective` (would the AI
 * answer right now, and if not, why) is added by the caller from
 * `WhatsappAiPolicyService` — that service lives in the WhatsApp module, which
 * this module must not import.
 */
export interface ConversationAiStatus {
  conversationId: string;
  /** The staff override (`DEFAULT` follows the clinic setting). */
  mode: ConversationAiMode;
  /**
   * The automatic-takeover deadline while it is still in the future, else
   * `null`. An elapsed deadline is reported as `null`, not as a stale date.
   */
  pausedUntil: Date | null;
  changedAt: Date | null;
  changedBy: { id: string; name: string | null } | null;
  /** `HUMAN` = a handover is active; that is released with "Return to AI". */
  ownerType: string;
  /** The conversation's patient, so the caller can evaluate the patient rule. */
  customerId: string | null;
}

/** Audit action names. Allow-listed in `activity-allowlist.ts`. */
export const CONVERSATION_AI_AUDIT_ACTION = {
  PAUSED: 'conversation.ai_paused',
  RESUMED: 'conversation.ai_resumed',
} as const;

/**
 * Staff control of the WhatsApp AI on a single conversation: pause it, resume
 * it, and report where it stands.
 *
 * Pausing only sets `ai_mode`. It never touches the conversation's ownership
 * (`owner_type`) or its messages: the thread keeps receiving and showing the
 * patient's messages, staff keep replying, and the AI simply stays out. The
 * decision itself is taken, on the backend, by `WhatsappAiPolicyService`; this
 * service only records the staff's intent.
 *
 * Every method takes `tenantId` first and filters every read and write by it,
 * so a conversation id from another clinic is indistinguishable from a missing
 * one (404) — the id is never trusted on its own.
 */
@Injectable()
export class ConversationAiControlService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly audit: ActivityAuditService,
  ) {}

  async getStatus(
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationAiStatus> {
    const c = await this.conversations.findOne({
      where: { id: conversationId, tenant: { id: tenantId } },
      relations: { customer: true, ai_mode_changed_by: true },
      select: {
        id: true,
        owner_type: true,
        ai_mode: true,
        ai_paused_until: true,
        ai_mode_changed_at: true,
        customer: { id: true },
        ai_mode_changed_by: { id: true, full_name: true },
      },
    });
    if (!c) throw this.notFound();

    const pausedUntil = c.ai_paused_until ? new Date(c.ai_paused_until) : null;
    return {
      conversationId: c.id,
      mode: c.ai_mode as ConversationAiMode,
      pausedUntil:
        pausedUntil && pausedUntil.getTime() > Date.now() ? pausedUntil : null,
      changedAt: c.ai_mode_changed_at ?? null,
      changedBy: c.ai_mode_changed_by
        ? {
            id: c.ai_mode_changed_by.id,
            name: c.ai_mode_changed_by.full_name ?? null,
          }
        : null,
      ownerType: c.owner_type,
      customerId: c.customer?.id ?? null,
    };
  }

  /** Idempotent: pausing a paused conversation changes and audits nothing. */
  async pause(
    tenantId: string,
    actorUserId: string,
    conversationId: string,
  ): Promise<ConversationAiStatus> {
    const before = await this.getStatus(tenantId, conversationId);
    if (before.mode === CONVERSATION_AI_MODE.DISABLED) return before;

    await this.applyMode(
      tenantId,
      actorUserId,
      conversationId,
      CONVERSATION_AI_MODE.DISABLED,
    );
    await this.audit.record({
      tenantId,
      actorUserId,
      action: CONVERSATION_AI_AUDIT_ACTION.PAUSED,
      entityType: 'conversation',
      entityId: conversationId,
      before: { ai_mode: before.mode },
      after: { ai_mode: CONVERSATION_AI_MODE.DISABLED },
    });
    return this.getStatus(tenantId, conversationId);
  }

  /**
   * Back to the clinic default, and ends any automatic-takeover window. Refused
   * (409) while a handover is active: that is a person owning the conversation,
   * released through "Return to AI", and resuming here would not hand it back.
   */
  async resume(
    tenantId: string,
    actorUserId: string,
    conversationId: string,
  ): Promise<ConversationAiStatus> {
    const before = await this.getStatus(tenantId, conversationId);
    if (before.ownerType === CONVERSATION_OWNER_TYPE.HUMAN) {
      throw this.handedOver();
    }
    if (before.mode === CONVERSATION_AI_MODE.DEFAULT && !before.pausedUntil) {
      return before;
    }

    const changed = await this.applyMode(
      tenantId,
      actorUserId,
      conversationId,
      CONVERSATION_AI_MODE.DEFAULT,
      { clearTakeoverWindow: true, unlessOwnedByHuman: true },
    );
    // A handover began between the read above and the write: nothing was changed.
    if (!changed) throw this.handedOver();

    await this.audit.record({
      tenantId,
      actorUserId,
      action: CONVERSATION_AI_AUDIT_ACTION.RESUMED,
      entityType: 'conversation',
      entityId: conversationId,
      before: { ai_mode: before.mode, takeover_active: !!before.pausedUntil },
      after: { ai_mode: CONVERSATION_AI_MODE.DEFAULT },
    });
    return this.getStatus(tenantId, conversationId);
  }

  /**
   * One tenant-scoped UPDATE rather than read-modify-save, so a concurrent
   * change to another column of the row (an assignment, a handover) is never
   * overwritten with this request's stale copy.
   */
  private async applyMode(
    tenantId: string,
    actorUserId: string,
    conversationId: string,
    mode: ConversationAiMode,
    opts: { clearTakeoverWindow?: boolean; unlessOwnedByHuman?: boolean } = {},
  ): Promise<boolean> {
    const qb = this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({
        ai_mode: mode,
        ai_mode_changed_at: new Date(),
        ai_mode_changed_by: { id: actorUserId } as User,
        ...(opts.clearTakeoverWindow ? { ai_paused_until: null } : {}),
      })
      .where('id = :id', { id: conversationId })
      .andWhere('"tenantId" = :tenantId', { tenantId });
    if (opts.unlessOwnedByHuman) {
      qb.andWhere('owner_type <> :human', {
        human: CONVERSATION_OWNER_TYPE.HUMAN,
      });
    }
    const res = await qb.execute();
    return (res.affected ?? 0) > 0;
  }

  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, {
      message: 'Conversation not found',
    });
  }

  private handedOver(): AppError {
    return new AppError(ErrorCode.CONFLICT, {
      message:
        'This conversation is handed over to a person. Use "Return to AI" to hand it back.',
    });
  }
}
