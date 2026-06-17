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
    // H3: FAIL-SAFE. The `vector` extension may be unavailable on a given server.
    // We must NOT *issue* a failing CREATE EXTENSION here: migrations run inside a
    // transaction, and a failed statement poisons the whole tx (aborting the
    // ordered run and blocking the critical payments migrations). So we first
    // check pg_available_extensions and skip cleanly when absent — no failing
    // statement, no tx abort. PgVectorBootstrapService re-attempts idempotently on
    // every boot once the extension exists; RAG degrades to keyword search until then.
    const available: unknown[] = await q.query(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`,
    );
    if (available.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[AiPgVector] "vector" extension not available on this server — skipping AI vector schema (payments migrations continue).',
      );
      return;
    }
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
