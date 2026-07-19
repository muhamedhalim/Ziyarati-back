import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AiKnowledgeBase } from '../../entities/AI Agent/AiKnowledgeBase';
import { AI_EMBEDDING_PROVIDER } from './providers/ai-provider.interface';
import type { AiEmbeddingProvider } from './providers/ai-provider.interface';
import { PgVectorBootstrapService } from './rag/pgvector-bootstrap.service';
import { AI_KB_EMBEDDINGS_TABLE, toSqlVector } from './rag/pgvector.util';

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  sourceType?: string;
  sourceId?: string;
}

/**
 * Retrieval-Augmented Generation retriever.
 *
 * Primary path: pgvector cosine ANN over the `ai_kb_embeddings` sidecar (HNSW),
 * tenant + agent scoped in the WHERE clause (no cross-tenant leakage). Falls back
 * to keyword overlap scoring when embeddings/pgvector are not configured, so the
 * execution layer (which only depends on `retrieve`/`assembleContext`) is
 * unaffected either way.
 *
 * pgvector is confined to THIS service + the ingestion pipeline — never the
 * execution, analytics, controller or DTO layers.
 */
@Injectable()
export class AiRagService {
  private readonly logger = new Logger('AiRagService');

  constructor(
    @InjectRepository(AiKnowledgeBase)
    private readonly kb: Repository<AiKnowledgeBase>,
    @Inject(AI_EMBEDDING_PROVIDER)
    private readonly embedder: AiEmbeddingProvider,
    private readonly pgvector: PgVectorBootstrapService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /**
   * Retrieves the most relevant knowledge chunks for an agent + query.
   *
   * `timing`, when passed, is populated with `embeddingMs` (Advanced AI
   * Monitoring) — an optional out-param so existing callers are unaffected.
   */
  async retrieve(
    tenantId: string,
    agentId: string,
    query: string,
    limit?: number,
    timing?: { embeddingMs?: number; embeddingTokens?: number; embeddingCacheHits?: number },
    attribution?: { channel?: string; aiConversationId?: string; idempotencyKey?: string },
  ): Promise<RetrievedChunk[]> {
    const topK = Math.max(1, Math.min(20, limit ?? Number(this.config.get<number>('RAG_TOP_K', 5))));

    if (this.embedder.isConfigured() && this.pgvector.isAvailable()) {
      try {
        return await this.vectorSearch(tenantId, agentId, query, topK, timing, attribution);
      } catch (err) {
        this.logger.warn(
          `Vector search failed (${(err as Error).message}) — using keyword fallback`,
        );
      }
    }
    return this.keywordSearch(tenantId, agentId, query, topK);
  }

  /** Builds a single context block from retrieved chunks for prompt assembly. */
  assembleContext(chunks: RetrievedChunk[]): string {
    if (!chunks.length) return '';
    return chunks
      .map((c, i) => `[${i + 1}] (score ${c.score.toFixed(3)}) ${c.content}`)
      .join('\n\n');
  }

  // ──────────────────────────── Vector path ──────────────────────────────── //

  private async vectorSearch(
    tenantId: string,
    agentId: string,
    query: string,
    topK: number,
    timing?: { embeddingMs?: number; embeddingTokens?: number; embeddingCacheHits?: number },
    attribution?: { channel?: string; aiConversationId?: string; idempotencyKey?: string },
  ): Promise<RetrievedChunk[]> {
    const embedStart = Date.now();
    const embedding = await this.embedder.embed(tenantId, [query], {
      kind: 'QUERY', feature: 'rag_search', route: 'ai.chat.rag',
      channel: attribution?.channel ?? 'INTERNAL',
      aiConversationId: attribution?.aiConversationId,
      idempotencyKey: attribution?.idempotencyKey ? `${attribution.idempotencyKey}:rag` : undefined,
    });
    const { vectors } = embedding;
    if (timing) timing.embeddingMs = Date.now() - embedStart;
    if (timing) {
      timing.embeddingTokens = embedding.tokens;
      timing.embeddingCacheHits = embedding.cacheHits ?? 0;
    }
    const queryVec = vectors[0];
    if (!queryVec) return [];

    const efSearch = Math.max(
      1,
      Math.floor(Number(this.config.get<number>('HNSW_EF_SEARCH', 60))),
    );
    const vec = toSqlVector(queryVec);

    // SET LOCAL keeps the recall knob scoped to this transaction (pool-safe).
    const rows = await this.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
      return m.query(
        `
        SELECT k.id AS id,
               k.content AS content,
               k.content_hash AS "contentHash",
               k.source_type AS "sourceType",
               k.source_id AS "sourceId",
               1 - (e.embedding <=> $1::vector) AS score
        FROM ${AI_KB_EMBEDDINGS_TABLE} e
        JOIN ai_knowledge_bases k ON k.id = e.kb_id
        WHERE e.tenant_id = $2 AND e.agent_id = $3
        ORDER BY e.embedding <=> $1::vector
        LIMIT $4
        `,
        [vec, tenantId, agentId, Math.min(80, topK * 4)],
      );
    });

    const uniqueRows = [...new Map(rows.map((row: Record<string, unknown>) => [
      row.contentHash as string,
      row,
    ])).values()].slice(0, topK);

    return uniqueRows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      content: r.content as string,
      sourceType: (r.sourceType as string) ?? undefined,
      sourceId: (r.sourceId as string) ?? undefined,
      score: Number(r.score),
    }));
  }

  // ──────────────────────────── Keyword fallback ─────────────────────────── //

  private async keywordSearch(
    tenantId: string,
    agentId: string,
    query: string,
    topK: number,
  ): Promise<RetrievedChunk[]> {
    const terms = this.tokenize(query);
    const candidates = await this.kb.find({
      where: { tenant: { id: tenantId }, agent: { id: agentId } },
      order: { created_at: 'DESC' },
      take: 200,
    });

    const uniqueCandidates = [...new Map(candidates.map((candidate) => [
      candidate.content_hash || candidate.id,
      candidate,
    ])).values()];

    return uniqueCandidates
      .map((c) => ({
        id: c.id,
        content: c.content,
        sourceType: c.source_type,
        sourceId: c.source_id,
        score: this.score(c.content, terms),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private tokenize(text: string): string[] {
    return Array.from(
      new Set(
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .split(/\s+/)
          .filter((t) => t.length > 2),
      ),
    );
  }

  private score(content: string, terms: string[]): number {
    if (!terms.length) return 0;
    const lc = content.toLowerCase();
    const hits = terms.filter((t) => lc.includes(t)).length;
    return hits / terms.length;
  }
}
