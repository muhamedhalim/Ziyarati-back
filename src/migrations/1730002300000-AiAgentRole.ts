import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-agent routing (Feature 7): a specialized `role` on `ai_agents`. Nullable
 * + additive — existing single-agent tenants keep null and remain the default
 * agent, so behaviour is unchanged until roles are assigned.
 */
export class AiAgentRole1730002300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "role" character varying(32)`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_ai_agents_role" ON "ai_agents" ("role")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_ai_agents_role"`);
    await q.query(`ALTER TABLE "ai_agents" DROP COLUMN IF EXISTS "role"`);
  }
}
