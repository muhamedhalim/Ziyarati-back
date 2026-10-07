import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { AGENT_ROLE, AgentRole, AiSession } from './ai-channel.constants';

/**
 * Intent keyword → agent role. First match wins; order = priority. Arabic stems
 * sit beside the English ones (no `\b`: it is ASCII-only in JS and never matches
 * next to an Arabic letter), so an Arabic patient routes like an English one.
 */
const ROLE_KEYWORDS: { role: AgentRole; patterns: RegExp }[] = [
  {
    role: AGENT_ROLE.BOOKING,
    patterns:
      /\b(book|appointment|reschedul|cancel|availab|slot|schedul)|(?:حجز|احجز|أحجز|موعد|مواعيد|إلغاء|الغاء|الغي|ألغي|تأجيل|أجل|متاح|متوفر)/i,
  },
  {
    role: AGENT_ROLE.BILLING,
    patterns:
      /\b(invoice|payment|refund|price|cost|bill|charge|pay)|(?:فاتورة|الفاتورة|دفع|سداد|استرجاع|استرداد|سعر|أسعار|اسعار|تكلفة|كم\s+يكلف)/i,
  },
  {
    role: AGENT_ROLE.MEDICAL_FAQ,
    patterns:
      /\b(symptom|pain|treatment|medic|doctor|diagnos|procedure)|(?:أعراض|اعراض|ألم|الم|وجع|علاج|دكتور|طبيب|تشخيص|إجراء)/i,
  },
  {
    role: AGENT_ROLE.REVIEW,
    patterns:
      /\b(review|rating|feedback|complain|satisf)|(?:تقييم|رأي|ملاحظات|شكوى|شكوي|رضا)/i,
  },
  {
    role: AGENT_ROLE.SUPPORT,
    patterns:
      /\b(help|support|issue|problem|error|not working)|(?:مساعدة|ساعدني|دعم|مشكلة|خطأ|لا\s+يعمل)/i,
  },
  {
    role: AGENT_ROLE.CRM,
    patterns:
      /\b(profile|my (info|details)|update my|contact)|(?:ملفي|بياناتي|معلوماتي|حدث\s+بياناتي|تواصل)/i,
  },
];

export interface RoutedAgent {
  agentId: string | null;
  role: AgentRole | null;
  reason: string;
}

/**
 * Agent Router (Feature 7): decides WHICH specialized agent handles a turn, then
 * the orchestrator binds it (via ConversationSessionService.setAgent) so the
 * EXISTING engine runs under that agent. It never calls a provider or duplicates
 * execution — it only selects an agent id.
 *
 * Resolution: intent keywords → role → an active agent with that role → else the
 * session's current agent role → else the tenant's default (role-less) active
 * agent. Fully tenant-scoped.
 */
@Injectable()
export class AgentRouterService {
  private readonly logger = new Logger(AgentRouterService.name);

  constructor(
    @InjectRepository(AiAgent)
    private readonly agents: Repository<AiAgent>,
  ) {}

  async route(
    tenantId: string,
    text: string,
    session?: AiSession,
  ): Promise<RoutedAgent> {
    const role =
      this.detectRole(text) ??
      (session?.currentAgentRole as AgentRole | undefined) ??
      null;

    // 1) Prefer an active agent explicitly assigned to the detected role.
    if (role) {
      const byRole = await this.agents.findOne({
        where: { tenant: { id: tenantId }, role, is_active: true },
        order: { created_at: 'ASC' },
      });
      if (byRole)
        return { agentId: byRole.id, role, reason: `matched role ${role}` };
    }

    // 2) Fall back to the tenant's default (role-less) active agent — preserves
    //    legacy single-agent behaviour when no specialized agents are configured.
    const fallback = await this.agents.findOne({
      where: [
        { tenant: { id: tenantId }, role: IsNull(), is_active: true },
        { tenant: { id: tenantId }, is_active: true },
      ],
      order: { created_at: 'ASC' },
    });
    return {
      agentId: fallback?.id ?? null,
      role,
      reason: fallback ? 'default active agent' : 'no active agent',
    };
  }

  /** Available specialized roles for this tenant (for the routing UI). */
  async availableRoles(
    tenantId: string,
  ): Promise<{ role: string; agentId: string; name: string | null }[]> {
    const rows = await this.agents.find({
      where: { tenant: { id: tenantId }, is_active: true },
      order: { created_at: 'ASC' },
    });
    return rows
      .filter((a) => !!a.role)
      .map((a) => ({
        role: a.role as string,
        agentId: a.id,
        name: a.name ?? null,
      }));
  }

  private detectRole(text: string): AgentRole | null {
    for (const { role, patterns } of ROLE_KEYWORDS) {
      if (patterns.test(text)) return role;
    }
    return null;
  }
}
