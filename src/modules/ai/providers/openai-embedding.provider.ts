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
import { OpenAiClientProvider } from './openai-client.provider';
import { QueueService } from '../../../queue/queue.service';
import { cacheKeyPrefix } from '../../../queue/queue.constants';
import { MetricsService } from '../../../metrics/metrics.service';
import { AiCostLedgerService } from '../cost/ai-cost-ledger.service';

/**
 * Binary Float32 encoding for a cached embedding vector (M5 —
 * docs/CACHING_QUEUES_AUDIT.md): ~6KB base64 instead of ~30KB of JSON text
 * per 1536-dim vector, and no `JSON.parse`/`JSON.stringify` cost. Base64
 * (not a raw Buffer) because `QueueService.kvGet/kvSet/kvMget` are the
 * shared STRING-based KV path used by other call sites too (the reaper
 * heartbeat, etc.) — encoding to a string here avoids adding a
 * buffer-mode variant of those methods for this one caller.
 */
function encodeVector(vector: number[]): string {
  return Buffer.from(Float32Array.from(vector).buffer).toString('base64');
}

function decodeVector(raw: string): number[] {
  const buf = Buffer.from(raw, 'base64');
  const floats = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(floats);
}

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
    // Optional (unit tests set `.client` directly); Nest injects it. Resolves a
    // per-tenant regional client when Data Residency is enforced.
    private readonly clients?: OpenAiClientProvider,
    // Optional (unit tests construct this provider without it); `MetricsModule`
    // is global, so Nest's real DI container always supplies a real instance.
    private readonly metrics?: MetricsService,
  ) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.model = config.get<string>(
      'OPENAI_EMBEDDING_MODEL',
      'text-embedding-3-small',
    );
    this.dimension = Number(config.get<number>('OPENAI_EMBEDDING_DIM', 1536));
    // Bumped v1 -> v2 (M5 — docs/CACHING_QUEUES_AUDIT.md): the cached VALUE
    // encoding changed from a JSON float array to a compact Float32 binary
    // buffer (base64), so a v1 key must never be read back as v2's format.
    // An operator who has explicitly set AI_EMBEDDING_VERSION keeps whatever
    // value they set — only the DEFAULT changes, so an existing deployment
    // that never touched this var gets the bump (and a one-time full
    // cache-miss re-warm) automatically on upgrade.
    this.version = config.get<string>('AI_EMBEDDING_VERSION', 'v2');
    this.cacheEnabled =
      String(config.get('AI_EMBEDDING_CACHE_ENABLED', 'true')) === 'true';
    this.queryTtl = Number(
      config.get('AI_EMBEDDING_QUERY_CACHE_TTL_SECONDS', 86_400),
    );
    this.contentTtl = Number(
      config.get('AI_EMBEDDING_CONTENT_CACHE_TTL_SECONDS', 2_592_000),
    );
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

  async embed(
    tenantId: string,
    texts: string[],
    context: AiEmbeddingContext = {},
  ): Promise<AiEmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], model: this.model, tokens: 0 };
    }
    // Regional client when Data Residency is enforced, else the global client.
    // A fail-closed residency throw propagates (never falls back to global).
    const client =
      (this.clients ? await this.clients.forTenant(tenantId) : undefined) ??
      this.client;
    if (!client) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    const operationKey =
      context.idempotencyKey ??
      `embedding:${createHash('sha256')
        .update(texts.join('\u0000'))
        .digest('hex')}:${randomUUID()}`;
    const vectors: Array<number[] | undefined> = new Array(texts.length);
    let cacheHits = 0;

    // Pass 1 — build every key (no Redis call yet), deduping identical texts
    // within this one batch exactly as before.
    const byHash = new Map<
      string,
      { text: string; indexes: number[]; key: string }
    >();
    for (let i = 0; i < texts.length; i += 1) {
      const normalized = texts[i].normalize('NFKC').trim().replace(/\s+/g, ' ');
      const hash = createHash('sha256').update(normalized).digest('hex');
      const key = `${cacheKeyPrefix()}ai:emb:${tenantId}:openai:${this.model}:${this.version}:${hash}`;
      const existing = byHash.get(hash);
      if (existing) existing.indexes.push(i);
      else byHash.set(hash, { text: texts[i], indexes: [i], key });
    }

    // Pass 2 — ONE MGET for every unique key (M5), instead of one GET per
    // text: embedding 100 chunks used to mean 100 sequential Redis round
    // trips before the provider call even started.
    const uniqueEntries = [...byHash.values()];
    const cachedValues = await this.cacheMget(uniqueEntries.map((e) => e.key));

    const misses = new Map<
      string,
      { text: string; indexes: number[]; key: string }
    >();
    uniqueEntries.forEach((entry, i) => {
      const cached = cachedValues[i];
      if (cached) {
        for (const index of entry.indexes) vectors[index] = cached;
        cacheHits += entry.indexes.length;
        this.metrics?.recordCacheOperation('embedding', 'hit');
      } else {
        misses.set(entry.key, entry);
        this.metrics?.recordCacheOperation('embedding', 'miss');
      }
    });

    let tokens = 0;
    let providerAttempts = 0;
    const uniqueMisses = [...misses.values()];
    if (uniqueMisses.length) {
      let res: Awaited<ReturnType<OpenAI['embeddings']['create']>>;
      let attempts: number;
      try {
        const attempt = await this.policy.execute(
          () =>
            client.embeddings.create(
              { model: this.model, input: uniqueMisses.map((m) => m.text) },
              context.signal ? { signal: context.signal } : undefined,
            ),
          'embeddings',
        );
        res = attempt.value;
        attempts = attempt.attempts;
      } catch (err) {
        await this.costs.record({
          tenantId,
          aiConversationId: context.aiConversationId,
          idempotencyKey: `${operationKey}:failure`,
          requestKind: 'EMBEDDING',
          provider: 'openai',
          model: this.model,
          feature: context.feature ?? 'embedding',
          route: context.route ?? 'embedding',
          channel: context.channel ?? 'INTERNAL',
          success: false,
          errorCode: 'UNKNOWN_PROVIDER_OUTCOME',
          quote: {
            status: 'UNPRICED',
            provider: 'openai',
            requestedModel: this.model,
            executionMode: 'STANDARD',
            costMicrousd: null,
          },
        });
        throw err;
      }
      tokens = res.usage?.total_tokens ?? 0;
      providerAttempts = attempts;
      for (let i = 0; i < uniqueMisses.length; i += 1) {
        const vector = res.data[i]?.embedding as number[] | undefined;
        if (!vector)
          throw new Error('Embedding provider returned an incomplete batch');
        for (const index of uniqueMisses[i].indexes) vectors[index] = vector;
        await this.cacheSet(
          uniqueMisses[i].key,
          vector,
          context.kind === 'QUERY' ? this.queryTtl : this.contentTtl,
        );
      }
    }

    const quote = this.costs.quoteEmbedding(this.model, tokens);
    await this.costs.record({
      tenantId,
      aiConversationId: context.aiConversationId,
      idempotencyKey: operationKey,
      requestKind: 'EMBEDDING',
      provider: 'openai',
      model: this.model,
      feature: context.feature ?? 'embedding',
      route: context.route ?? 'embedding',
      channel: context.channel ?? 'INTERNAL',
      embeddingTokens: tokens,
      providerAttempts: Math.max(1, providerAttempts),
      cacheHit: uniqueMisses.length === 0,
      cachedRequestCount: cacheHits,
      success: true,
      quote,
    });
    if (providerAttempts > 1) {
      await this.costs.record({
        tenantId,
        aiConversationId: context.aiConversationId,
        idempotencyKey: `${operationKey}:retry-uncertainty`,
        requestKind: 'EMBEDDING',
        provider: 'openai',
        model: this.model,
        feature: context.feature ?? 'embedding',
        route: context.route ?? 'embedding',
        channel: context.channel ?? 'INTERNAL',
        success: false,
        errorCode: 'RETRY_USAGE_UNKNOWN',
        quote: {
          status: 'UNPRICED',
          provider: 'openai',
          requestedModel: this.model,
          executionMode: 'STANDARD',
          costMicrousd: null,
        },
      });
    }

    return {
      vectors: vectors as number[][],
      model: this.model,
      tokens,
      cacheHits,
      cacheMisses: uniqueMisses.length,
      providerAttempts,
    };
  }

  /**
   * Batched read (M5): one `MGET` for every unique key in the batch, instead
   * of one `GET` per text. Returns `undefined` for a miss/decode failure at
   * each position, positionally aligned with `keys`.
   */
  private async cacheMget(
    keys: string[],
  ): Promise<Array<number[] | undefined>> {
    if (!this.cacheEnabled || keys.length === 0)
      return keys.map(() => undefined);
    try {
      const raw = await this.queue.kvMget(keys);
      return raw.map((value) => {
        if (!value) return undefined;
        try {
          return decodeVector(value);
        } catch {
          // One corrupt/foreign-format entry must not fail the whole batch —
          // treat it as a miss (it gets recomputed and overwritten below).
          return undefined;
        }
      });
    } catch (err) {
      this.logger.warn(
        `Embedding cache batch read unavailable: ${(err as Error).message}`,
      );
      return keys.map(() => undefined);
    }
  }

  private async cacheSet(
    key: string,
    vector: number[],
    ttl: number,
  ): Promise<void> {
    if (!this.cacheEnabled) return;
    try {
      // Binary encoding (M5): a Float32 buffer, base64-encoded for the
      // existing string-based KV path, instead of a JSON float array — ~6KB
      // instead of ~30KB per 1536-dim vector, and no `JSON.parse` cost on
      // the read side (`decodeVector` reinterprets the buffer directly).
      await this.queue.kvSet(key, encodeVector(vector), ttl);
    } catch (err) {
      this.logger.warn(
        `Embedding cache write unavailable: ${(err as Error).message}`,
      );
    }
  }
}
