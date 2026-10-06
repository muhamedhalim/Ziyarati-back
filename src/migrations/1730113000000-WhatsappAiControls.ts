import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp AI controls — the columns behind the conversation-, patient- and
 * clinic-level controls (the clinic's on/off switch, `bot_enabled`, already
 * exists and is untouched).
 *
 *  - `conversations.ai_mode`             per-conversation override (DEFAULT | ENABLED | DISABLED)
 *  - `conversations.ai_paused_until`     automatic human takeover, as a timestamp (no timer)
 *  - `conversations.ai_mode_changed_at`  / `ai_mode_changed_by_id` — who paused it, and when
 *  - `customers.ai_replies_disabled`     patient-level exclusion (+ `_at`)
 *  - `tenant_settings.ai_human_takeover_minutes`  auto-takeover window, 0 = off
 *
 * Every default reproduces today's behaviour exactly: DEFAULT / not excluded /
 * takeover off. No clinic's AI behaves differently until someone changes a
 * setting.
 *
 * Safe on a live table: each column is added with a constant default, which
 * Postgres applies as catalog metadata without rewriting the table; the CHECKs
 * are declared in the same statement, so they are validated against the default
 * only. Idempotent (`IF NOT EXISTS`) so a re-run, or a database that dev
 * `synchronize` already touched, is a no-op. No data is read, moved or deleted.
 */
export class WhatsappAiControls1730113000000 implements MigrationInterface {
  name = 'WhatsappAiControls1730113000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "conversations"
        ADD COLUMN IF NOT EXISTS "ai_mode" varchar(16) NOT NULL DEFAULT 'DEFAULT'
          CONSTRAINT "CHK_conversations_ai_mode"
          CHECK ("ai_mode" IN ('DEFAULT','ENABLED','DISABLED')),
        ADD COLUMN IF NOT EXISTS "ai_paused_until" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "ai_mode_changed_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "ai_mode_changed_by_id" uuid NULL
          CONSTRAINT "FK_conversations_ai_mode_changed_by"
          REFERENCES "users" ("id") ON DELETE SET NULL
    `);

    await q.query(`
      ALTER TABLE "customers"
        ADD COLUMN IF NOT EXISTS "ai_replies_disabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "ai_replies_disabled_at" timestamptz NULL
    `);

    await q.query(`
      ALTER TABLE "tenant_settings"
        ADD COLUMN IF NOT EXISTS "ai_human_takeover_minutes" integer NOT NULL DEFAULT 0
          CONSTRAINT "CHK_tenant_settings_ai_human_takeover_minutes"
          CHECK ("ai_human_takeover_minutes" BETWEEN 0 AND 1440)
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Dropping would discard every clinic's pauses and patient
   * exclusions, and the columns are inert the moment nothing reads them.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop the columns — see docstring.
  }
}
