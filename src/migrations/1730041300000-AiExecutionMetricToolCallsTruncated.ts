import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI-023 (FR-048, FR-049, FR-087, R7): records how many tool calls in a
 * turn were refused by the per-round-trip fan-out cap
 * (`AiExecutionService.capToolCalls`, `AI_MAX_TOOL_CALLS_PER_ITERATION`) —
 * so a capped turn is visible in the turn's own recorded outcome, never a
 * silent truncation. Additive, nullable-equivalent default of 0 (no
 * backfill needed — every pre-existing row genuinely had zero calls
 * truncated, since the cap did not exist yet).
 */
export class AiExecutionMetricToolCallsTruncated1730041300000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "tool_calls_truncated" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "tool_calls_truncated"`,
    );
  }
}
