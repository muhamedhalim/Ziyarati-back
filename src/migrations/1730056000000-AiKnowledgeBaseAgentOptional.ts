import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agents/models are now Admin-managed platform config — a clinic owner can add
 * Knowledge/Training content before the Admin has provisioned an agent for
 * their tenant. `ai_knowledge_bases.agentId` was already nullable at the DB
 * level (the baseline schema never set NOT NULL on it — only the entity/app
 * layer enforced "required"). The one real legacy dependency is the pgvector
 * sidecar (`ai_kb_embeddings.agent_id`, mirrored in `PgVectorBootstrapService`
 * for the `synchronize=true` dev path), which was declared NOT NULL. Dropping
 * it lets a chunk's embedding be stored/retrieved before it has an owning
 * agent; `AiRagService` matches `agent_id = :agentId OR agent_id IS NULL`
 * scoped by `tenant_id`, so tenant isolation is unaffected.
 *
 * `IF EXISTS` — the sidecar table only exists when pgvector is enabled/available
 * (see AiPgVector1730000000000's own soft-skip).
 */
export class AiKnowledgeBaseAgentOptional1730056000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE IF EXISTS ai_kb_embeddings ALTER COLUMN agent_id DROP NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // Best-effort: fails if any row has a NULL agent_id, which is the whole
    // point of this migration — an intentionally lossy down.
    await q.query(
      `ALTER TABLE IF EXISTS ai_kb_embeddings ALTER COLUMN agent_id SET NOT NULL`,
    );
  }
}
