import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * pgvector schema for semantic RAG. Canonical for migrations-first
 * (synchronize=false) deployments. Mirrors PgVectorBootstrapService exactly, so
 * either path produces the same schema. Idempotent.
 *
 * Stores embeddings in a dedicated sidecar table (1:1 with ai_knowledge_bases)
 * to avoid TypeORM `synchronize` clobbering a `vector`-typed column. When moving
 * fully to migrations-first, embeddings may instead be inlined as a
 * `vector(N)` column on `ai_knowledge_bases`.
 */
export class AiPgVector1730000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // Explicit opt-out: an operator can disable pgvector entirely (RAG runs on
    // keyword fallback only) without this migration ever touching the DB.
    if (String(process.env.AI_PGVECTOR_ENABLED ?? 'true') === 'false') {
      console.warn(
        '[AiPgVector] AI_PGVECTOR_ENABLED=false — skipping AI vector schema.',
      );
      return;
    }

    // H3: FAIL-SAFE for non-production. The `vector` extension may be unavailable
    // on a given server. We must NOT *issue* a failing CREATE EXTENSION here:
    // migrations run inside a transaction, and a failed statement poisons the
    // whole tx (aborting the ordered run and blocking the critical payments
    // migrations). So we first check pg_available_extensions and skip cleanly
    // when absent — no failing statement, no tx abort.
    const available: unknown[] = await q.query(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`,
    );
    if (available.length === 0) {
      const message =
        '"vector" extension is not available on this Postgres server. ' +
        'AI semantic search (RAG) requires it — install pgvector, or set AI_PGVECTOR_ENABLED=false to explicitly run on keyword-only retrieval.';
      // PRODUCTION must not silently degrade a feature an operator believes is
      // enabled (AI_PGVECTOR_ENABLED defaults to true): fail the deploy loudly,
      // the same fail-fast pattern used for payments/synchronize elsewhere in
      // this migration set. Non-production environments (dev/test/staging
      // sandboxes) keep the original soft-skip so a laptop without pgvector
      // still boots and RAG degrades to keyword search.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`[AiPgVector] ${message}`);
      }

      console.warn(
        `[AiPgVector] ${message} Continuing (non-production) — RAG falls back to keyword search.`,
      );
      return;
    }
    await q.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    // Dimension must match OpenAI's OPENAI_EMBEDDING_DIM (same env var
    // PgVectorBootstrapService reads) so the migrations-first schema never
    // silently disagrees with the dev/bootstrap-created one.
    const dim = Number(process.env.OPENAI_EMBEDDING_DIM ?? 1536);
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(
        `[AiPgVector] OPENAI_EMBEDDING_DIM must be a positive integer, got "${process.env.OPENAI_EMBEDDING_DIM}"`,
      );
    }
    await q.query(`
      CREATE TABLE IF NOT EXISTS ai_kb_embeddings (
        kb_id      uuid PRIMARY KEY REFERENCES ai_knowledge_bases(id) ON DELETE CASCADE,
        tenant_id  uuid NOT NULL,
        agent_id   uuid NOT NULL,
        embedding  vector(${dim}) NOT NULL,
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
