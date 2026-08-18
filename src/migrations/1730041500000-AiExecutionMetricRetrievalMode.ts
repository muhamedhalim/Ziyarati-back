import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI-013 (FR-065-FR-067, R9): records which retrieval path (vector vs.
 * keyword fallback) produced a turn's RAG context, so an operator can tell a
 * degraded keyword-fallback answer from a semantically grounded one without
 * reading application logs. Additive, nullable, no backfill needed (every
 * pre-existing row genuinely predates this signal).
 */
export class AiExecutionMetricRetrievalMode1730041500000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "retrieval_mode" varchar(20)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "retrieval_mode"`,
    );
  }
}
