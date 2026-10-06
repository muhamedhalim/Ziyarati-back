import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { MetricsService } from '../../metrics/metrics.service';

import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import { CONVERSATION_OWNER_TYPE } from '../conversations/conversation.constants';
import {
  AI_POLICY_REASON,
  AiPolicyDecision,
  AiPolicyReason,
  AiPolicyStage,
  AiPolicySubject,
} from './whatsapp-ai-policy.constants';

/**
 * THE decision on whether the WhatsApp AI may answer a patient message.
 *
 * One owner, so a rule is written once and every caller inherits it: the
 * inbound bridge asks before the model is called AND again right before the
 * reply is sent (a pause or takeover that lands mid-turn must still stop it),
 * and any later surface that wants to show "why didn't the AI answer?" asks the
 * same question.
 *
 * Order — cheapest and most global first, and the first refusal is the reported
 * reason:
 *   1. subscription / feature entitlement   → SUBSCRIPTION_DISABLED | FEATURE_DISABLED
 *   2. the clinic's own switch              → CLINIC_AI_DISABLED
 *   3. a person owns the conversation       → HUMAN_TAKEOVER
 *
 * A refusal is a NORMAL outcome, never an error: the caller halts before the
 * model runs and sends nothing. Entitlement is never bypassed — a clinic's own
 * setting can only narrow what its plan allows, never widen it.
 *
 * Every read is fresh (no cache of its own). The decision is only as good as the
 * moment it is taken, and the whole point of the second check is to see a change
 * made after the first.
 *
 * FAILS CLOSED: if any input cannot be read, the answer is "no" with
 * `POLICY_READ_FAILED` — a reply the clinic switched off must never go out
 * because a lookup failed.
 *
 * Observability: one `WHATSAPP_AI_DECISION` line per refusal and a bounded
 * `whatsapp_ai_decisions_total{decision,reason,stage}` counter. Ids only — never
 * message content, a phone number, a token or a credential.
 */
@Injectable()
export class WhatsappAiPolicyService {
  private readonly logger = new Logger('WhatsappAiPolicyService');

  constructor(
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
    private readonly access: AccessControlService,
    private readonly metrics: MetricsService,
    private readonly ctx: TenantContextService,
  ) {}

  async evaluate(
    tenantId: string,
    subject: AiPolicySubject,
    stage: AiPolicyStage,
  ): Promise<AiPolicyDecision> {
    const decision = await this.decide(tenantId, subject);
    this.observe(tenantId, subject, stage, decision);
    return decision;
  }

  private async decide(
    tenantId: string,
    subject: AiPolicySubject,
  ): Promise<AiPolicyDecision> {
    try {
      const notEntitled = await this.entitlementRefusal(tenantId);
      if (notEntitled) return { allowed: false, reason: notEntitled };

      if (!(await this.clinicSwitchedOn(tenantId))) {
        return { allowed: false, reason: AI_POLICY_REASON.CLINIC_AI_DISABLED };
      }

      if (await this.humanOwns(tenantId, subject)) {
        return { allowed: false, reason: AI_POLICY_REASON.HUMAN_TAKEOVER };
      }

      return { allowed: true };
    } catch (err) {
      this.logger.error(
        `[cid=${this.ctx.getCorrelationId() ?? '-'}] could not evaluate the WhatsApp AI policy ` +
          `(tenant=${tenantId}) — refusing (fail closed): ${(err as Error)?.message}`,
      );
      return { allowed: false, reason: AI_POLICY_REASON.POLICY_READ_FAILED };
    }
  }

  /**
   * Both capabilities the bridge exercises: the AI turn and the WhatsApp reply.
   * `ACCESS_POLICY_MODE=shadow` is honoured exactly as at every other
   * enforcement point (`shouldBlock`): the denial is recorded, not enforced.
   *
   * The access decision carries only free text, so the split between "no
   * platform access" and "this capability is not granted" is made with the
   * authority's own tenant-wide question (`resolve(tenantId, null)`) — asked only
   * on the refusal path.
   */
  private async entitlementRefusal(
    tenantId: string,
  ): Promise<AiPolicyReason | null> {
    for (const key of [FeatureKey.AI_ASSISTANT, FeatureKey.WHATSAPP]) {
      const decision = await this.access.resolve(tenantId, key);
      if (decision.allowed) continue;
      if (
        !this.access.shouldBlock(decision, {
          surface: 'webhook',
          detail: 'whatsapp.inbound.aiReply',
        })
      ) {
        continue; // ACCESS_POLICY_MODE=shadow — recorded, not enforced
      }
      const platform = await this.access.resolve(tenantId, null);
      return platform.allowed
        ? AI_POLICY_REASON.FEATURE_DISABLED
        : AI_POLICY_REASON.SUBSCRIPTION_DISABLED;
    }
    return null;
  }

  /**
   * The clinic's OWN switch (Settings → Booking & operations → "AI assistant",
   * `tenant_settings.bot_enabled`). A clinic with no settings row yet has the
   * column default (`true`).
   */
  private async clinicSwitchedOn(tenantId: string): Promise<boolean> {
    const row = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
      select: { id: true, bot_enabled: true },
    });
    return row?.bot_enabled ?? true;
  }

  /**
   * A person owns the conversation. Both flags are read because they are two
   * views of one fact written together by the handover flow:
   * `Conversation.owner_type` drives the inbox, `AiConversation.status` is what
   * gates the AI engine — a state where only one is set must still stop the AI.
   * Tenant-scoped, so a foreign id can never make a clinic look handed-over.
   */
  private async humanOwns(
    tenantId: string,
    subject: AiPolicySubject,
  ): Promise<boolean> {
    const [conversation, aiConversation] = await Promise.all([
      subject.conversationId
        ? this.conversations.findOne({
            where: { id: subject.conversationId, tenant: { id: tenantId } },
            select: { id: true, owner_type: true },
          })
        : null,
      subject.aiConversationId
        ? this.aiConversations.findOne({
            where: { id: subject.aiConversationId, tenant: { id: tenantId } },
            select: { id: true, status: true },
          })
        : null,
    ]);
    return (
      conversation?.owner_type === CONVERSATION_OWNER_TYPE.HUMAN ||
      aiConversation?.status === AI_CONVERSATION_STATUS.HANDED_OVER
    );
  }

  private observe(
    tenantId: string,
    subject: AiPolicySubject,
    stage: AiPolicyStage,
    decision: AiPolicyDecision,
  ): void {
    if (decision.allowed) {
      this.metrics.recordWhatsappAiDecision('ALLOW', 'ALLOWED', stage);
      return;
    }
    this.metrics.recordWhatsappAiDecision('SKIP', decision.reason, stage);
    this.logger.log(
      `[cid=${this.ctx.getCorrelationId() ?? '-'}] WHATSAPP_AI_DECISION decision=SKIP ` +
        `reason=${decision.reason} stage=${stage} tenant=${tenantId} ` +
        `conversation=${subject.conversationId ?? '-'}`,
    );
  }
}
