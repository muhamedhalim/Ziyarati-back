import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P0.7 — validates the 10 `NOT VALID` foreign keys
 * `1730089000000-TenantIsolationForeignKeys` added, turning "accepted on
 * future writes" into "verified against every existing row".
 *
 * WHY A SEPARATE MIGRATION. `VALIDATE CONSTRAINT` scans the whole table —
 * unlike the `ADD ... NOT VALID` in the prior migration, it is not free.
 * Splitting it out means: (1) the prior migration's fast, non-blocking
 * schema change and this one's scan are two independently observable deploy
 * steps, not one migration that is sometimes-fast-sometimes-not depending on
 * what the target database happens to contain; (2) if any table has an
 * orphan this repository has not seen (dev and e2e both showed zero — see
 * `P0.7_TENANT_ISOLATION_MATRIX.md` — but production was not scanned by this
 * migration's author), THIS migration fails, cleanly, by itself — the
 * constraint stays `NOT VALID` (still rejecting bad NEW writes; not yet
 * proven clean against OLD ones), nothing is torn down, and the fix is a
 * data decision followed by re-running `migration:run`, not a rollback.
 *
 * LOCK: `VALIDATE CONSTRAINT` takes `SHARE UPDATE EXCLUSIVE` — it does not
 * block reads or writes, only another DDL change on the same table
 * concurrently. All ten tables measured well under 1,000 rows and under
 * 256 kB on both `ziyarati` and `ziyarati_e2e` (P0.7 §5); this is expected
 * to be near-instant wherever it runs, but the split exists on principle,
 * not because these specific tables are large today.
 *
 * If this migration throws, the error names which constraint and which
 * table — `ALTER TABLE ... VALIDATE CONSTRAINT` surfaces Postgres's own
 * "is violated by some row" error, which does not include a row id (by
 * Postgres's own design, not this migration's choice); finding the actual
 * offending row(s) is a `SELECT ... WHERE tenant_id NOT IN (SELECT id FROM
 * tenants)`-shaped query against the named table, run by a human, same
 * discipline as every other conflict this campaign has surfaced (RULE 9:
 * report, never auto-resolve).
 */
export class TenantIsolationValidateForeignKeys1730090000000 implements MigrationInterface {
  name = 'TenantIsolationValidateForeignKeys1730090000000';

  public async up(q: QueryRunner): Promise<void> {
    const constraints: Array<[string, string]> = [
      ['admin_notifications', 'FK_3c0f90545fccf48cdc9af769900'],
      ['ai_execution_metrics', 'FK_b36838c9d4e9f6661b8dbdbc381'],
      ['ai_kb_embeddings', 'FK_d8615fbaf07b49c97e568d1244b'],
      ['ai_memories', 'FK_9d5a5a6e12bfbd4d0f2574be137'],
      ['ai_tool_calls', 'FK_3b51d63b4efb853544af8f3728b'],
      ['email_logs', 'FK_71c1fbaf7386c15669cdc86dbdb'],
      ['free_access_overrides', 'FK_fe98256a5df434c39572775c2ca'],
      ['settlement_adjustments', 'FK_d7109aa26f841e470dc16dafad0'],
      ['workflows', 'FK_50b693c75be8214931a320c9231'],
      ['workflow_runs', 'FK_345785d9f346ec88001942297d6'],
    ];

    for (const [table, constraintName] of constraints) {
      // Idempotent — `convalidated` is true once VALIDATE has succeeded, so
      // a re-run (or a database where the constraint arrived already valid,
      // e.g. created fresh rather than via the NOT VALID migration) skips
      // cleanly instead of re-scanning or erroring on "already validated".
      await q.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
             WHERE c.conname = '${constraintName}' AND t.relname = '${table}'
               AND c.convalidated
          ) THEN
            RAISE NOTICE '${constraintName} on "${table}" already validated — nothing to do.';
            RETURN;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
             WHERE c.conname = '${constraintName}' AND t.relname = '${table}'
          ) THEN
            RAISE EXCEPTION
              '${constraintName} does not exist on "${table}" — run 1730089000000-TenantIsolationForeignKeys first.';
          END IF;
        END $$;
      `);
      await q.query(
        `ALTER TABLE "${table}" VALIDATE CONSTRAINT "${constraintName}"`,
      );
    }
  }

  /**
   * Deliberately a NO-OP — reverting "this row set has been proven clean"
   * is not a schema change to undo, and a validated constraint stays exactly
   * as safe as an unvalidated one going forward (VALIDATE only affects
   * whether EXISTING rows were checked, not future ones — a `NOT VALID`
   * constraint already rejects any new violating write). Revert
   * `1730089000000` if the foreign key itself must come off.
   */
  public async down(): Promise<void> {
    // intentionally empty — see the docstring above.
  }
}
