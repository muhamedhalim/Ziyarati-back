import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AiExecutionMetric } from '../../entities/AI Agent/AiExecutionMetric';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AiAnalyticsFilterDto } from './dto/ai-analytics-filter.dto';

export interface RecordMetricInput {
  tenantId: string;
  aiConversationId?: string;
  channel: string;
  model: string;
  feature?: string;
  route?: string;
  idempotencyKey?: string;
  streamed: boolean;
  fallback: boolean;
  success: boolean;
  errorMessage?: string;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  embeddingTokens?: number;
  costUsd: number | null;
  costMicrousd?: bigint | null;
  pricingStatus?: string;
  toolLoopCount?: number;
  providerAttempts?: number;
  cachedRequestCount?: number;
  truncatedPromptTokens?: number;
  ragRetrievalMs?: number;
  embeddingMs?: number;
  /** AI-013 (FR-065-FR-067): which retrieval path produced this turn's RAG context, or unset for a turn that never called RAG. */
  retrievalMode?: 'vector' | 'keyword';
  toolCallsCount: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  /** AI-023 (FR-048, FR-049, FR-087): tool calls refused by the per-round fan-out cap, never silent. */
  toolCallsTruncated: number;
  /** AI-009 (FR-087, SD-1 point 6): the disclosure check redacted this turn's reply, never silent. */
  promptDisclosureBlocked: boolean;
  toolExecMs: number;
  firstTokenMs?: number;
  streamingDurationMs?: number;
  totalLatencyMs: number;
  /** AI-016 (M2, FR-030): same id as the ai_tool_calls rows for this turn. */
  correlationId?: string | null;
  /** AI-017 (M2, FR-033, FR-034): acting staff principal; null for guests. */
  actorUserId?: string | null;
  /**
   * How the turn was processed (execution mode × data residency). Optional on
   * the input so the two failure paths — which may fail before the policy is
   * resolved — can omit it; `record()` then persists the safe default label
   * rather than inventing a residency claim.
   */
  processing?: {
    label: string;
    executionMode: string;
    residencyRequired: boolean;
    region: string | null;
    reason: string;
  };
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Advanced AI Monitoring — the write side (`record`) is called by
 * `AiExecutionService` after every turn (best-effort, never throws so a metrics
 * failure can never break an AI reply). The read side (`summary`/`timeSeries`)
 * computes real percentiles (Postgres `percentile_cont`, not fabricated),
 * tenant-scoped; no controller exposes it to the clinic owner (that surface —
 * the clinic's own "AI Monitoring" tab — was removed). The platform-wide
 * equivalent lives in `platform-ai-monitoring` (raw queries over the SAME
 * table — no duplication).
 */
@Injectable()
export class AiMetricsService {
  private readonly logger = new Logger('AiMetricsService');

  constructor(
    @InjectRepository(AiExecutionMetric)
    private readonly metrics: Repository<AiExecutionMetric>,
    private readonly dataSource: DataSource,
  ) {}

  /** Best-effort insert — a metrics failure must never break the AI turn. */
  async record(input: RecordMetricInput): Promise<void> {
    try {
      await this.metrics.save(
        this.metrics.create({
          tenant: { id: input.tenantId } as Tenant,
          ai_conversation_id: input.aiConversationId,
          channel: input.channel,
          model: input.model,
          feature: input.feature ?? 'chat',
          route: input.route ?? 'ai.chat',
          idempotency_key: input.idempotencyKey,
          streamed: input.streamed,
          fallback: input.fallback,
          success: input.success,
          error_message: input.errorMessage,
          prompt_tokens: input.promptTokens,
          completion_tokens: input.completionTokens,
          cached_input_tokens: input.cachedInputTokens ?? 0,
          embedding_tokens: input.embeddingTokens ?? 0,
          total_tokens: input.promptTokens + input.completionTokens,
          cost_usd: input.costUsd,
          cost_microusd: input.costMicrousd?.toString(),
          pricing_status: input.pricingStatus ?? 'UNPRICED',
          tool_loop_count: input.toolLoopCount ?? 0,
          provider_attempts: input.providerAttempts ?? 1,
          provider_retry_count: Math.max(0, (input.providerAttempts ?? 1) - 1),
          cached_request_count: input.cachedRequestCount ?? 0,
          truncated_prompt_tokens: input.truncatedPromptTokens ?? 0,
          rag_retrieval_ms: input.ragRetrievalMs,
          embedding_ms: input.embeddingMs,
          retrieval_mode: input.retrievalMode ?? null,
          tool_calls_count: input.toolCallsCount,
          tool_success_count: input.toolSuccessCount,
          tool_failure_count: input.toolFailureCount,
          tool_calls_truncated: input.toolCallsTruncated,
          prompt_disclosure_blocked: input.promptDisclosureBlocked,
          tool_exec_ms: input.toolExecMs,
          first_token_ms: input.firstTokenMs,
          streaming_duration_ms: input.streamingDurationMs,
          total_latency_ms: input.totalLatencyMs,
          correlation_id: input.correlationId ?? null,
          actor_user_id: input.actorUserId ?? null,
          // Absent input ⇒ the safe combination (synchronous, global region),
          // never a null that reads as "unknown, possibly regional".
          processing_mode: input.processing?.label ?? 'STANDARD',
          data_residency_required: input.processing?.residencyRequired ?? false,
          data_residency_region: input.processing?.region ?? null,
          data_residency_reason: input.processing?.reason ?? null,
        }),
      );
    } catch (err) {
      this.logger.warn(`metric record failed: ${(err as Error)?.message}`);
    }
  }

  /** Tenant-scoped aggregate summary: latency percentiles, tokens, and tool/error rates. */
  async summary(tenantId: string, filter: AiAnalyticsFilterDto) {
    const { where, params } = this.scope(tenantId, filter);
    const [row] = await this.dataSource.query(
      `SELECT
         count(*)::int AS n,
         count(*) FILTER (WHERE success = false)::int AS error_count,
         count(*) FILTER (WHERE streamed = true)::int AS streamed_count,
         COALESCE(avg(total_latency_ms), 0) AS avg_latency_ms,
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_latency_ms), 0) AS p50_latency_ms,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_latency_ms), 0) AS p95_latency_ms,
         COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY total_latency_ms), 0) AS p99_latency_ms,
         COALESCE(avg(first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL), 0) AS avg_first_token_ms,
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL), 0) AS p50_first_token_ms,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL), 0) AS p95_first_token_ms,
         COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL), 0) AS p99_first_token_ms,
         COALESCE(avg(streaming_duration_ms) FILTER (WHERE streaming_duration_ms IS NOT NULL), 0) AS avg_streaming_duration_ms,
         COALESCE(avg(rag_retrieval_ms) FILTER (WHERE rag_retrieval_ms IS NOT NULL), 0) AS avg_rag_retrieval_ms,
         COALESCE(avg(embedding_ms) FILTER (WHERE embedding_ms IS NOT NULL), 0) AS avg_embedding_ms,
         COALESCE(avg(tool_exec_ms) FILTER (WHERE tool_calls_count > 0), 0) AS avg_tool_exec_ms,
         COALESCE(sum(tool_calls_count), 0)::int AS tool_calls,
         COALESCE(sum(tool_success_count), 0)::int AS tool_success,
         COALESCE(sum(tool_failure_count), 0)::int AS tool_failure,
         COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
         COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens,
         COALESCE(sum(total_tokens), 0)::bigint AS total_tokens,
         COALESCE(sum(total_latency_ms), 0)::bigint AS total_latency_ms_sum
       FROM ai_execution_metrics
       ${where}`,
      params,
    );

    const byModel = await this.dataSource.query(
      `SELECT model,
              count(*)::int AS requests,
              COALESCE(sum(total_tokens), 0)::bigint AS tokens,
              COALESCE(avg(total_latency_ms), 0) AS avg_latency_ms
         FROM ai_execution_metrics
         ${where}
        GROUP BY model
        ORDER BY requests DESC`,
      params,
    );

    const total = n(row?.n);
    const completionTokens = n(row?.completion_tokens);
    const totalLatencySumSec = n(row?.total_latency_ms_sum) / 1000;

    return {
      tenantId,
      requests: total,
      errorRate: total > 0 ? n(row?.error_count) / total : 0,
      streamedRate: total > 0 ? n(row?.streamed_count) / total : 0,
      latencyMs: {
        avg: n(row?.avg_latency_ms),
        p50: n(row?.p50_latency_ms),
        p95: n(row?.p95_latency_ms),
        p99: n(row?.p99_latency_ms),
      },
      firstTokenMs: {
        avg: n(row?.avg_first_token_ms),
        p50: n(row?.p50_first_token_ms),
        p95: n(row?.p95_first_token_ms),
        p99: n(row?.p99_first_token_ms),
      },
      streamingDurationAvgMs: n(row?.avg_streaming_duration_ms),
      ragRetrievalAvgMs: n(row?.avg_rag_retrieval_ms),
      embeddingAvgMs: n(row?.avg_embedding_ms),
      toolExecAvgMs: n(row?.avg_tool_exec_ms),
      tools: {
        calls: n(row?.tool_calls),
        succeeded: n(row?.tool_success),
        failed: n(row?.tool_failure),
        successRate:
          n(row?.tool_calls) > 0
            ? n(row?.tool_success) / n(row?.tool_calls)
            : null,
      },
      tokens: {
        prompt: n(row?.prompt_tokens),
        completion: completionTokens,
        total: n(row?.total_tokens),
        perSecond:
          totalLatencySumSec > 0
            ? +(completionTokens / totalLatencySumSec).toFixed(2)
            : 0,
      },
      byModel: byModel.map((m: Record<string, unknown>) => ({
        model: m.model as string,
        requests: n(m.requests),
        tokens: n(m.tokens),
        avgLatencyMs: n(m.avg_latency_ms),
      })),
    };
  }

  /** Daily time series for charts: requests, avg latency, tokens, and errors. */
  async timeSeries(tenantId: string, filter: AiAnalyticsFilterDto) {
    const { where, params } = this.scope(tenantId, filter);
    const rows = await this.dataSource.query(
      `SELECT date_trunc('day', created_at) AS day,
              count(*)::int AS requests,
              COALESCE(avg(total_latency_ms), 0) AS avg_latency_ms,
              COALESCE(sum(total_tokens), 0)::bigint AS tokens,
              count(*) FILTER (WHERE success = false)::int AS errors
         FROM ai_execution_metrics
         ${where}
        GROUP BY day
        ORDER BY day ASC`,
      params,
    );
    return rows.map((r: Record<string, unknown>) => ({
      date: (r.day as Date).toISOString().slice(0, 10),
      requests: n(r.requests),
      avgLatencyMs: n(r.avg_latency_ms),
      tokens: n(r.tokens),
      errors: n(r.errors),
    }));
  }

  private scope(
    tenantId: string,
    filter: AiAnalyticsFilterDto,
  ): { where: string; params: unknown[] } {
    const params: unknown[] = [tenantId];
    let where = `WHERE "tenantId" = $1`;
    if (filter.from) {
      params.push(filter.from);
      where += ` AND created_at >= $${params.length}`;
    }
    if (filter.to) {
      params.push(filter.to);
      where += ` AND created_at < $${params.length}`;
    }
    return { where, params };
  }
}
