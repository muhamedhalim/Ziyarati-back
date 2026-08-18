import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { AiUsageLog } from '../../entities/AI Agent/AiUsageLog';
import { AiCostLog } from '../../entities/AI Agent/AiCostLog';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { AiKnowledgeBase } from '../../entities/AI Agent/AiKnowledgeBase';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { AiAnalyticsFilterDto } from './dto/ai-analytics-filter.dto';
import { AI_CONVERSATION_STATUS } from './ai.constants';

/**
 * AI analytics — all aggregates are tenant-scoped (every query joins `tenant`
 * and filters `tenant.id`; usage/cost queries also use the `period_month` key).
 * Grouping uses relation joins (never raw FK columns) for naming portability.
 *
 * Schema notes: `ai_usage_logs`/`ai_cost_logs` have no `created_at` (period is
 * the `period_month` key); `ai_cost_logs` has no agent dimension (cost is
 * tenant+month); knowledge access/retrieval frequency is not counted in the
 * schema, so knowledge analytics report chunk inventory only.
 */
@Injectable()
export class AiAnalyticsService {
  constructor(
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
    @InjectRepository(AiMessage) private readonly messages: Repository<AiMessage>,
    @InjectRepository(AiUsageLog) private readonly usageLogs: Repository<AiUsageLog>,
    @InjectRepository(AiCostLog) private readonly costLogs: Repository<AiCostLog>,
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
    @InjectRepository(AiKnowledgeBase) private readonly kb: Repository<AiKnowledgeBase>,
    @InjectRepository(HandoverRequest) private readonly handovers: Repository<HandoverRequest>,
    private readonly dataSource: DataSource,
  ) {}

  /** Token consumption, request counts, top agents, and monthly trends. */
  async usage(tenantId: string, filter: AiAnalyticsFilterDto) {
    const totals = await this.scopedUsage(tenantId, filter)
      .select('COALESCE(SUM(u.total_tokens), 0)', 'tokens')
      .addSelect('COALESCE(SUM(u.total_requests), 0)', 'requests')
      .getRawOne<{ tokens: string; requests: string }>();

    const trends = await this.scopedUsage(tenantId, filter)
      .select('u.period_month', 'period')
      .addSelect('COALESCE(SUM(u.total_tokens), 0)', 'tokens')
      .addSelect('COALESCE(SUM(u.total_requests), 0)', 'requests')
      .groupBy('u.period_month')
      .orderBy('u.period_month', 'ASC')
      .getRawMany<{ period: string; tokens: string; requests: string }>();

    const topAgents = await this.scopedUsage(tenantId, filter)
      .leftJoin('u.agent', 'a')
      .andWhere('a.id IS NOT NULL')
      .select('a.id', 'agentId')
      .addSelect('COALESCE(SUM(u.total_tokens), 0)', 'tokens')
      .addSelect('COALESCE(SUM(u.total_requests), 0)', 'requests')
      .groupBy('a.id')
      .orderBy('"tokens"', 'DESC')
      .limit(10)
      .getRawMany<{ agentId: string; tokens: string; requests: string }>();

    return {
      tenantId,
      totalTokens: Number(totals?.tokens ?? 0),
      totalRequests: Number(totals?.requests ?? 0),
      trends: trends.map((t) => ({ period: t.period, tokens: Number(t.tokens), requests: Number(t.requests) })),
      topAgents: topAgents.map((a) => ({ agentId: a.agentId, tokens: Number(a.tokens), requests: Number(a.requests) })),
    };
  }

  /** Total + monthly spend (tenant-level; cost log has no agent dimension). */
  async cost(tenantId: string, filter: AiAnalyticsFilterDto) {
    const totals = await this.scopedCost(tenantId, filter)
      .select('COALESCE(SUM(c.total_cost_usd), 0)', 'cost')
      .addSelect('COALESCE(SUM(c.input_tokens), 0)', 'input')
      .addSelect('COALESCE(SUM(c.output_tokens), 0)', 'output')
      .addSelect('COALESCE(SUM(c.cached_input_tokens), 0)', 'cached')
      .addSelect('COALESCE(SUM(c.embedding_tokens), 0)', 'embedding')
      .addSelect('COALESCE(SUM(c.cost_microusd), 0)', 'microusd')
      .addSelect('COALESCE(SUM(c.unpriced_requests), 0)', 'unpriced')
      .getRawOne<{ cost: string; input: string; output: string; cached: string; embedding: string; microusd: string; unpriced: string }>();

    const monthly = await this.scopedCost(tenantId, filter)
      .select('c.period_month', 'period')
      .addSelect('COALESCE(SUM(c.total_cost_usd), 0)', 'cost')
      .groupBy('c.period_month')
      .orderBy('c.period_month', 'ASC')
      .getRawMany<{ period: string; cost: string }>();

    return {
      tenantId,
      totalSpendUsd: +Number(totals?.cost ?? 0).toFixed(6),
      inputTokens: Number(totals?.input ?? 0),
      outputTokens: Number(totals?.output ?? 0),
      cachedInputTokens: Number(totals?.cached ?? 0),
      embeddingTokens: Number(totals?.embedding ?? 0),
      costMicrousd: totals?.microusd ?? '0',
      unpricedRequests: Number(totals?.unpriced ?? 0),
      pricingComplete: Number(totals?.unpriced ?? 0) === 0,
      monthly: monthly.map((m) => ({ period: m.period, spendUsd: +Number(m.cost).toFixed(6) })),
    };
  }

