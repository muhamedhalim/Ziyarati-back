import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CORRECTIVE. Migration `1730008000000-IntegrationTwoWayLifecycle` created three
 * relation join columns under names TypeORM does not actually use:
 *
 *   integration_conflicts.resolved_byId    → resolvedById
 *   integration_import_jobs.requested_byId → requestedById
 *   integration_sync_jobs.triggered_byId   → triggeredById
 *
 * TypeORM derives a join column from the RELATION PROPERTY name via its naming
 * strategy, which camel-cases the whole thing (`resolved_by` + `Id` →
 * `resolvedById`). The hand-written DDL guessed `resolved_byId` instead.
 *
 * WHY THIS WAS NOT CAUGHT EARLIER. The development database is built with
 * `TYPEORM_SYNCHRONIZE=true`, which creates columns from entity metadata — so it
 * always had the CORRECT names and every query worked. Only a database built
 * from the migration chain (i.e. production, and the e2e database) has the wrong
 * names, and there every read or write touching these tables fails outright with
 * `column ... does not exist`. Conflicts, async import and sync would all be
 * broken on a fresh production deploy.
 *
 * The rename is conditional ON PURPOSE — and this is not the blanket
 * `IF NOT EXISTS` that hides drift. There are exactly two legitimate historical
 * states (built by migrations = wrong name; built by synchronize = right name),
 * and this reconciles them to one. Any THIRD state — neither column present — is
 * genuine drift and raises loudly in the post-condition below.
 *
 * ADDITIVE and data-preserving: `ALTER TABLE ... RENAME COLUMN` keeps every row
 * and every foreign key. Nothing is dropped.
 */
export class IntegrationFixJoinColumnDrift1730011000000 implements MigrationInterface {
  name = 'IntegrationFixJoinColumnDrift1730011000000';

  /** table → [wrong name created by DDL, correct name TypeORM uses]. */
  private static readonly RENAMES: Array<[string, string, string]> = [
    ['integration_conflicts', 'resolved_byId', 'resolvedById'],
    ['integration_import_jobs', 'requested_byId', 'requestedById'],
    ['integration_sync_jobs', 'triggered_byId', 'triggeredById'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const [table, wrong, right] of IntegrationFixJoinColumnDrift1730011000000.RENAMES) {
      await q.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = '${wrong}'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = '${right}'
          ) THEN
            ALTER TABLE "${table}" RENAME COLUMN "${wrong}" TO "${right}";
          END IF;
        END $$;
      `);
    }

    // Post-condition: the correct column must now exist on every table, and the
    // wrong one must be gone. A table with NEITHER is real drift — fail loudly.
    for (const [table, wrong, right] of IntegrationFixJoinColumnDrift1730011000000.RENAMES) {
      await q.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = '${right}'
          ) THEN
            RAISE EXCEPTION 'Migration post-condition failed: %.% is missing', '${table}', '${right}';
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = '${wrong}'
          ) THEN
            RAISE EXCEPTION 'Migration post-condition failed: %.% still exists alongside %', '${table}', '${wrong}', '${right}';
          END IF;
        END $$;
      `);
    }
  }

  /**
   * Renames the columns back to the (broken) names the original DDL produced.
   * NOT destructive — no data is lost — but it RE-BREAKS conflicts, async import
   * and sync against a migration-built database, so there is no reason to run it
   * other than replaying the chain on a throwaway database.
   */
  public async down(q: QueryRunner): Promise<void> {
    for (const [table, wrong, right] of IntegrationFixJoinColumnDrift1730011000000.RENAMES) {
      await q.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = '${right}'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = '${wrong}'
          ) THEN
            ALTER TABLE "${table}" RENAME COLUMN "${right}" TO "${wrong}";
          END IF;
        END $$;
      `);
    }
  }
}
