import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI-009 (FR-087, SD-1 point 6): records whether the output-side
 * system-prompt/tool-schema disclosure check redacted a turn's reply — so a
 * blocked turn is visible in the turn's own recorded outcome, never a
 * silent redaction. Additive, no backfill needed (every pre-existing row
 * genuinely had no block, since the check did not exist yet).
 */
export class AiExecutionMetricPromptDisclosureBlocked1730041400000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "prompt_disclosure_blocked" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_execution_metrics" DROP COLUMN IF EXISTS "prompt_disclosure_blocked"`,
    );
  }
}
