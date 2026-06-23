import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Race-proof double-booking guard.
 *
 * A SELECT-then-INSERT availability check can never be race-safe under READ
 * COMMITTED (no gap locks), so the guarantee is moved into PostgreSQL itself: an
 * EXCLUSION CONSTRAINT physically forbids two ACTIVE appointments for the SAME
 * staff whose [start_at, end_at) ranges overlap. Two concurrent transactions
 * that both pass the app-level check will collide at COMMIT — exactly one wins,
 * the other gets `23P01` (mapped to a 409 CONFLICT).
 *
 *  - `WITH =` on staffId, `WITH &&` on the tstzrange (half-open `[)`, so abutting
 *    appointments 10:00–10:30 / 10:30–11:00 do NOT conflict).
 *  - Partial `WHERE` excludes CANCELLED/NO_SHOW and soft-deleted rows, so freeing
 *    a slot (cancel) immediately makes it bookable again.
 *
 * NOTE: if legacy overlapping rows exist, `ADD CONSTRAINT` will fail — clean them
 * first (diagnostic query in the comment below). Exclusion constraints have no
 * NOT VALID form, so the table must be conflict-free at creation time.
 */
export class AppointmentNoOverlap1730001100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    // Diagnostic (run manually if the ALTER fails): find existing overlaps —
    //   SELECT a.id, b.id FROM appointments a JOIN appointments b
    //     ON a."staffId" = b."staffId" AND a.id < b.id
    //    AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.deleted_at IS NULL
    //    AND b.status NOT IN ('CANCELLED','NO_SHOW') AND b.deleted_at IS NULL
    //    AND tstzrange(a.start_at,a.end_at,'[)') && tstzrange(b.start_at,b.end_at,'[)');

    await q.query(`
      ALTER TABLE "appointments"
      ADD CONSTRAINT "appointments_no_overlap"
      EXCLUDE USING gist (
        "staffId" WITH =,
        tstzrange("start_at", "end_at", '[)') WITH &&
      )
      WHERE (status NOT IN ('CANCELLED','NO_SHOW') AND deleted_at IS NULL)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_no_overlap"`);
    // btree_gist left installed (other constraints/indexes may rely on it).
  }
}
