import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { AI_KB_EMBEDDINGS_TABLE } from './pgvector.util';

/**
 * Ensures the pgvector schema exists, idempotently, at application bootstrap.
 *
 * Why a bootstrap (not just a migration): this project runs `synchronize=true`
 * in dev (so configured migrations do NOT run), and a `vector`-typed column
 * mapped on a synchronized entity table would be dropped/altered on every boot.
 * So embeddings live in a DEDICATED sidecar table (`ai_kb_embeddings`, 1:1 with
 * `ai_knowledge_bases`) that TypeORM never manages, created here with
 * `IF NOT EXISTS`. A canonical migration is also provided for migrations-first
 * (synchronize=false) deployments — both are idempotent.
 *
 * Fails SOFT: if the `vector` extension is unavailable on the server (or pgvector
 * is disabled), it logs a warning and marks itself unavailable; the RAG layer
 * then falls back to keyword retrieval. The app always boots.
 */
@Injectable()
export class PgVectorBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PgVectorBootstrap');
  private available = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** True only when the extension + sidecar table + index are in place. */
  isAvailable(): boolean {
    return this.available;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('AI_PGVECTOR_ENABLED', 'true') !== 'true') {
      this.logger.warn('AI_PGVECTOR_ENABLED=false — RAG will use keyword fallback');
      return;
    }

    const dim = Number(this.config.get<number>('OPENAI_EMBEDDING_DIM', 1536));

    try {
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS vector`);

      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS ${AI_KB_EMBEDDINGS_TABLE} (
          kb_id      uuid PRIMARY KEY REFERENCES ai_knowledge_bases(id) ON DELETE CASCADE,
          tenant_id  uuid NOT NULL,
          agent_id   uuid NOT NULL,
          embedding  vector(${dim}) NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      // Cheap pre-filter for tenant/agent scoping (filtered ANN).
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_kb_emb_tenant_agent
        ON ${AI_KB_EMBEDDINGS_TABLE} (tenant_id, agent_id)
      `);

      // HNSW over cosine distance — low-latency, high-recall ANN.
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_kb_emb_hnsw
        ON ${AI_KB_EMBEDDINGS_TABLE}
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);

      this.available = true;
      this.logger.log(`pgvector ready (dim=${dim}, table=${AI_KB_EMBEDDINGS_TABLE}, HNSW/cosine)`);
    } catch (err) {
      this.available = false;
      this.logger.warn(
        `pgvector unavailable (${(err as Error).message}) — RAG falls back to keyword retrieval. ` +
          `Install the Postgres "vector" extension to enable semantic search.`,
      );
    }
  }
}
