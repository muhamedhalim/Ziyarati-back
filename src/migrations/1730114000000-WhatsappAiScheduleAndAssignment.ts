import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp AI controls, phase 2 — two clinic-level modes on `tenant_settings`:
 *
 *  - `ai_schedule_mode`    ALWAYS | WORKING_HOURS | OUTSIDE_WORKING_HOURS
 *      when, relative to the clinic's working hours, the AI may answer
 *  - `ai_assignment_mode`  ALL | ASSIGNED_ONLY
 *      whether the AI answers every conversation, or only those staff have
 *      explicitly assigned to it (`conversations.ai_mode = 'ENABLED'`, which
 *      already exists — it needs no new column)
 *
 * Defaults (ALWAYS / ALL) reproduce today's behaviour exactly: no clinic's AI
 * changes until someone picks another mode.
 *
 * Safe on a live table: constant defaults are applied as catalog metadata
 * without a rewrite; the CHECKs are declared in the same statement so they are
 * validated against the default only. Idempotent (`IF NOT EXISTS`). No data is
 * read, moved or deleted.
 */
export class WhatsappAiScheduleAndAssignment1730114000000 implements MigrationInterface {
  name = 'WhatsappAiScheduleAndAssignment1730114000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "tenant_settings"
        ADD COLUMN IF NOT EXISTS "ai_schedule_mode" varchar(24) NOT NULL DEFAULT 'ALWAYS'
          CONSTRAINT "CHK_tenant_settings_ai_schedule_mode"
          CHECK ("ai_schedule_mode" IN ('ALWAYS','WORKING_HOURS','OUTSIDE_WORKING_HOURS')),
        ADD COLUMN IF NOT EXISTS "ai_assignment_mode" varchar(16) NOT NULL DEFAULT 'ALL'
          CONSTRAINT "CHK_tenant_settings_ai_assignment_mode"
          CHECK ("ai_assignment_mode" IN ('ALL','ASSIGNED_ONLY'))
    `);
  }

  /** R-DB6: additive columns are never dropped on rollback. */
  public async down(): Promise<void> {
    // Deliberately does not drop the columns.
  }
}
