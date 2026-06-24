import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Appointment integrity hardening:
 *  - `payment_status` (separate payment axis from scheduling `status`).
 *  - `version` (optimistic locking → no silent lost updates).
 *  - `booked_timezone` (snapshot for stable local-time history).
 *  - currency default → 'SAR' (KSA-first).
 *  - CHECK: end_at > start_at, total_amount >= 0 (DB-level invalid-state guards).
 *  - satellite FK indexes on appointment_id (Postgres does not auto-index FKs).
 *  - status-filtered calendar index (branch, status, start_at).
 * Idempotent.
 */
export class AppointmentIntegrityHardening1730001300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // payment_status
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointments_payment_status_enum') THEN
        CREATE TYPE "public"."appointments_payment_status_enum" AS ENUM
          ('UNPAID','DEPOSIT_PAID','PAID','REFUNDED','PARTIALLY_REFUNDED');
      END IF;
    END $$;`);
    await q.query(`ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "payment_status" "public"."appointments_payment_status_enum" NOT NULL DEFAULT 'UNPAID'`);

    // Snapshot + optimistic lock + KSA currency default.
    await q.query(`ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "booked_timezone" character varying(64)`);
    await q.query(`ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`);
    await q.query(`ALTER TABLE "appointments" ALTER COLUMN "currency" SET DEFAULT 'SAR'`);

    // Invalid-state guards.
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_end_after_start') THEN
        ALTER TABLE "appointments" ADD CONSTRAINT "appointments_end_after_start" CHECK ("end_at" > "start_at");
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_total_nonneg') THEN
        ALTER TABLE "appointments" ADD CONSTRAINT "appointments_total_nonneg" CHECK ("total_amount" IS NULL OR "total_amount" >= 0);
      END IF;
    END $$;`);

    // Calendar + FK indexes.
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_appointments_branch_status_start" ON "appointments" ("branchId", "status", "start_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_appt_services_appointment" ON "appointment_services" ("appointmentId")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_appt_status_logs_appointment" ON "appointment_status_logs" ("appointmentId")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_appt_cancellations_appointment" ON "appointment_cancellations" ("appointmentId")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_appt_reschedules_appointment" ON "appointment_reschedules" ("appointmentId")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IX_appt_reschedules_appointment"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_appt_cancellations_appointment"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_appt_status_logs_appointment"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_appt_services_appointment"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_appointments_branch_status_start"`);
    await q.query(`ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_total_nonneg"`);
    await q.query(`ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_end_after_start"`);
    await q.query(`ALTER TABLE "appointments" ALTER COLUMN "currency" SET DEFAULT 'USD'`);
    await q.query(`ALTER TABLE "appointments" DROP COLUMN IF EXISTS "version"`);
    await q.query(`ALTER TABLE "appointments" DROP COLUMN IF EXISTS "booked_timezone"`);
    await q.query(`ALTER TABLE "appointments" DROP COLUMN IF EXISTS "payment_status"`);
    await q.query(`DROP TYPE IF EXISTS "public"."appointments_payment_status_enum"`);
  }
}
