import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Long-term AI memory (Feature 5). The scalar table `ai_memories`; the pgvector
 * embedding lives in the `ai_memory_embeddings` sidecar created idempotently by
 * `AiMemoryVectorService` at bootstrap (same split as the KB embeddings, so a
 * `synchronize=true` dev DB never drops the vector column).
 */
export class AiMemories1730002400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "ai_memories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid,
        "customer_id" uuid,
        "ai_conversation_id" uuid,
        "type" character varying(32) NOT NULL,
        "content" text NOT NULL,
        "importance" integer NOT NULL DEFAULT 1,
        "metadata" jsonb,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_memories" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_memories_tenant_customer" ON "ai_memories" ("tenantId", "customer_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_memories_expires" ON "ai_memories" ("expires_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_ai_memories_expires"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_ai_memories_tenant_customer"`);
    await q.query(`DROP TABLE IF EXISTS "ai_memories"`);
  }
}
