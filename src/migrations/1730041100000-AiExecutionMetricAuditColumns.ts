import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M2 (`AI-016`, `AI-017`) — two nullable, additive columns on
 * `ai_execution_metrics`, mirroring M1's ledger columns of the same name so
 * one turn's `ai_tool_calls` rows and its `ai_execution_metrics` row carry
 * the SAME `correlation_id` (FR-030) and the same acting principal
 * (FR-033), directly queryable with no join.
 *
 * Naming asymmetry (data-model.md §Entity 2, deliberately preserved, not
 * "fixed" here): this table's tenant column is TypeORM's default camelCase
 * `"tenantId"` (from `@ManyToOne(() => Tenant) tenant`), unlike
 * `ai_tool_calls`'s raw-table snake_case `tenant_id` — the exact mismatch
 * class behind `AI-002`/`AI-005`. Any raw SQL against either table must use
 * the right form; this migration only adds two new columns, it does not
 * touch `"tenantId"`.
 */
export class AiExecutionMetricAuditColumns1730041100000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "correlation_id" character varying`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "actor_user_id" uuid`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_aiexec_correlation" ON "ai_execution_metrics" ("correlation_id") WHERE "correlation_id" IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_aiexec_correlation"`);
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "actor_user_id"`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "correlation_id"`,
    );
  }
}
