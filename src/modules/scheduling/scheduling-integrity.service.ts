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
 * Why this exists: the constraint can go missing from a database that reports
 * itself fully migrated, and nothing else notices. Two distinct ways (P0.1,
 * both reproduced):
 *
 *  1. The database was BUILT by `TYPEORM_SYNCHRONIZE=true`, which skips the
 *     migration chain entirely (see `typeorm.config.ts`).
 *  2. The database was built correctly BY the migration chain, and a later
 *     `TYPEORM_SYNCHRONIZE=true` boot DESTROYED the constraint —
 *     `RdbmsSchemaBuilder.dropOldExclusions()` drops every EXCLUDE constraint
 *     absent from entity metadata. The `migrations` row survives, so
 *     `migration:run` reports nothing pending and cannot repair it.
 *
 * Both are now closed structurally: the `Appointment` entity DECLARES the
 * constraint via `@Exclusion`, so the synchronizer recognises it (never drops
 * it, and creates it on a synchronize-built database), and
 * `AppointmentNoOverlapRepair1730088000000` restores it on databases that
 * already lost it. This check remains as the last line of defence, because the
 * failure it detects is invisible from inside the app: the app-level
 * availability check still returns the right answer — it just loses the race.
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
        `and overlapping window can BOTH succeed, with every request returning HTTP 201. ` +
        `Do NOT trust the migrations table here: the constraint can be recorded as applied ` +
        `and still be absent, because a TYPEORM_SYNCHRONIZE=true boot drops EXCLUDE ` +
        `constraints it does not recognise. Fix: run "npm run migration:run" against this ` +
        `database — AppointmentNoOverlapRepair1730088000000 reinstalls it and is idempotent. ` +
        `If that migration ABORTS, the table already contains overlapping appointments; its ` +
        `error names how many and the query that lists them. Resolve those first — never ` +
        `delete booking rows to force the constraint through.`,
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
