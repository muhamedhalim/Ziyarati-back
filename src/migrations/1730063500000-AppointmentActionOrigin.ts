import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T019/T020 (FR-C010, FR-R012).
 * Persists WHO initiated a cancellation/reschedule. `NOT NULL DEFAULT
 * 'STAFF'` on every existing row is the back-compat guarantee: every
 * historical action was, in fact, staff-initiated (patient self-service
 * did not exist before S1/S2), so this correctly labels history with no
 * backfill pass needed.
 *
 * Own migration — NOT folded into `1730063000000-PatientActionLinks` (a
 * different table's concern; see that migration's docblock for the same
 * reasoning applied to `1730065500000-ScheduledNotificationDeliveryChannel`).
 * Non-round timestamp follows the existing `1730057100000-AuthTokenIndexes`
 * precedent, and keeps this ordered after the links migration.
 */
export class AppointmentActionOrigin1730063500000 implements MigrationInterface {
  name = 'AppointmentActionOrigin1730063500000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "appointment_cancellations"
        ADD COLUMN IF NOT EXISTS "origin" varchar(16) NOT NULL DEFAULT 'STAFF'
    `);
    await q.query(`
      ALTER TABLE "appointment_reschedules"
        ADD COLUMN IF NOT EXISTS "origin" varchar(16) NOT NULL DEFAULT 'STAFF'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "appointment_reschedules" DROP COLUMN IF EXISTS "origin"`);
    await q.query(`ALTER TABLE "appointment_cancellations" DROP COLUMN IF EXISTS "origin"`);
  }
}
