import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { Message } from '../../entities/Conversations/Message';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { AppError, ErrorCode } from '../../common/errors';
import { ConversationAnalyticsFilterDto } from './dto/conversation-analytics-filter.dto';
import {
  ACTIVE_CONVERSATION_STATUSES,
  RESOLVED_CONVERSATION_STATUSES,
  SENDER_TYPE,
} from './conversation.constants';

/**
 * Conversation & messaging analytics. All aggregates are tenant-scoped: every
 * query joins `tenant`/`conversation.tenant` and filters `tenant.id`. Grouping
 * uses relation joins (never raw FK columns) for portability across naming.
 */
@Injectable()
export class ConversationAnalyticsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(HandoverRequest) private readonly handovers: Repository<HandoverRequest>,
  ) {}

  /** Totals, active count, status breakdown, and resolution rate. */
  async overview(tenantId: string, filter: ConversationAnalyticsFilterDto) {
    const rows = await this.scopedConversations(tenantId, filter)
      .select('c.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('c.status')
      .getRawMany<{ status: string | null; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const c = Number(r.count);
      byStatus[r.status ?? 'UNKNOWN'] = c;
      total += c;
    }
    const active = ACTIVE_CONVERSATION_STATUSES.reduce((s, st) => s + (byStatus[st] ?? 0), 0);
    const resolved = RESOLVED_CONVERSATION_STATUSES.reduce((s, st) => s + (byStatus[st] ?? 0), 0);

    return {
      tenantId,
      totalConversations: total,
      activeConversations: active,
      resolvedConversations: resolved,
      resolutionRate: total === 0 ? 0 : +((resolved / total) * 100).toFixed(2),
      byStatus,
    };
  }

  /** Message volume in the period, broken down by sender type. */
  async messages_(tenantId: string, filter: ConversationAnalyticsFilterDto) {
    const rows = await this.scopedMessages(tenantId, filter)
      .select('m.sender_type', 'senderType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.sender_type')
      .getRawMany<{ senderType: string | null; count: string }>();

    const bySenderType: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const c = Number(r.count);
      bySenderType[r.senderType ?? 'UNKNOWN'] = c;
      total += c;
    }
    return { tenantId, totalMessages: total, bySenderType };
  }

  /** Per-agent performance: messages sent + conversations assigned. */
  async agentPerformance(tenantId: string, filter: ConversationAnalyticsFilterDto) {
    const messageRows = await this.scopedMessages(tenantId, filter)
      .leftJoin('m.sender_user', 'su')
      .andWhere('m.sender_type = :agent', { agent: SENDER_TYPE.AGENT })
      .andWhere('su.id IS NOT NULL')
      .select('su.id', 'agentId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('su.id')
      .getRawMany<{ agentId: string; count: string }>();

    const convQb = this.scopedConversations(tenantId, filter)
      .leftJoin('c.assigned_to', 'a')
      .andWhere('a.id IS NOT NULL')
      .select('a.id', 'agentId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('a.id');
    const convRows = await convQb.getRawMany<{ agentId: string; count: string }>();

    const agents = new Map<string, { agentId: string; messagesSent: number; conversationsAssigned: number }>();
    for (const r of messageRows) {
      const e = agents.get(r.agentId) ?? { agentId: r.agentId, messagesSent: 0, conversationsAssigned: 0 };
      e.messagesSent = Number(r.count);
      agents.set(r.agentId, e);
    }
    for (const r of convRows) {
      const e = agents.get(r.agentId) ?? { agentId: r.agentId, messagesSent: 0, conversationsAssigned: 0 };
      e.conversationsAssigned = Number(r.count);
      agents.set(r.agentId, e);
    }
    return { tenantId, agents: [...agents.values()] };
  }

  /**
   * Average first-agent-response latency + engagement (avg messages per
   * conversation). Bounded by the date filter; samples up to 1000 conversations.
   */
  async responseTime(tenantId: string, filter: ConversationAnalyticsFilterDto) {
    const convs = await this.scopedConversations(tenantId, filter)
      .select(['c.id AS "id"', 'c.created_at AS "createdAt"'])
      .orderBy('c.created_at', 'DESC')
      .limit(1000)
      .getRawMany<{ id: string; createdAt: Date }>();

    if (convs.length === 0) {
      return {
        tenantId,
        sampledConversations: 0,
        averageFirstResponseSeconds: 0,
        avgMessagesPerConversation: 0,
      };
    }
    const ids = convs.map((c) => c.id);

    const firstAgent = await this.messages
      .createQueryBuilder('m')
      .leftJoin('m.conversation', 'conv')
      .leftJoin('m.tenant', 't')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('m.sender_type = :agent', { agent: SENDER_TYPE.AGENT })
      .andWhere('conv.id IN (:...ids)', { ids })
      .select('conv.id', 'conversationId')
      .addSelect('MIN(m.created_at)', 'firstAt')
      .groupBy('conv.id')
      .getRawMany<{ conversationId: string; firstAt: Date }>();

    const createdById = new Map(convs.map((c) => [c.id, new Date(c.createdAt).getTime()]));
    let totalSeconds = 0;
    let responded = 0;
    for (const r of firstAgent) {
      const created = createdById.get(r.conversationId);
      if (created === undefined) continue;
      const delta = (new Date(r.firstAt).getTime() - created) / 1000;
      if (delta >= 0) {
        totalSeconds += delta;
        responded += 1;
      }
    }

    const totalMessages = await this.messages
      .createQueryBuilder('m')
      .leftJoin('m.conversation', 'conv')
      .leftJoin('m.tenant', 't')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('conv.id IN (:...ids)', { ids })
      .getCount();

    return {
      tenantId,
      sampledConversations: convs.length,
      respondedConversations: responded,
      averageFirstResponseSeconds: responded === 0 ? 0 : Math.round(totalSeconds / responded),
      avgMessagesPerConversation: +(totalMessages / convs.length).toFixed(2),
    };
  }

  /**
   * Live Agent Handover monitoring (Requirement #17). Every figure here is
   * computed directly from real timestamps already written by
   * `HandoverRequestService` / `AiOrchestratorService` — nothing is estimated:
   *  - avgWaitSeconds / firstResponseSeconds: `HandoverRequest.created_at` →
   *    the first AGENT message in that conversation after the request (same
   *    computation `responseTime()` already uses, scoped to escalated
   *    conversations only — "wait" and "first response" are the same event
   *    for a handover ticket, so both fields report the same number here).
   *  - avgHandlingSeconds / resolutionSeconds: `created_at` → `resolved_at`
   *    on RESOLVED/REJECTED requests.
   *  - aiHandoverCount: total requests created in the period (AI → Human).
   *  - returnedToAiCount: conversations with `released_at` set in the period
   *    (Human → AI, via "Return to AI" — the only mechanism that sets it).
   *  - conversationsPerAgent / avgHandlingSecondsByAgent: grouped by the
   *    request's `assigned_to`.
   */
  async handoverMetrics(tenantId: string, filter: ConversationAnalyticsFilterDto) {
    const qb = this.handovers
      .createQueryBuilder('h')
      .leftJoin('h.tenant', 'tenant')
      .leftJoin('h.conversation', 'conv')
      .leftJoin('h.assigned_to', 'agent')
      .where('tenant.id = :tenantId', { tenantId });
    if (filter.from) qb.andWhere('h.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('h.created_at < :to', { to: new Date(filter.to) });

    const requests = await qb
      .select(['h.id AS id', 'h.status AS status', 'h.created_at AS "createdAt"', 'h.resolved_at AS "resolvedAt"', 'conv.id AS "conversationId"', 'agent.id AS "agentId"'])
      .getRawMany<{ id: string; status: string; createdAt: Date; resolvedAt: Date | null; conversationId: string; agentId: string | null }>();

    const aiHandoverCount = requests.length;

    // Average handling / resolution time — RESOLVED or REJECTED only.
    const finished = requests.filter((r) => r.resolvedAt);
    const avgHandlingSeconds = finished.length
      ? Math.round(
          finished.reduce((s, r) => s + (new Date(r.resolvedAt!).getTime() - new Date(r.createdAt).getTime()) / 1000, 0) /
            finished.length,
        )
      : 0;

    // First agent response per escalated conversation.
    const conversationIds = [...new Set(requests.map((r) => r.conversationId).filter(Boolean))];
    let avgWaitSeconds = 0;
    if (conversationIds.length) {
      const firstAgent = await this.messages
        .createQueryBuilder('m')
        .leftJoin('m.conversation', 'conv')
        .leftJoin('m.tenant', 't')
        .where('t.id = :tenantId', { tenantId })
        .andWhere('m.sender_type = :agent', { agent: SENDER_TYPE.AGENT })
        .andWhere('conv.id IN (:...ids)', { ids: conversationIds })
        .select('conv.id', 'conversationId')
        .addSelect('MIN(m.created_at)', 'firstAt')
        .groupBy('conv.id')
        .getRawMany<{ conversationId: string; firstAt: Date }>();

      const requestedAtByConversation = new Map<string, number>();
      for (const r of requests) {
        const t = new Date(r.createdAt).getTime();
        const existing = requestedAtByConversation.get(r.conversationId);
        if (existing === undefined || t < existing) requestedAtByConversation.set(r.conversationId, t);
      }
      let total = 0;
      let count = 0;
      for (const r of firstAgent) {
        const requestedAt = requestedAtByConversation.get(r.conversationId);
        if (requestedAt === undefined) continue;
        const delta = (new Date(r.firstAt).getTime() - requestedAt) / 1000;
        if (delta >= 0) {
          total += delta;
          count += 1;
        }
      }
      avgWaitSeconds = count ? Math.round(total / count) : 0;
    }

    // Returned-to-AI count: conversations released back to AI in the window.
    const releasedQb = this.conversations
      .createQueryBuilder('c')
      .leftJoin('c.tenant', 'tenant')
      .where('tenant.id = :tenantId', { tenantId })
      .andWhere('c.released_at IS NOT NULL');
    if (filter.from) releasedQb.andWhere('c.released_at >= :from', { from: new Date(filter.from) });
    if (filter.to) releasedQb.andWhere('c.released_at < :to', { to: new Date(filter.to) });
    const returnedToAiCount = await releasedQb.getCount();

    // Per-agent utilization for this window.
    const byAgent = new Map<string, { agentId: string; conversationsHandled: number; avgHandlingSeconds: number; _total: number; _finished: number }>();
    for (const r of requests) {
      if (!r.agentId) continue;
      const e = byAgent.get(r.agentId) ?? { agentId: r.agentId, conversationsHandled: 0, avgHandlingSeconds: 0, _total: 0, _finished: 0 };
      e.conversationsHandled += 1;
      if (r.resolvedAt) {
        e._total += (new Date(r.resolvedAt).getTime() - new Date(r.createdAt).getTime()) / 1000;
        e._finished += 1;
      }
      byAgent.set(r.agentId, e);
    }
    const agentUtilization = [...byAgent.values()].map((e) => ({
      agentId: e.agentId,
      conversationsHandled: e.conversationsHandled,
      avgHandlingSeconds: e._finished ? Math.round(e._total / e._finished) : 0,
    }));

    return {
      tenantId,
      aiHandoverCount,
      returnedToAiCount,
      avgWaitSeconds,
      firstResponseSeconds: avgWaitSeconds,
      avgHandlingSeconds,
      resolutionSeconds: avgHandlingSeconds,
      agentUtilization,
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private scopedConversations(
    tenantId: string,
    filter: ConversationAnalyticsFilterDto,
  ): SelectQueryBuilder<Conversation> {
    const qb = this.conversations
      .createQueryBuilder('c')
      .leftJoin('c.tenant', 'tenant')
      .where('tenant.id = :tenantId', { tenantId });
    if (filter.from) qb.andWhere('c.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('c.created_at < :to', { to: new Date(filter.to) });
    if (filter.assignedToUserId) {
      qb.leftJoin('c.assigned_to', 'flt_a').andWhere('flt_a.id = :aid', { aid: filter.assignedToUserId });
    }
    return qb;
  }

  private scopedMessages(
    tenantId: string,
    filter: ConversationAnalyticsFilterDto,
  ): SelectQueryBuilder<Message> {
    const qb = this.messages
      .createQueryBuilder('m')
      .leftJoin('m.tenant', 't')
      .where('t.id = :tenantId', { tenantId });
    if (filter.from) qb.andWhere('m.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('m.created_at < :to', { to: new Date(filter.to) });
    return qb;
  }
}
