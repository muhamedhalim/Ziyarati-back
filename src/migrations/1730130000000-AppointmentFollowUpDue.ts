import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The date a clinician says a patient should come back.
 *
 * The "medical follow-up when due" rule needs a date that a person decided; it is
 * never inferred from notes or diagnosis. It lives on the COMPLETED appointment
 * the follow-up is about.
 *
 *  - `follow_up_due_on`     a calendar DATE (no time, no zone): "around 3 June".
 *  - `follow_up_set_by_id`  the staff user who set it (SET NULL if they are removed).
 *  - `follow_up_set_at`     when it was last set.
 *
 * All three are NULL for every existing row (no follow-up requested). The partial
 * index serves the daily sweep, which only looks at rows that HAVE a date.
 * Additive, nullable, no data moved. Idempotent.
 */
export class AppointmentFollowUpDue1730130000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "appointments"
        ADD COLUMN IF NOT EXISTS "follow_up_due_on" date,
        ADD COLUMN IF NOT EXISTS "follow_up_set_by_id" uuid,
        ADD COLUMN IF NOT EXISTS "follow_up_set_at" TIMESTAMP WITH TIME ZONE
    `);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "appointments"
          ADD CONSTRAINT "FK_appointments_follow_up_set_by"
          FOREIGN KEY ("follow_up_set_by_id") REFERENCES "users"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_appointments_tenant_follow_up_due"
        ON "appointments" ("tenantId", "follow_up_due_on")
        WHERE "follow_up_due_on" IS NOT NULL AND "deleted_at" IS NULL
    `);
  }

  /** R-DB6: additive columns are never dropped on rollback; only the index goes. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_appointments_tenant_follow_up_due"`,
    );
  }
}
