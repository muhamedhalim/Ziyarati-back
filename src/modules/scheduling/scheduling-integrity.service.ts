import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The `EXCLUDE USING gist` constraint created by the `AppointmentNoOverlap`
 * migration. It is the ONLY thing that makes concurrent booking safe: an
 * availability check followed by an INSERT cannot be race-safe under READ
 * COMMITTED (there are no gap locks), so two simultaneous requests for the same
 * staff member and window both pass validation and both attempt to insert —
 * and only this constraint stops the second one.
 */
const OVERLAP_CONSTRAINT = 'appointments_no_overlap';

/**
 * Fails loudly at boot when the double-booking guarantee is not actually
 * installed.
 *
 * Why this exists: TypeORM cannot express an EXCLUSION constraint in entity
 * metadata, so `appointments_no_overlap` lives only in migration SQL. A
 * database built with `TYPEORM_SYNCHRONIZE=true` skips the migration chain
 * entirely (see `typeorm.config.ts`), which produces a schema that looks
 * complete, passes every unit test, and silently permits double-booking under
 * concurrency. That is a failure mode no test inside the app can catch, because
 * the app-level check still returns the right answer — it just loses the race.
 *
 * Deliberately LOG-ONLY, never fatal. A missing constraint degrades a safety
 * property; refusing to boot over it would turn a degraded API into a dead one,
 * which is strictly worse for a clinic mid-day. Operators get an unmissable
 * error line with the actual cause and the fix.
 */
@Injectable()
export class SchedulingIntegrityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulingIntegrityService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    const present = await this.overlapConstraintExists();
    if (present === null) {
      // Could not ask the database — never let a diagnostic take down boot.
      return;
    }
    if (present) {
      this.logger.log(
        `Double-booking guard verified: EXCLUSION constraint "${OVERLAP_CONSTRAINT}" is installed.`,
      );
      return;
    }

    this.logger.error(
      `⚠️ MISSING DOUBLE-BOOKING GUARD — the EXCLUSION constraint "${OVERLAP_CONSTRAINT}" ` +
        `is not installed on "appointments". Concurrent bookings for the same staff member ` +
        `and overlapping window can BOTH succeed. Most likely cause: this database was built ` +
        `with TYPEORM_SYNCHRONIZE=true, which skips the migration chain — and the constraint ` +
        `exists only in migration SQL (TypeORM cannot express EXCLUDE in entity metadata). ` +
        `Fix: run the migrations against this database (set TYPEORM_SYNCHRONIZE=false, or use ` +
        `test/setup-e2e-db.js for tests). If the ALTER fails, the table already contains ` +
        `overlapping rows — the diagnostic query is in the AppointmentNoOverlap migration.`,
    );
  }

  /** `true` / `false`, or `null` when the check itself could not run. */
  private async overlapConstraintExists(): Promise<boolean | null> {
    try {
      const rows: unknown[] = await this.dataSource.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 LIMIT 1`,
        [OVERLAP_CONSTRAINT],
      );
      return rows.length > 0;
    } catch (err) {
      this.logger.warn(
        `Could not verify the "${OVERLAP_CONSTRAINT}" constraint: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}
