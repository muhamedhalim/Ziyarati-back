import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';

/**
 * Automatic human takeover: when a staff member replies to a conversation, the
 * WhatsApp AI stays silent on it for the clinic's configured number of minutes
 * (`tenant_settings.ai_human_takeover_minutes`; 0 = off).
 *
 * It is a TIMESTAMP, not a timer: this writes `conversations.ai_paused_until`
 * and `WhatsappAiPolicyService` compares it with the clock whenever it decides.
 * There is nothing to schedule, nothing to clean up and nothing that can fire
 * late, twice or not at all — a retry of the same reply just writes the same
 * deadline again.
 *
 * One owner for the write, so every way a person can answer — a reply typed in
 * the Ziyarati inbox, a handover reply, or a message sent from the WhatsApp
 * Business App (a coexistence echo) — applies exactly the same rule.
 *
 * Rules:
 *  - the deadline only ever moves LATER (a second reply extends the window, a
 *    reply during a longer manual window never shortens it);
 *  - tenant-scoped, one UPDATE, never read-modify-save of the conversation;
 *  - best-effort: a failure here must not fail the reply the person just sent,
 *    so it is logged (ids only) and swallowed. The cost of a miss is that the AI
 *    may answer in the window — never a lost staff message.
 */
@Injectable()
export class ConversationAiTakeoverService {
  private readonly logger = new Logger('ConversationAiTakeoverService');

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(TenantSetting)
    private readonly settings: Repository<TenantSetting>,
  ) {}

  /**
   * Records that a person just replied on `conversationId`. Returns the
   * deadline now in force, or `null` when automatic takeover is off (or the
   * write could not be made).
   */
  async stampStaffReply(
    tenantId: string,
    conversationId: string,
  ): Promise<Date | null> {
    try {
      const row = await this.settings.findOne({
        where: { tenant: { id: tenantId } },
        select: { id: true, ai_human_takeover_minutes: true },
      });
      const minutes = row?.ai_human_takeover_minutes ?? 0;
      if (!(minutes > 0)) return null;

      const until = new Date(Date.now() + minutes * 60_000);
      await this.conversations
        .createQueryBuilder()
        .update(Conversation)
        .set({ ai_paused_until: until })
        .where('id = :id', { id: conversationId })
        .andWhere('"tenantId" = :tenantId', { tenantId })
        .andWhere('(ai_paused_until IS NULL OR ai_paused_until < :until)', {
          until,
        })
        .execute();
      return until;
    } catch (err) {
      this.logger.error(
        `AI_TAKEOVER_STAMP_FAILED tenant=${tenantId} conversation=${conversationId}: ${(err as Error)?.message}`,
      );
      return null;
    }
  }
}
