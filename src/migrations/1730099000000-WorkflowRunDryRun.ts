import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marks a `workflow_runs` row as a dry run — the manual "Test Run" button's
 * runs never call a real WhatsApp/Email provider (see
 * `WorkflowActionExecutor`'s `dryRun` param), but still exercise the real
 * engine end to end. Additive, IF NOT EXISTS, idempotent alongside dev
 * `synchronize`.
 */
export class WorkflowRunDryRun1730099000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "workflow_runs"
      ADD COLUMN IF NOT EXISTS "dry_run" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workflow_runs" DROP COLUMN IF EXISTS "dry_run"`);
  }
}
