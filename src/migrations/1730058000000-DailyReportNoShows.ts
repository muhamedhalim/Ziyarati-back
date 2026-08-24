import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `no_show_appointments` to `daily_reports`. `AppointmentStatus.NO_SHOW`
 * has always existed, but the daily aggregation only ever broke out
 * COMPLETED/CANCELLED — no-shows were silently folded into the branch's
 * `total_appointments` with no way to see them separately. Backfilled to 0 on
 * existing rows (matching the column default); a subsequent report
 * regeneration recomputes the real figure from source.
 */
export class DailyReportNoShows1730058000000 implements MigrationInterface {
  name = 'DailyReportNoShows1730058000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "daily_reports" ADD COLUMN IF NOT EXISTS "no_show_appointments" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "daily_reports" DROP COLUMN IF EXISTS "no_show_appointments"`,
    );
  }
}
