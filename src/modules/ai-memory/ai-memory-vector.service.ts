import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { toSqlVector } from '../ai/rag/pgvector.util';

/** Sidecar table for memory embeddings (1:1 with ai_memories). */
export const AI_MEMORY_EMBEDDINGS_TABLE = 'ai_memory_embeddings';

export interface MemoryMatch {
  memoryId: string;
  score: number;
}

/**
 * pgvector plumbing for long-term memory (Feature 5). Mirrors the KB embeddings
 * approach EXACTLY (dedicated sidecar so `synchronize=true` never manages the
 * `vector` column; HNSW cosine; soft-fail so the app always boots) — it reuses
 * the shared `toSqlVector` util and the same `<=>` cosine operator. It stores +
 * searches vectors only; embedding generation is done by the caller via the
 * shared `AI_EMBEDDING_PROVIDER`, so no embedding logic is duplicated.
 */
@Injectable()
export class AiMemoryVectorService implements OnApplicationBootstrap {
  private readonly logger = new Logger('AiMemoryVector');
  private available = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('AI_PGVECTOR_ENABLED', 'true') !== 'true') {
      this.logger.warn('AI_PGVECTOR_ENABLED=false — memory recall will use keyword fallback');
      return;
    }
    const dim = Number(this.config.get<number>('OPENAI_EMBEDDING_DIM', 1536));
    try {
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS ${AI_MEMORY_EMBEDDINGS_TABLE} (
          memory_id   uuid PRIMARY KEY REFERENCES ai_memories(id) ON DELETE CASCADE,
          tenant_id   uuid NOT NULL,
          customer_id uuid,
          embedding   vector(${dim}) NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await this.dataSource.query(
        `CREATE INDEX IF NOT EXISTS idx_ai_mem_emb_tenant ON ${AI_MEMORY_EMBEDDINGS_TABLE} (tenant_id, customer_id)`,
      );
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_mem_emb_hnsw
        ON ${AI_MEMORY_EMBEDDINGS_TABLE}
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
      this.available = true;
      this.logger.log(`memory pgvector ready (dim=${dim}, table=${AI_MEMORY_EMBEDDINGS_TABLE})`);
    } catch (err) {
      this.available = false;
      this.logger.warn(`memory pgvector unavailable (${(err as Error).message}) — keyword fallback`);
    }
  }

  /** Upsert a memory's embedding (best-effort; caller ignores failures). */
  async upsert(
    memoryId: string,
    tenantId: string,
    vector: number[],
    customerId?: string,
  ): Promise<void> {
    if (!this.available) return;
    await this.dataSource.query(
      `INSERT INTO ${AI_MEMORY_EMBEDDINGS_TABLE} (memory_id, tenant_id, customer_id, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding, customer_id = EXCLUDED.customer_id`,
      [memoryId, tenantId, customerId ?? null, toSqlVector(vector)],
    );
  }

  /** Cosine ANN over memory embeddings, tenant (+ optional customer) scoped. */
  async search(
    tenantId: string,
    queryVec: number[],
    topK: number,
    customerId?: string,
  ): Promise<MemoryMatch[]> {
    if (!this.available) return [];
    const efSearch = Math.max(1, Math.floor(Number(this.config.get<number>('HNSW_EF_SEARCH', 60))));
    const vec = toSqlVector(queryVec);
    const params: unknown[] = [vec, tenantId];
    let scope = 'e.tenant_id = $2';
    if (customerId) {
      params.push(customerId);
      scope += ` AND (e.customer_id = $3 OR e.customer_id IS NULL)`;
    } else {
      scope += ' AND e.customer_id IS NULL';
    }
    params.push(topK);
    const limitParam = `$${params.length}`;

    return this.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
      const rows = await m.query(
        `SELECT e.memory_id AS "memoryId", 1 - (e.embedding <=> $1::vector) AS score
           FROM ${AI_MEMORY_EMBEDDINGS_TABLE} e
           JOIN ai_memories mem ON mem.id = e.memory_id
          WHERE ${scope} AND (mem.expires_at IS NULL OR mem.expires_at > now())
          ORDER BY e.embedding <=> $1::vector
          LIMIT ${limitParam}`,
        params,
      );
      return rows.map((r: Record<string, unknown>) => ({ memoryId: r.memoryId as string, score: Number(r.score) }));
    });
  }
}
