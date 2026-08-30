import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — FR-C017, FR-R015, FR-M002. Gives
 * clinics the switches for patient self-service cancellation/reschedule (S1,
 * S2) and appointment reminders (S3). Fail-closed defaults (`false` / empty
 * array) — matches `public_booking_enabled`'s precedent: no clinic starts
 * messaging patients or accepting self-service without an explicit opt-in.
 */
export class TenantSettingSelfServiceAndReminders1730064000000
  implements MigrationInterface
{
  name = 'TenantSettingSelfServiceAndReminders1730064000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "tenant_settings"
        ADD COLUMN IF NOT EXISTS "self_cancellation_enabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "self_reschedule_enabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "reminders_enabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "reminder_lead_minutes" integer[] NOT NULL DEFAULT '{}'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "tenant_settings"
        DROP COLUMN IF EXISTS "reminder_lead_minutes",
        DROP COLUMN IF EXISTS "reminders_enabled",
        DROP COLUMN IF EXISTS "self_reschedule_enabled",
        DROP COLUMN IF EXISTS "self_cancellation_enabled"
    `);
  }
}
