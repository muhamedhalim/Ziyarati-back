import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P0.1 — RESTORES the `appointments_no_overlap` exclusion constraint on
 * databases that lost it, and makes its absence impossible to miss.
 *
 * WHY A SECOND MIGRATION EXISTS FOR A CONSTRAINT THAT `AppointmentNoOverlap
 * 1730001100000` ALREADY CREATES CORRECTLY:
 *
 * That migration is not defective — a fresh database migrated from empty gets
 * the constraint exactly as intended (verified). The constraint was destroyed
 * AFTERWARDS, out of band, by the application itself:
 *
 *   `typeorm.config.ts` enables TypeORM's schema synchronizer whenever
 *   `TYPEORM_SYNCHRONIZE=true` (dev/test only — production refuses to boot
 *   with it). On every such boot `RdbmsSchemaBuilder.dropOldExclusions()`
 *   drops every EXCLUDE constraint present in the database but absent from
 *   entity metadata. Captured verbatim from a boot log:
 *
 *       query: ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_overlap"
 *
 * Because `runMigrationsWithAdvisoryLock` is SKIPPED under the same flag, the
 * migration never re-runs, its `migrations` row survives, and TypeORM reports
 * the schema as fully migrated while the guarantee is gone. `migration:run`
 * cannot repair that: the original migration is already recorded as applied.
 * Hence a NEW migration — the only mechanism that runs against an existing,
 * already-migrated database.
 *
 * The recurrence is closed separately and structurally by the `@Exclusion`
 * declaration on the `Appointment` entity: the synchronizer matches exclusion
 * constraints BY NAME, so a declared one is no longer "old", is never dropped,
 * and is created on synchronize-built databases that never ran migrations.
 * This migration repairs existing databases; the decorator prevents the next
 * boot from undoing the repair. Neither alone is sufficient.
 *
 * SAFETY PROPERTIES (all required by the P0.1 brief):
 *  - Idempotent — a database that still has the constraint is left untouched.
 *  - Never deletes or edits appointment data. If overlapping rows already
 *    exist the migration ABORTS with the counts and a diagnostic query;
 *    a human decides what to do with real bookings, not a migration.
 *  - Post-condition asserted, so a silent no-op cannot be mistaken for success.
 *
 * OPERATIONAL NOTE FOR PRODUCTION: `ADD CONSTRAINT ... EXCLUDE` takes an
 * ACCESS EXCLUSIVE lock and builds a GiST index over every live row —
 * PostgreSQL has no CONCURRENTLY or NOT VALID form for exclusion constraints,
 * so this cannot be made online. Bookings block for the duration. Measured on
 * a 900,000-row `appointments` table: see P0.1_APPOINTMENT_INTEGRITY_REPORT.md
 * §"Production execution cost". Run it in a maintenance window, and consider
 * `SET lock_timeout` so it fails fast rather than queueing behind a long read.
 */
