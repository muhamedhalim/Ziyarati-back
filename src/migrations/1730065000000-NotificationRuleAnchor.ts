import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — S3. Enables scheduling relative to
 * a FUTURE appointment (`BEFORE_APPOINTMENT_START`) — the single defect that
 * blocked appointment reminders: every rule could previously only anchor to
 * a past trigger event (`AFTER_EVENT`).
 *
 * `NOT NULL DEFAULT 'AFTER_EVENT'` on every existing row is the back-compat
 * guarantee: an existing rule's scheduling behaviour is byte-identical after
 * this migration, since `AFTER_EVENT` is the pre-existing (only) behaviour.
 */
export class NotificationRuleAnchor1730065000000 implements MigrationInterface {
  name = 'NotificationRuleAnchor1730065000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "notification_rules"
        ADD COLUMN IF NOT EXISTS "anchor" varchar(24) NOT NULL DEFAULT 'AFTER_EVENT'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "notification_rules" DROP COLUMN IF EXISTS "anchor"
    `);
  }
}
