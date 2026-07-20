import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createHash, randomUUID } from 'node:crypto';

import {
  AiEmbeddingProvider,
  AiEmbeddingResult,
  AiEmbeddingContext,
} from './ai-provider.interface';
import { OpenAiRequestPolicy } from './openai-request-policy';
import { QueueService } from '../../../queue/queue.service';
import { AiCostLedgerService } from '../cost/ai-cost-ledger.service';

/**
 * OpenAI embeddings provider (`text-embedding-3-small` by default, 1536 dims).
 *
 * Used only by the RAG + ingestion layers. `isConfigured()` lets callers degrade
 * gracefully (keyword fallback / skip-embedding) when no API key is present, so
 * the app boots without OpenAI.
 *
 * NOTE: a query/chunk embedding cache (Redis, keyed by sha256(model|text)) is the
 * recommended next optimization; the `embed` seam is where it plugs in.
 */
@Injectable()
export class OpenAiEmbeddingProvider implements AiEmbeddingProvider {
  private readonly logger = new Logger('OpenAiEmbeddingProvider');
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly version: string;
  private readonly cacheEnabled: boolean;
  private readonly queryTtl: number;
  private readonly contentTtl: number;
  private readonly policy: OpenAiRequestPolicy;
  readonly dimension: number;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly costs: AiCostLedgerService,
  ) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.model = config.get<string>('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');
    this.dimension = Number(config.get<number>('OPENAI_EMBEDDING_DIM', 1536));
    this.version = config.get<string>('AI_EMBEDDING_VERSION', 'v1');
    this.cacheEnabled = String(config.get('AI_EMBEDDING_CACHE_ENABLED', 'true')) === 'true';
    this.queryTtl = Number(config.get('AI_EMBEDDING_QUERY_CACHE_TTL_SECONDS', 86_400));
    this.contentTtl = Number(config.get('AI_EMBEDDING_CONTENT_CACHE_TTL_SECONDS', 2_592_000));
    this.policy = new OpenAiRequestPolicy(
      Number(config.get('OPENAI_PROVIDER_MAX_RETRIES', 2)),
      Number(config.get('OPENAI_RETRY_BASE_MS', 500)),
      this.logger,
    );
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        timeout: Number(config.get('OPENAI_REQUEST_TIMEOUT_MS', 30_000)),
        maxRetries: 0,
      });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async embed(tenantId: string, texts: string[], context: AiEmbeddingContext = {}): Promise<AiEmbeddingResult> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    if (texts.length === 0) {
      return { vectors: [], model: this.model, tokens: 0 };
    }
    const operationKey = context.idempotencyKey ?? `embedding:${createHash('sha256')
      .update(texts.join('\u0000')).digest('hex')}:${randomUUID()}`;
    const vectors: Array<number[] | undefined> = new Array(texts.length);
    const misses = new Map<string, { text: string; indexes: number[]; key: string }>();
    let cacheHits = 0;

    for (let i = 0; i < texts.length; i += 1) {
      const normalized = texts[i].normalize('NFKC').trim().replace(/\s+/g, ' ');
      const hash = createHash('sha256').update(normalized).digest('hex');
      const key = `ai:emb:${tenantId}:openai:${this.model}:${this.version}:${hash}`;
      const cached = await this.cacheGet(key);
      if (cached) {
        vectors[i] = cached;
        cacheHits += 1;
      } else {
        const existing = misses.get(hash);
        if (existing) existing.indexes.push(i);
        else misses.set(hash, { text: texts[i], indexes: [i], key });
      }
    }

    let tokens = 0;
    let providerAttempts = 0;
    const uniqueMisses = [...misses.values()];
    if (uniqueMisses.length) {
      let res: Awaited<ReturnType<OpenAI['embeddings']['create']>>;
      let attempts: number;
      try {
        const attempt = await this.policy.execute(
          () => this.client!.embeddings.create(
            { model: this.model, input: uniqueMisses.map((m) => m.text) },
            context.signal ? { signal: context.signal } : undefined,
          ),
          'embeddings',
        );
        res = attempt.value;
        attempts = attempt.attempts;
      } catch (err) {
        await this.costs.record({
          tenantId, aiConversationId: context.aiConversationId,
          idempotencyKey: `${operationKey}:failure`,
          requestKind: 'EMBEDDING', provider: 'openai', model: this.model,
          feature: context.feature ?? 'embedding', route: context.route ?? 'embedding', channel: context.channel ?? 'INTERNAL',
          success: false, errorCode: 'UNKNOWN_PROVIDER_OUTCOME',
          quote: { status: 'UNPRICED', provider: 'openai', requestedModel: this.model, executionMode: 'STANDARD', costMicrousd: null },
        });
        throw err;
      }
      tokens = res.usage?.total_tokens ?? 0;
      providerAttempts = attempts;
      for (let i = 0; i < uniqueMisses.length; i += 1) {
        const vector = res.data[i]?.embedding as number[] | undefined;
        if (!vector) throw new Error('Embedding provider returned an incomplete batch');
        for (const index of uniqueMisses[i].indexes) vectors[index] = vector;
        await this.cacheSet(uniqueMisses[i].key, vector, context.kind === 'QUERY' ? this.queryTtl : this.contentTtl);
      }
    }

    const quote = this.costs.quoteEmbedding(this.model, tokens);
    await this.costs.record({
      tenantId,
      aiConversationId: context.aiConversationId,
      idempotencyKey: operationKey,
      requestKind: 'EMBEDDING', provider: 'openai', model: this.model,
      feature: context.feature ?? 'embedding', route: context.route ?? 'embedding', channel: context.channel ?? 'INTERNAL',
      embeddingTokens: tokens, providerAttempts: Math.max(1, providerAttempts), cacheHit: uniqueMisses.length === 0,
      cachedRequestCount: cacheHits, success: true, quote,
    });
    if (providerAttempts > 1) {
      await this.costs.record({
        tenantId, aiConversationId: context.aiConversationId,
        idempotencyKey: `${operationKey}:retry-uncertainty`,
        requestKind: 'EMBEDDING', provider: 'openai', model: this.model,
        feature: context.feature ?? 'embedding', route: context.route ?? 'embedding', channel: context.channel ?? 'INTERNAL',
        success: false, errorCode: 'RETRY_USAGE_UNKNOWN',
        quote: { status: 'UNPRICED', provider: 'openai', requestedModel: this.model, executionMode: 'STANDARD', costMicrousd: null },
      });
    }

    return {
      vectors: vectors as number[][],
      model: this.model, tokens, cacheHits, cacheMisses: uniqueMisses.length, providerAttempts,
    };
  }

  private async cacheGet(key: string): Promise<number[] | undefined> {
    if (!this.cacheEnabled) return undefined;
    try {
      const raw = await this.queue.kvGet(key);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number') ? parsed : undefined;
    } catch (err) {
      this.logger.warn(`Embedding cache read unavailable: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async cacheSet(key: string, vector: number[], ttl: number): Promise<void> {
    if (!this.cacheEnabled) return;
    try {
      await this.queue.kvSet(key, JSON.stringify(vector), ttl);
    } catch (err) {
      this.logger.warn(`Embedding cache write unavailable: ${(err as Error).message}`);
    }
  }
}