  // `costAttribution()` (AI-021, PD-3) was removed 2026-08-17 — it backed a
  // documented `GET /ai/analytics/cost-attribution` route that was never
  // wired to a controller (404 in every environment) and had no other
  // caller. Per the recorded product decision
  // (specs/012-ai-security-remediation/evidence/decisions/PD-3-cost-attribution.md),
  // the dead method was removed and the documentation corrected rather than
  // wiring a new public API surface with no identified product need. See
  // ai-analytics.cost-isolation.spec.ts's removal in the same change (I-7,
  // FR-070) — it existed solely to exercise this method.

  /** Conversation metrics: totals, status mix, handover & resolution rates. */
  async conversations(tenantId: string, filter: AiAnalyticsFilterDto) {
    const statusRows = await this.scopedConversations(tenantId, filter)
      .select('c.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('c.status')
      .getRawMany<{ status: string | null; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of statusRows) {
      const n = Number(r.count);
      byStatus[r.status ?? 'UNKNOWN'] = n;
      total += n;
    }
    const completed = byStatus[AI_CONVERSATION_STATUS.COMPLETED] ?? 0;
    const handedOver = byStatus[AI_CONVERSATION_STATUS.HANDED_OVER] ?? 0;

    const totalMessages = await this.scopedMessages(tenantId, filter).getCount();
    const activeAgents = await this.agents.count({ where: { tenant: { id: tenantId }, is_active: true } });

    const rate = (n: number) => (total === 0 ? 0 : +((n / total) * 100).toFixed(2));

    return {
      tenantId,
      totalConversations: total,
      byStatus,
      totalMessages,
      activeAgents,
      handoverRate: rate(handedOver),
      aiResolutionRate: rate(completed),
      avgMessagesPerConversation: total === 0 ? 0 : +(totalMessages / total).toFixed(2),
    };
  }

  /** Per-agent usage (tokens/requests) + active-agent count. */
  async agents_(tenantId: string, filter: AiAnalyticsFilterDto) {
    const rows = await this.scopedUsage(tenantId, filter)
      .leftJoin('u.agent', 'a')
      .andWhere('a.id IS NOT NULL')
      .select('a.id', 'agentId')
      .addSelect('COALESCE(SUM(u.total_tokens), 0)', 'tokens')
      .addSelect('COALESCE(SUM(u.total_requests), 0)', 'requests')
      .groupBy('a.id')
      .getRawMany<{ agentId: string; tokens: string; requests: string }>();

    const activeAgents = await this.agents.count({ where: { tenant: { id: tenantId }, is_active: true } });
    return {
      tenantId,
      activeAgents,
      agents: rows.map((r) => ({ agentId: r.agentId, tokens: Number(r.tokens), requests: Number(r.requests) })),
    };
  }

  /** Knowledge inventory per agent (retrieval frequency is not tracked in schema). */
  async knowledge(tenantId: string) {
    const rows = await this.kb
      .createQueryBuilder('k')
      .leftJoin('k.tenant', 't')
      .leftJoin('k.agent', 'a')
      .where('t.id = :tenantId', { tenantId })
      .select('a.id', 'agentId')
      .addSelect('COUNT(*)', 'chunks')
      .groupBy('a.id')
      .orderBy('"chunks"', 'DESC')
      .getRawMany<{ agentId: string | null; chunks: string }>();

    const totalChunks = rows.reduce((s, r) => s + Number(r.chunks), 0);
    return {
      tenantId,
      totalChunks,
      byAgent: rows.map((r) => ({ agentId: r.agentId, chunks: Number(r.chunks) })),
      note: 'Retrieval frequency / search effectiveness are not tracked at the schema level (no access counters).',
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private monthKey(iso: string): string {
    return new Date(iso).toISOString().slice(0, 7);
  }

  private scopedConversations(
    tenantId: string,
    filter: AiAnalyticsFilterDto,
  ): SelectQueryBuilder<AiConversation> {
    const qb = this.aiConversations
      .createQueryBuilder('c')
      .leftJoin('c.tenant', 'tenant')
      .where('tenant.id = :tenantId', { tenantId });
    if (filter.from) qb.andWhere('c.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('c.created_at < :to', { to: new Date(filter.to) });
    return qb;
  }

  private scopedMessages(
    tenantId: string,
    filter: AiAnalyticsFilterDto,
  ): SelectQueryBuilder<AiMessage> {
    const qb = this.messages
      .createQueryBuilder('m')
      .leftJoin('m.tenant', 't')
      .where('t.id = :tenantId', { tenantId });
    if (filter.from) qb.andWhere('m.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('m.created_at < :to', { to: new Date(filter.to) });
    return qb;
  }

  private scopedUsage(
    tenantId: string,
    filter: AiAnalyticsFilterDto,
  ): SelectQueryBuilder<AiUsageLog> {
    const qb = this.usageLogs
      .createQueryBuilder('u')
      .leftJoin('u.tenant', 't')
      .where('t.id = :tenantId', { tenantId });
    if (filter.from) qb.andWhere('u.period_month >= :fromM', { fromM: this.monthKey(filter.from) });
    if (filter.to) qb.andWhere('u.period_month <= :toM', { toM: this.monthKey(filter.to) });
    return qb;
  }

  private scopedCost(
    tenantId: string,
    filter: AiAnalyticsFilterDto,
  ): SelectQueryBuilder<AiCostLog> {
    const qb = this.costLogs
      .createQueryBuilder('c')
      .leftJoin('c.tenant', 't')
      .where('t.id = :tenantId', { tenantId });
    if (filter.from) qb.andWhere('c.period_month >= :fromM', { fromM: this.monthKey(filter.from) });
    if (filter.to) qb.andWhere('c.period_month <= :toM', { toM: this.monthKey(filter.to) });
    return qb;
  }
}
