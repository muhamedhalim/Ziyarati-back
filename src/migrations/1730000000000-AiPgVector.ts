import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * pgvector schema for semantic RAG. Canonical for migrations-first
 * (synchronize=false) deployments. Mirrors PgVectorBootstrapService exactly, so
 * either path produces the same schema. Idempotent.
 *
 * Stores embeddings in a dedicated sidecar table (1:1 with ai_knowledge_bases)
 * to avoid TypeORM `synchronize` clobbering a `vector`-typed column. When moving
 * fully to migrations-first, embeddings may instead be inlined as a
 * `vector(1536)` column on `ai_knowledge_bases`.
 */
export class AiPgVector1730000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS ai_kb_embeddings (
        kb_id      uuid PRIMARY KEY REFERENCES ai_knowledge_bases(id) ON DELETE CASCADE,
        tenant_id  uuid NOT NULL,
        agent_id   uuid NOT NULL,
        embedding  vector(1536) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_kb_emb_tenant_agent
      ON ai_kb_embeddings (tenant_id, agent_id)
    `);
    await q.query(`SET maintenance_work_mem = '512MB'`);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_kb_emb_hnsw
      ON ai_kb_embeddings
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS ai_kb_embeddings`);
  }
}
