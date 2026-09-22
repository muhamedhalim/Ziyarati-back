import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

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
   * Retrieves the most relevant knowledge chunks for a tenant (+ optionally an
   * agent) and query. Always tenant-scoped; when `agentId` is given, matches
   * chunks bound to that agent OR left unbound (agents are Admin-managed
   * platform config, so a tenant may have knowledge before one exists).
   *
   * `timing`, when passed, is populated with `embeddingMs` (Advanced AI
   * Monitoring) — an optional out-param so existing callers are unaffected.
   */
  async retrieve(
    tenantId: string,
    agentId: string | null,
    query: string,
    limit?: number,
    timing?: {
      embeddingMs?: number;
      embeddingTokens?: number;
      embeddingCacheHits?: number;
      /** AI-013 (FR-065-FR-067): which path actually produced the result — set on every return, including the attempted-then-fell-back case. */
      retrievalMode?: 'vector' | 'keyword';
    },
    attribution?: { channel?: string; aiConversationId?: string; idempotencyKey?: string },
  ): Promise<RetrievedChunk[]> {
    const topK = Math.max(1, Math.min(20, limit ?? Number(this.config.get<number>('RAG_TOP_K', 5))));

    if (this.embedder.isConfigured() && this.pgvector.isAvailable()) {
      try {
        const { chunks, hadCandidates } = await this.vectorSearch(tenantId, agentId, query, topK, timing, attribution);
        if (chunks.length > 0) {
          if (timing) timing.retrievalMode = 'vector';
          return chunks;
        }
        // F-08: two DIFFERENT empty results were previously conflated.
        //  - `hadCandidates` false: the ANN join found NOTHING at all for this
        //    tenant/agent — most likely a row that has never been embedded yet
        //    (ingestion lag, an embedding failure). Keyword search reads
        //    `ai_knowledge_bases.content` directly and can still find that row
        //    by exact text match, so it gets a real chance.
        //  - `hadCandidates` true: the ANN join DID find rows, and every one
        //    of them scored below the relevance floor — the tenant's
        //    knowledge genuinely has nothing relevant. Falling back to
        //    keyword here would defeat the floor: keyword scoring alone can
        //    match on a single common word, which is exactly how an unrelated
        //    chunk got shown as "knowledge" for an off-topic question. This
        //    case returns empty, on purpose.
        if (!hadCandidates) {
          if (timing) timing.retrievalMode = 'keyword';
          return this.keywordSearch(tenantId, agentId, query, topK);
        }
        if (timing) timing.retrievalMode = 'vector';
        return [];
      } catch (err) {
        this.logger.warn(
          `Vector search failed (${(err as Error).message}) — using keyword fallback`,
        );
      }
    }
    // Reached on a pure keyword-only deployment, and when the vector path threw
    // — the recorded value matches the path actually taken, never the path
    // merely attempted (FR-067).
    if (timing) timing.retrievalMode = 'keyword';
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

  /**
   * `hadCandidates` tells `retrieve()` WHY the result may be empty: false
   * means the ANN join found no row at all (most likely nothing has been
   * embedded yet — a keyword fallback deserves a chance); true means rows
   * were found and scored, and every one fell below the relevance floor — a
   * real "nothing relevant" answer that a keyword fallback must not override.
   */
  private async vectorSearch(
    tenantId: string,
    agentId: string | null,
    query: string,
    topK: number,
    timing?: { embeddingMs?: number; embeddingTokens?: number; embeddingCacheHits?: number },
    attribution?: { channel?: string; aiConversationId?: string; idempotencyKey?: string },
  ): Promise<{ chunks: RetrievedChunk[]; hadCandidates: boolean }> {
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
    if (!queryVec) return { chunks: [], hadCandidates: false };

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
        WHERE e.tenant_id = $2 AND (e.agent_id = $3 OR e.agent_id IS NULL)
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

    // F-08: without a floor, the ANN query above always returns its top-K
    // rows by similarity ORDER, even when the best of them barely resembles
    // the question — a live run injected a near-zero-score chunk as
    // "knowledge" for a question the tenant's KB had nothing on. A chunk that
    // does not clear the floor is worse than no chunk at all.
    const minScore = Number(this.config.get<number>('RAG_MIN_SCORE', 0.5));
    const chunks = uniqueRows
      .map((r: Record<string, unknown>) => ({
        id: r.id as string,
        content: r.content as string,
        sourceType: (r.sourceType as string) ?? undefined,
        sourceId: (r.sourceId as string) ?? undefined,
        score: Number(r.score),
      }))
      .filter((c) => c.score >= minScore);
    return { chunks, hadCandidates: uniqueRows.length > 0 };
  }

  // ──────────────────────────── Keyword fallback ─────────────────────────── //

  private async keywordSearch(
    tenantId: string,
    agentId: string | null,
    query: string,
    topK: number,
  ): Promise<RetrievedChunk[]> {
    const terms = this.tokenize(query);
    // Matches chunks bound to `agentId` OR left unbound — same tenant-scoped
    // "agent OR unbound" semantics as vectorSearch's WHERE clause.
    const candidates = await this.kb.find({
      where: agentId
        ? [
            { tenant: { id: tenantId }, agent: { id: agentId } },
            { tenant: { id: tenantId }, agent: IsNull() },
          ]
        : { tenant: { id: tenantId }, agent: IsNull() },
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
