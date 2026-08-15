/**
 * Scripted embedding-provider double for Feature 011.
 *
 * FR-103 note not covered by `scripted-ai-provider.ts` alone: `.env` configures a
 * live `OPENAI_API_KEY` (see `environment-record.md` §provider), and
 * `AiEmbeddingProvider`/`OpenAiEmbeddingProvider` (`../../../src/modules/ai/
 * providers/openai-embedding.provider.ts`) is a SEPARATE DI token
 * (`AI_EMBEDDING_PROVIDER`) from the chat-completion seam. RAG ingestion
 * (`ai-knowledge-ingestion.service.ts`) and query embedding
 * (`ai-rag.service.ts`) would call the real OpenAI embeddings API unless this
 * token is also overridden in the audit harness — overriding only
 * `AI_COMPLETION_PROVIDERS` is NOT sufficient on its own.
 *
 * Produces small, fully deterministic vectors via a bag-of-words hash so that
 * (a) no network call is ever made, and (b) tests that plant near-duplicate or
 * shared-vocabulary text (e.g. W5's "tenant-B content whose best semantic match
 * answers a tenant-A question") get a real, reproducible nearest-neighbor result
 * from pgvector's cosine ANN — this is a similarity function, not a random stub.
 */
import { createHash } from 'node:crypto';
import { AiEmbeddingContext, AiEmbeddingProvider, AiEmbeddingResult } from '../../../src/modules/ai/providers/ai-provider.interface';

/** Deterministic bag-of-words embedding: each lowercased word token hashes into one of `dim` buckets and accumulates; L2-normalized so cosine similarity reflects vocabulary overlap. */
export function hashEmbed(text: string, dim: number): number[] {
  const vector = new Array(dim).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    const digest = createHash('sha256').update(word).digest();
    const bucket = digest.readUInt32BE(0) % dim;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export class ScriptedEmbeddingProvider implements AiEmbeddingProvider {
  private captured: { tenantId: string; texts: string[]; context?: AiEmbeddingContext }[] = [];

  constructor(readonly dimension: number) {}

  isConfigured(): boolean {
    return true;
  }

  get capturedCalls(): readonly { tenantId: string; texts: string[]; context?: AiEmbeddingContext }[] {
    return this.captured;
  }

  reset(): void {
    this.captured = [];
  }

  async embed(tenantId: string, texts: string[], context?: AiEmbeddingContext): Promise<AiEmbeddingResult> {
    this.captured.push({ tenantId, texts: [...texts], context });
    return {
      vectors: texts.map((t) => hashEmbed(t, this.dimension)),
      model: 'scripted-embedding-stub',
      tokens: texts.reduce((sum, t) => sum + (t.match(/[a-z0-9]+/gi)?.length ?? 0), 0),
      cacheHits: 0,
      cacheMisses: texts.length,
      providerAttempts: 1,
    };
  }
}
