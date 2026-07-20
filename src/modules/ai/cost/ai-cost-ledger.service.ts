import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AiPriceCatalogService, AiPriceQuote } from './ai-price-catalog.service';
import { currentPeriodMonth } from '../ai.constants';
import { AI_EXECUTION_MODE, AiExecutionMode } from '../execution/ai-execution.constants';

export interface AiCostRecordInput {
  tenantId: string;
  aiConversationId?: string;
  idempotencyKey?: string;
  requestKind: 'CHAT' | 'EMBEDDING';
  provider: string;
  model: string;
  feature: string;
  route: string;
  channel: string;
  /** STANDARD (synchronous API) or BATCH (OpenAI Batch API). Default STANDARD. */
  executionMode?: AiExecutionMode;
  /** Data-residency region the request was processed in (null = global). */
  region?: string | null;
  /** Owning batch job id, when this entry is part of a batch. */
  batchJobId?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  toolLoopIndex?: number;
  providerAttempts?: number;
  cacheHit?: boolean;
  cachedRequestCount?: number;
  success: boolean;
  errorCode?: string;
  quote: AiPriceQuote;
}

@Injectable()
export class AiCostLedgerService {
  private readonly logger = new Logger(AiCostLedgerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly prices: AiPriceCatalogService,
  ) {}

  quoteChat(
    model: string,
    input: number,
    output: number,
    cached = 0,
    provider = 'openai',
    executionMode: AiExecutionMode = AI_EXECUTION_MODE.STANDARD,
  ) {
    return this.prices.quoteChat(provider, model, input, output, cached, executionMode);
  }

  quoteEmbedding(
    model: string,
    tokens: number,
    executionMode: AiExecutionMode = AI_EXECUTION_MODE.STANDARD,
    provider = 'openai',
  ) {
    return this.prices.quoteEmbedding(provider, model, tokens, executionMode);
  }

  /** Idempotent append + monthly aggregate update in one transaction. */
  async record(input: AiCostRecordInput): Promise<{ inserted: boolean; costMicrousd: bigint | null }> {
    try {
      return await this.dataSource.transaction((m) => this.write(m, input));
    } catch (err) {
      // Telemetry is best-effort and must never break a patient-facing response.
      // A ledger outage must be operationally visible even though it must not
      // take down a patient-facing chat response. No prompt/response is logged.
      this.logger.error(`AI cost ledger write failed: ${(err as Error).message}`);
      return { inserted: false, costMicrousd: input.quote.costMicrousd };
    }
  }

  /**
   * Record on a CALLER-supplied transaction manager, so cost accounting is atomic
   * with the work it prices (e.g. AiBatchService persisting embeddings + item
   * updates + cost together). Errors propagate here — the caller decides.
   */
  recordInTransaction(
    manager: EntityManager,
    input: AiCostRecordInput,
  ): Promise<{ inserted: boolean; costMicrousd: bigint | null }> {
    return this.write(manager, input);
  }

  private async write(
    m: EntityManager,
    input: AiCostRecordInput,
  ): Promise<{ inserted: boolean; costMicrousd: bigint | null }> {
    const key = input.idempotencyKey ?? randomUUID();
    const mode: AiExecutionMode = input.executionMode ?? AI_EXECUTION_MODE.STANDARD;
    const isBatch = mode === AI_EXECUTION_MODE.BATCH;
    const cost = input.quote.costMicrousd;
    // Batch-specific aggregate contributions (kept separate so the dashboard can
    // show standard vs batch spend without rescanning per-entry rows).
    const batchEmbeddingTokens = isBatch && input.requestKind === 'EMBEDDING' ? (input.embeddingTokens ?? 0) : 0;
    const batchCost = isBatch ? cost : null;
    const rows = await m.query(
      `INSERT INTO ai_cost_entries (
             tenant_id, ai_conversation_id, idempotency_key, request_kind,
             provider, model, feature, route, channel, input_tokens,
             cached_input_tokens, output_tokens, embedding_tokens, tool_loop_index,
             provider_attempts, cache_hit, cached_request_count, success, error_code,
             pricing_status, price_catalog_version, price_source, price_effective_at,
             input_price_microusd_per_million, cached_input_price_microusd_per_million,
             output_price_microusd_per_million, embedding_price_microusd_per_million,
             cost_microusd, execution_mode, region, batch_job_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            input.tenantId, input.aiConversationId ?? null, key, input.requestKind,
            input.provider, input.model, input.feature, input.route, input.channel,
            input.inputTokens ?? 0, input.cachedInputTokens ?? 0, input.outputTokens ?? 0,
            input.embeddingTokens ?? 0, input.toolLoopIndex ?? 0,
            input.providerAttempts ?? 1, input.cacheHit ?? false, input.cachedRequestCount ?? 0,
            input.success, input.errorCode ?? null, input.quote.status,
            input.quote.catalogVersion ?? null, input.quote.source ?? null,
            input.quote.effectiveAt ?? null, input.quote.inputMicrousdPerMillion ?? null,
            input.quote.cachedInputMicrousdPerMillion ?? null,
            input.quote.outputMicrousdPerMillion ?? null,
            input.quote.embeddingMicrousdPerMillion ?? null,
            cost?.toString() ?? null, mode, input.region ?? null, input.batchJobId ?? null,
          ],
        );
        if (!rows[0]?.id) return { inserted: false, costMicrousd: cost };

        await m.query(
          `INSERT INTO ai_cost_logs ("tenantId", period_month, input_tokens, output_tokens,
              cached_input_tokens, embedding_tokens, total_cost_usd, cost_microusd, unpriced_requests,
              batch_embedding_tokens, batch_cost_microusd)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::numeric / 1000000,0),COALESCE($7,0),$8,$9,COALESCE($10,0))
           ON CONFLICT ("tenantId", period_month) DO UPDATE SET
             input_tokens=ai_cost_logs.input_tokens+EXCLUDED.input_tokens,
             output_tokens=ai_cost_logs.output_tokens+EXCLUDED.output_tokens,
             cached_input_tokens=ai_cost_logs.cached_input_tokens+EXCLUDED.cached_input_tokens,
             embedding_tokens=ai_cost_logs.embedding_tokens+EXCLUDED.embedding_tokens,
             total_cost_usd=ai_cost_logs.total_cost_usd+EXCLUDED.total_cost_usd,
             cost_microusd=ai_cost_logs.cost_microusd+EXCLUDED.cost_microusd,
             unpriced_requests=ai_cost_logs.unpriced_requests+EXCLUDED.unpriced_requests,
             batch_embedding_tokens=ai_cost_logs.batch_embedding_tokens+EXCLUDED.batch_embedding_tokens,
             batch_cost_microusd=ai_cost_logs.batch_cost_microusd+EXCLUDED.batch_cost_microusd`,
      [input.tenantId, currentPeriodMonth(), input.inputTokens ?? 0, input.outputTokens ?? 0,
        input.cachedInputTokens ?? 0, input.embeddingTokens ?? 0,
        cost?.toString() ?? null, cost === null ? 1 : 0,
        batchEmbeddingTokens, batchCost?.toString() ?? null],
    );
    return { inserted: true, costMicrousd: cost };
  }

  static toUsdNumber(microusd: bigint | null): number | null {
    if (microusd === null) return null;
    return Number(microusd) / 1_000_000;
  }
}
