import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The INTERNAL notification substrate — `in_app_notifications` +
 * `notification_preferences`.
 *
 * WHY A NEW TABLE RATHER THAN REUSING WHAT EXISTS. Neither candidate works:
 *
 *   - `scheduled_notifications` is an outbound SEND QUEUE keyed to a
 *     `Customer` recipient over WhatsApp. `NotificationDispatchService`
 *     permanently fails any row that is not `channel = WHATSAPP` AND
 *     `recipient_type = CUSTOMER`, so a staff-addressed row there is, today,
 *     guaranteed dead on arrival. It also has no read state, because a patient
 *     never reads a row in our database.
 *   - `admin_notifications` has a single GLOBAL `is_read` flag, so one admin
 *     marking a notification read clears the badge for every other admin. It
 *     also has no recipient column at all and no foreign key on `tenant_id`.
 *
 * Both tables and every existing route are left completely untouched by this
 * migration. Nothing is dropped, renamed or backfilled.
 *
 * ONE ROW PER RECIPIENT (fan-out at write time). That is what makes `read_at`
 * per-user and the unread badge an index-only count instead of a join.
 *
 * TITLE/BODY ARE NOT STORED — only `key` + `variables`. The text is rendered
 * at read time from the code catalog in the reader's own locale, so one row
 * serves an Arabic and an English reader and a copy fix needs no data
 * migration.
 *
 * DEDUPE UNIQUENESS IS PER-RECIPIENT, NOT GLOBAL. This deliberately diverges
 * from `UQ_scheduled_notifications_source_ref`, which is global and safe only
 * because every key it holds is UUID-derived. Catalog dedupe keys are
 * human-readable (`ticket:{id}:reply:{eventId}`), so a global index would let
 * two clinics collide and silently suppress one clinic's notification.
 * Scoping uniqueness to the recipient removes that class of bug, and doubles
 * as the cooldown mechanism when a key embeds a time bucket.
 *
 * Fully reversible: `down()` removes only the two tables this migration
 * created, so it cannot destroy anything that predates it.
 */
export class InAppNotifications1730070000000 implements MigrationInterface {
  name = 'InAppNotifications1730070000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "in_app_notifications" (
        "id"                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId"          uuid NULL,
        "recipient_user_id" uuid NOT NULL,
        "key"               character varying(64)  NOT NULL,
        "category"          character varying(32)  NOT NULL,
        "priority"          character varying(16)  NOT NULL DEFAULT 'NORMAL',
        "variables"         jsonb NULL,
        "link_url"          character varying(512) NULL,
        "entity_type"       character varying(64)  NULL,
        "entity_id"         uuid NULL,
        "dedupe_key"        character varying(255) NULL,
        "read_at"           TIMESTAMP WITH TIME ZONE NULL,
        "created_at"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "FK_in_app_notifications_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_in_app_notifications_recipient"
          FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // Idempotency + cooldown. Partial, so the many rows carrying no business
    // key never collide with one another. Scoped to the recipient — see the
    // class docstring for why global uniqueness would be a bug here.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_in_app_notifications_recipient_dedupe"
        ON "in_app_notifications" ("recipient_user_id", "dedupe_key")
        WHERE "dedupe_key" IS NOT NULL
    `);

    // Inbox list — newest first, for one recipient.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_in_app_notifications_recipient_created"
        ON "in_app_notifications" ("recipient_user_id", "created_at" DESC)
    `);

    // Unread badge. PARTIAL so the index holds only unread rows: it stays
    // small and the count stays index-only however much read history piles up.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_in_app_notifications_recipient_unread"
        ON "in_app_notifications" ("recipient_user_id")
        WHERE "read_at" IS NULL
    `);

    // Retention sweep + per-clinic support diagnostics.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_in_app_notifications_tenant_created"
        ON "in_app_notifications" ("tenantId", "created_at")
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "notification_preferences" (
        "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id"    uuid NOT NULL,
        "category"   character varying(32) NOT NULL,
        "muted"      boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "FK_notification_preferences_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // Absence of a row means "not muted", so at most one row per
    // (user, category) can ever be meaningful.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notification_preferences_user_category"
        ON "notification_preferences" ("user_id", "category")
    `);
  }

  /**
   * Safe to reverse: both tables are created by this migration and by nothing
   * else, so removing them cannot affect data that predates it. Their indexes
   * and foreign keys go with them.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "notification_preferences"`);
    await q.query(`DROP TABLE IF EXISTS "in_app_notifications"`);
  }
}
