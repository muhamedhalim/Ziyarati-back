import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications hardening:
 *  - scheduled_notifications: delivery_status axis, provider_ref (UNIQUE),
 *    attempts, failure_reason, processing_at, sent_at, delivered_at.
 *  - notification_logs: provider_ref (webhook correlation).
 * Idempotent (IF NOT EXISTS); down() drops what it added.
 */
export class NotificationsHardening1730000800000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "delivery_status" character varying(20) NOT NULL DEFAULT 'NONE'`);
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "provider_ref" character varying(255)`);
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "failure_reason" text`);
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "processing_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "scheduled_notifications" ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_scheduled_notifications_provider_ref" ON "scheduled_notifications" ("provider_ref") WHERE "provider_ref" IS NOT NULL`);
    // Sweep index: due SCHEDULED rows + stale PROCESSING reclaim.
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_scheduled_notifications_status_scheduled" ON "scheduled_notifications" ("status", "scheduled_at")`);

    await q.query(`ALTER TABLE "notification_logs" ADD COLUMN IF NOT EXISTS "provider_ref" character varying(255)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "provider_ref"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_scheduled_notifications_status_scheduled"`);
    await q.query(`DROP INDEX IF EXISTS "public"."UQ_scheduled_notifications_provider_ref"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "delivered_at"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "sent_at"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "processing_at"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "failure_reason"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "attempts"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "provider_ref"`);
    await q.query(`ALTER TABLE "scheduled_notifications" DROP COLUMN IF EXISTS "delivery_status"`);
  }
}
