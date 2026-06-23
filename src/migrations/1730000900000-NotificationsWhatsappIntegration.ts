import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications ↔ WhatsApp integration:
 *  - scheduled_notifications: `send_attempted` (at-most-once guard) + `variables`.
 *  - notification_templates: `provider_template_id` (approved WhatsApp template)
 *    + `variables` (defaults).
 *  - notification_logs: `(tenantId, created_at, status)` index for stats +
 *    `(created_at)` index for the retention purge.
 * Idempotent; down() reverses.
 */
export class NotificationsWhatsappIntegration1730000900000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "send_attempted" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "variables" jsonb`);

    await q.query(`ALTER TABLE "notification_templates" ADD COLUMN IF NOT EXISTS "provider_template_id" uuid`);
    await q.query(`ALTER TABLE "notification_templates" ADD COLUMN IF NOT EXISTS "variables" jsonb`);

    await q.query(`CREATE INDEX IF NOT EXISTS "IX_notification_logs_tenant_created_status" ON "notification_logs" ("tenantId", "created_at", "status")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_notification_logs_created" ON "notification_logs" ("created_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IX_notification_logs_created"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_notification_logs_tenant_created_status"`);
    await q.query(`ALTER TABLE "notification_templates" DROP COLUMN IF EXISTS "variables"`);
    await q.query(`ALTER TABLE "notification_templates" DROP COLUMN IF EXISTS "provider_template_id"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "variables"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "send_attempted"`);
  }
}
