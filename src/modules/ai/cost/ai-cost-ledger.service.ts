import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AiPriceCatalogService, AiPriceQuote } from './ai-price-catalog.service';
import { currentPeriodMonth } from '../ai.constants';

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

  quoteChat(model: string, input: number, output: number, cached = 0, provider = 'openai') {
    return this.prices.quoteChat(provider, model, input, output, cached);
  }

  quoteEmbedding(model: string, tokens: number) {
    return this.prices.quoteEmbedding('openai', model, tokens);
  }

  /** Idempotent append + monthly aggregate update in one transaction. */
  async record(input: AiCostRecordInput): Promise<{ inserted: boolean; costMicrousd: bigint | null }> {
    const key = input.idempotencyKey ?? randomUUID();
    try {
      return await this.dataSource.transaction(async (m) => {
        const rows = await m.query(
          `INSERT INTO ai_cost_entries (
             tenant_id, ai_conversation_id, idempotency_key, request_kind,
             provider, model, feature, route, channel, input_tokens,
             cached_input_tokens, output_tokens, embedding_tokens, tool_loop_index,
             provider_attempts, cache_hit, cached_request_count, success, error_code,
             pricing_status, price_catalog_version, price_source, price_effective_at,
             input_price_microusd_per_million, cached_input_price_microusd_per_million,
             output_price_microusd_per_million, embedding_price_microusd_per_million,
             cost_microusd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
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
            input.quote.costMicrousd?.toString() ?? null,
          ],
        );
        if (!rows[0]?.id) return { inserted: false, costMicrousd: input.quote.costMicrousd };

        await m.query(
          `INSERT INTO ai_cost_logs ("tenantId", period_month, input_tokens, output_tokens,
              cached_input_tokens, embedding_tokens, total_cost_usd, cost_microusd, unpriced_requests)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::numeric / 1000000,0),COALESCE($7,0),$8)
           ON CONFLICT ("tenantId", period_month) DO UPDATE SET
             input_tokens=ai_cost_logs.input_tokens+EXCLUDED.input_tokens,
             output_tokens=ai_cost_logs.output_tokens+EXCLUDED.output_tokens,
             cached_input_tokens=ai_cost_logs.cached_input_tokens+EXCLUDED.cached_input_tokens,
             embedding_tokens=ai_cost_logs.embedding_tokens+EXCLUDED.embedding_tokens,
             total_cost_usd=ai_cost_logs.total_cost_usd+EXCLUDED.total_cost_usd,
             cost_microusd=ai_cost_logs.cost_microusd+EXCLUDED.cost_microusd,
             unpriced_requests=ai_cost_logs.unpriced_requests+EXCLUDED.unpriced_requests`,
          [input.tenantId, currentPeriodMonth(), input.inputTokens ?? 0, input.outputTokens ?? 0,
            input.cachedInputTokens ?? 0, input.embeddingTokens ?? 0,
            input.quote.costMicrousd?.toString() ?? null, input.quote.costMicrousd === null ? 1 : 0],
        );
        return { inserted: true, costMicrousd: input.quote.costMicrousd };
      });
    } catch (err) {
      // Telemetry is best-effort and must never break a patient-facing response.
      // A ledger outage must be operationally visible even though it must not
      // take down a patient-facing chat response. No prompt/response is logged.
      this.logger.error(`AI cost ledger write failed: ${(err as Error).message}`);
      return { inserted: false, costMicrousd: input.quote.costMicrousd };
    }
  }

  static toUsdNumber(microusd: bigint | null): number | null {
    if (microusd === null) return null;
    return Number(microusd) / 1_000_000;
  }
}