export class AppointmentNoOverlapRepair1730088000000
  implements MigrationInterface
{
  name = 'AppointmentNoOverlapRepair1730088000000';

  public async up(q: QueryRunner): Promise<void> {
    // Required by the GiST operator class for the `=` on a uuid column.
    // Already present wherever 1730001100000 ran; IF NOT EXISTS covers the
    // case where THIS migration is the first to install the guard.
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    await q.query(`
      DO $$
      DECLARE
        pair_count   bigint;
        appt_count   bigint;
        staff_count  bigint;
        tenant_count bigint;
        branch_count bigint;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
           WHERE c.conname = 'appointments_no_overlap'
             AND c.contype = 'x'
             AND t.relname = 'appointments'
        ) THEN
          RAISE NOTICE 'appointments_no_overlap already present — nothing to repair.';
          RETURN;
        END IF;

        -- Exactly the predicate the constraint will enforce, so the check can
        -- never disagree with the ALTER that follows it.
        WITH pairs AS (
          SELECT a.id AS a_id, b.id AS b_id
            FROM appointments a
            JOIN appointments b
              ON a."staffId" = b."staffId"
             AND a.id < b.id
             AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.deleted_at IS NULL
             AND b.status NOT IN ('CANCELLED','NO_SHOW') AND b.deleted_at IS NULL
             AND tstzrange(a.start_at, a.end_at, '[)')
              && tstzrange(b.start_at, b.end_at, '[)')
        ),
        involved AS (
          SELECT a_id AS id FROM pairs
          UNION
          SELECT b_id AS id FROM pairs
        )
        SELECT
          (SELECT count(*) FROM pairs),
          (SELECT count(*) FROM involved),
          (SELECT count(DISTINCT ap."staffId")  FROM appointments ap JOIN involved i ON i.id = ap.id),
          (SELECT count(DISTINCT ap."tenantId") FROM appointments ap JOIN involved i ON i.id = ap.id),
          (SELECT count(DISTINCT ap."branchId") FROM appointments ap JOIN involved i ON i.id = ap.id)
        INTO pair_count, appt_count, staff_count, tenant_count, branch_count;

        -- Every count goes in the MESSAGE, not in DETAIL: node-postgres
        -- surfaces only error.message through TypeORM's QueryFailedError, so
        -- anything put in DETAIL is invisible to "npm run migration:run" and
        -- reaches only an operator running this by hand in psql. Verified by
        -- running this exact abort through the migration CLI.
        IF pair_count > 0 THEN
          RAISE EXCEPTION
            'Cannot install "appointments_no_overlap": % overlapping appointment pair(s) already exist '
            '(appointments involved=%, staff=%, tenants=%, branches=%). No rows were changed — '
            'resolve the conflicts, then re-run this migration.',
            pair_count, appt_count, staff_count, tenant_count, branch_count
          USING
            HINT =
              'These are real double-bookings that predate the guard. Resolve them first '
              || '(cancel or reschedule one side of each pair), then re-run this migration. '
              || 'List them with: SELECT a.id, b.id, a."staffId", a.start_at, a.end_at '
              || 'FROM appointments a JOIN appointments b ON a."staffId" = b."staffId" AND a.id < b.id '
              || 'AND a.status NOT IN (''CANCELLED'',''NO_SHOW'') AND a.deleted_at IS NULL '
              || 'AND b.status NOT IN (''CANCELLED'',''NO_SHOW'') AND b.deleted_at IS NULL '
              || 'AND tstzrange(a.start_at,a.end_at,''[)'') && tstzrange(b.start_at,b.end_at,''[)'');';
        END IF;

        ALTER TABLE "appointments"
          ADD CONSTRAINT "appointments_no_overlap"
          EXCLUDE USING gist (
            "staffId" WITH =,
            tstzrange("start_at", "end_at", '[)') WITH &&
          )
          WHERE (status NOT IN ('CANCELLED','NO_SHOW') AND deleted_at IS NULL);

        RAISE NOTICE 'appointments_no_overlap installed (% appointment(s) scanned).',
          (SELECT count(*) FROM appointments);
      END $$;
    `);

    // Post-condition — a repair migration that quietly did nothing is the
    // exact failure this whole phase exists to eliminate.
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
           WHERE c.conname = 'appointments_no_overlap'
             AND c.contype = 'x'
             AND t.relname = 'appointments'
        ) THEN
          RAISE EXCEPTION
            'post-condition failed: appointments_no_overlap is still not installed on "appointments"';
        END IF;
      END $$;
    `);
  }

  /**
   * Deliberately a NO-OP.
   *
   * `down()` exists to reverse a migration's intent. This migration's intent is
   * "the double-booking guard must be present"; reversing that would re-open
   * the exact hole P0.1 was raised to close, on an operator's machine, silently.
   * The constraint remains owned by `AppointmentNoOverlap1730001100000` — revert
   * THAT if the guard genuinely has to come off.
   */
  public async down(): Promise<void> {
    // intentionally empty — see the docstring above.
  }
}
