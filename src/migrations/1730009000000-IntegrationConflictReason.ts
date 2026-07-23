import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 (staff) — adds a safe, machine-readable `reason` to persisted
 * conflicts so the review UI can explain WHY a record could not be applied
 * (`field_divergence`, `staff_requires_account`, `missing_dependency`,
 * `ambiguous_match`, `stale_update`, `lifecycle_not_allowed`) without ever
 * exposing external values.
 *
 * Deliberately NOT written with a blanket `IF NOT EXISTS`: the column either
 * does not exist (fresh apply) or the migration has already run and is recorded
 * in the `migrations` table. Using an unconditional ADD COLUMN makes genuine
 * schema drift fail loudly instead of being silently masked. `up` ends with an
 * explicit verification query that raises if the column is missing or nullable.
 *
 * ADDITIVE and backfill-safe: existing rows adopt the DEFAULT, so this is safe
 * to run against production data. `down` drops only the column this migration
 * added (destructive only to that column's data — see the note in `down`).
 */
export class IntegrationConflictReason1730009000000 implements MigrationInterface {
  name = 'IntegrationConflictReason1730009000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "integration_conflicts"
        ADD COLUMN "reason" character varying(48) NOT NULL DEFAULT 'field_divergence'
    `);

    // Reviewing by reason is a first-class filter in the conflict queue.
    await q.query(`
      CREATE INDEX "IX_integration_conflicts_reason"
        ON "integration_conflicts" ("tenantId", "reason", "status")
    `);

    // ── Explicit post-conditions (fail loudly rather than silently drift) ──
    await q.query(`
      DO $$
      DECLARE col_nullable text;
      BEGIN
        SELECT is_nullable INTO col_nullable
          FROM information_schema.columns
         WHERE table_name = 'integration_conflicts' AND column_name = 'reason';

        IF col_nullable IS NULL THEN
          RAISE EXCEPTION 'post-condition failed: integration_conflicts.reason was not created';
        END IF;
        IF col_nullable <> 'NO' THEN
          RAISE EXCEPTION 'post-condition failed: integration_conflicts.reason must be NOT NULL';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'IX_integration_conflicts_reason'
        ) THEN
          RAISE EXCEPTION 'post-condition failed: IX_integration_conflicts_reason missing';
        END IF;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // DESTRUCTIVE for this column only: the recorded reason codes are lost.
    // Conflict rows, their ids, field names and hashes all survive, so rolling
    // back degrades review context but never destroys conflict history.
    await q.query(`DROP INDEX IF EXISTS "IX_integration_conflicts_reason"`);
    await q.query(`ALTER TABLE "integration_conflicts" DROP COLUMN "reason"`);
  }
}
