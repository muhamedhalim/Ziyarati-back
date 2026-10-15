import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { Conversation } from '../../entities/Conversations/Conversation';
import { Message } from '../../entities/Conversations/Message';
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
