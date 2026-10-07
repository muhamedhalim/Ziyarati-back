import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { Customer } from '../../entities/CRM/Customer';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { WhatsappAiHoursService } from './whatsapp-ai-hours.service';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { MetricsService } from '../../metrics/metrics.service';

import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import {
  CONVERSATION_AI_MODE,
  CONVERSATION_OWNER_TYPE,
} from '../conversations/conversation.constants';
import {
  AI_ASSIGNMENT_MODE,
  AI_POLICY_REASON,
  AI_SCHEDULE_MODE,
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
 *   3. the patient is excluded              → PATIENT_AI_DISABLED
 *   4. staff paused this conversation       → CONVERSATION_AI_DISABLED
 *   5. a person owns the conversation       → HUMAN_TAKEOVER
 *   6. the clinic's AI schedule             → OUTSIDE_ALLOWED_HOURS
 *   7. assigned-only mode, not assigned     → NOT_ASSIGNED_TO_AI
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
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly access: AccessControlService,
    private readonly hours: WhatsappAiHoursService,
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

  /**
   * The same decision, without recording it. For a staff-facing "why is the AI
   * silent here?" read: such a read is not a patient message the AI declined, so
   * it must not move `whatsapp_ai_decisions_total` or write a decision log line.
   */
  explain(
    tenantId: string,
    subject: AiPolicySubject,
  ): Promise<AiPolicyDecision> {
    return this.decide(tenantId, subject, { findLinkedSession: true });
  }

  private async decide(
    tenantId: string,
    subject: AiPolicySubject,
    opts: { findLinkedSession?: boolean } = {},
  ): Promise<AiPolicyDecision> {
    try {
      const notEntitled = await this.entitlementRefusal(tenantId);
      if (notEntitled) return { allowed: false, reason: notEntitled };

      const clinic = await this.readClinicSettings(tenantId);
      if (!clinic.botEnabled) {
        return { allowed: false, reason: AI_POLICY_REASON.CLINIC_AI_DISABLED };
      }

      // Fail closed: `null` (not omitted) means "stored, but no thread". Every
      // per-conversation rule below would silently not apply to it.
      if (subject.conversationId === null) {
        return { allowed: false, reason: AI_POLICY_REASON.NO_CONVERSATION };
      }

      const state = await this.loadConversationState(tenantId, subject, opts);
      if (state.patientExcluded) {
        return { allowed: false, reason: AI_POLICY_REASON.PATIENT_AI_DISABLED };
      }
      if (state.conversationPaused) {
        return {
          allowed: false,
          reason: AI_POLICY_REASON.CONVERSATION_AI_DISABLED,
        };
      }
      if (state.humanOwns) {
        return { allowed: false, reason: AI_POLICY_REASON.HUMAN_TAKEOVER };
      }

      if (clinic.scheduleMode !== AI_SCHEDULE_MODE.ALWAYS) {
        // `null` = the clinic has no working hours on file: the schedule cannot
        // be judged, so it does not apply (and the settings screen says so).
        const open = await this.hours.isOpen(tenantId, state.branchId);
        if (open !== null) {
          const wantsOpen =
            clinic.scheduleMode === AI_SCHEDULE_MODE.WORKING_HOURS;
          if (open !== wantsOpen) {
            return {
              allowed: false,
              reason: AI_POLICY_REASON.OUTSIDE_ALLOWED_HOURS,
            };
          }
        }
      }

      // `ENABLED` is the staff's "assign this conversation to the AI". It lifts
      // only this rule — never the clinic, patient, handover or schedule rules.
      if (
        clinic.assignmentMode === AI_ASSIGNMENT_MODE.ASSIGNED_ONLY &&
        state.aiMode !== CONVERSATION_AI_MODE.ENABLED
      ) {
        return { allowed: false, reason: AI_POLICY_REASON.NOT_ASSIGNED_TO_AI };
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
   * The clinic's own settings (`tenant_settings`): the on/off switch
   * (`bot_enabled`) and the phase-2 schedule / assignment modes. A clinic with no
   * settings row yet has the column defaults (on, ALWAYS, ALL) — exactly the
   * behaviour before any of these existed.
   */
  private async readClinicSettings(tenantId: string): Promise<{
    botEnabled: boolean;
    scheduleMode: string;
    assignmentMode: string;
  }> {
    const row = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
      select: {
        id: true,
        bot_enabled: true,
        ai_schedule_mode: true,
        ai_assignment_mode: true,
      },
    });
    return {
      botEnabled: row?.bot_enabled ?? true,
      scheduleMode: row?.ai_schedule_mode ?? AI_SCHEDULE_MODE.ALWAYS,
      assignmentMode: row?.ai_assignment_mode ?? AI_ASSIGNMENT_MODE.ALL,
    };
  }

  /**
   * Everything the per-patient and per-conversation rules need, read fresh and
   * tenant-scoped, so a foreign id can never make a clinic's conversation look
   * paused, excluded or handed over.
   *
   *  - `patientExcluded` — `customers.ai_replies_disabled`. The patient is the
   *    one the caller named, else the conversation's own customer.
   *  - `conversationPaused` — staff set `conversations.ai_mode = DISABLED`.
   *  - `humanOwns` — a person owns the conversation. Several flags are read
   *    because they are views of one fact written by different flows:
   *    `Conversation.owner_type` drives the inbox, `AiConversation.status` is
   *    what gates the AI engine, and `ai_paused_until` is the automatic
   *    takeover window. A state where only one is set must still stop the AI.
   *    `ai_paused_until` is compared to the clock here, at decision time — there
   *    is no timer to fire, so it cannot be late, lost or doubled by a retry.
   */
  private async loadConversationState(
    tenantId: string,
    subject: AiPolicySubject,
    opts: { findLinkedSession?: boolean },
  ): Promise<{
    patientExcluded: boolean;
    conversationPaused: boolean;
    humanOwns: boolean;
    aiMode: string | undefined;
    /** The branch whose hours apply: the thread's own, else its number's; null = the whole clinic. */
    branchId: string | null;
  }> {
    // The inbound bridge knows the contact's AI session. A staff-facing read
    // only knows the thread, so it looks the session up by its link instead.
    const aiConversationRead = subject.aiConversationId
      ? this.aiConversations.findOne({
          where: { id: subject.aiConversationId, tenant: { id: tenantId } },
          select: { id: true, status: true },
        })
      : opts.findLinkedSession && subject.conversationId
        ? this.aiConversations.findOne({
            where: {
              conversation: { id: subject.conversationId },
              tenant: { id: tenantId },
              status: AI_CONVERSATION_STATUS.HANDED_OVER,
            },
            select: { id: true, status: true },
          })
        : null;

    const conversation = subject.conversationId
      ? await this.conversations.findOne({
          where: { id: subject.conversationId, tenant: { id: tenantId } },
          relations: {
            customer: true,
            branch: true,
            whatsapp_account: { branch: true },
          },
          select: {
            id: true,
            owner_type: true,
            ai_mode: true,
            ai_paused_until: true,
            customer: { id: true },
            branch: { id: true },
            whatsapp_account: { id: true, branch: { id: true } },
          },
        })
      : null;

    const customerId = subject.customerId ?? conversation?.customer?.id;
    const [aiConversation, customer] = await Promise.all([
      aiConversationRead,
      customerId
        ? this.customers.findOne({
            where: { id: customerId, tenant: { id: tenantId } },
            select: { id: true, ai_replies_disabled: true },
            // An excluded patient who was later deleted must stay excluded.
            withDeleted: true,
          })
        : null,
    ]);

    const pausedUntil = conversation?.ai_paused_until;
    return {
      aiMode: conversation?.ai_mode,
      branchId:
        conversation?.branch?.id ??
        conversation?.whatsapp_account?.branch?.id ??
        null,
      patientExcluded: customer?.ai_replies_disabled === true,
      conversationPaused:
        conversation?.ai_mode === CONVERSATION_AI_MODE.DISABLED,
      humanOwns:
        conversation?.owner_type === CONVERSATION_OWNER_TYPE.HUMAN ||
        aiConversation?.status === AI_CONVERSATION_STATUS.HANDED_OVER ||
        (!!pausedUntil && new Date(pausedUntil).getTime() > Date.now()),
    };
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
