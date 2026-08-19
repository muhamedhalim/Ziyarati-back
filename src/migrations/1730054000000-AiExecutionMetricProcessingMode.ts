import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records HOW an AI turn was processed — execution mode (Standard/Batch) and
 * whether it required regional processing (Data Residency) — on the per-turn
 * metric row.
 *
 * `ai_cost_entries` has carried `execution_mode` and `region` since the batch
 * migration, but nothing on the CHAT path ever populated them and
 * `ai_execution_metrics` had no equivalent at all. A turn served through an
 * enforced regional deployment was therefore indistinguishable, after the fact,
 * from one served globally — which makes a residency claim unauditable.
 *
 * `processing_mode` is the composed label (`STANDARD`, `BATCH`,
 * `STANDARD+RESIDENCY`, `BATCH+RESIDENCY`) so one column answers "how was this
 * processed" without a join; the two dimensions stay separately queryable
 * alongside it.
 *
 * Additive and nullable with NO backfill: pre-existing rows genuinely predate
 * the signal, and stamping them 'STANDARD' would assert something this
 * migration cannot verify. New rows always carry a value.
 */
export class AiExecutionMetricProcessingMode1730054000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "processing_mode" varchar(40)`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "data_residency_required" boolean`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "data_residency_region" varchar(40)`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "data_residency_reason" varchar(200)`,
    );
    // Mirrors the entity's @Index() — the operator question this table exists to
    // answer ("show me spend/latency by processing mode") scans on this column.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_execution_metrics_processing_mode"
         ON "ai_execution_metrics" ("processing_mode")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_ai_execution_metrics_processing_mode"`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "data_residency_reason"`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "data_residency_region"`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "data_residency_required"`,
    );
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "processing_mode"`,
    );
  }
}
