import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp Business App Coexistence (Feature: Meta Embedded Signup
 * Coexistence). Adds onboarding-mode + sync-tracking columns to
 * `whatsapp_accounts` so the platform can:
 *  - tell a COEXISTENCE-connected number (already live in the clinic's own
 *    WhatsApp Business App) apart from a STANDARD managed Cloud API number;
 *  - record Meta's own `is_on_biz_app`/`platform_type` verdict for that
 *    number (see `MetaGraphClient.getPhoneCoexistenceStatus`);
 *  - track the two required `smb_app_data` sync operations
 *    (`smb_app_state_sync` then `history`) with a durable, per-account status
 *    + timestamp + last error, so a sync is never re-run once completed and a
 *    failure is diagnosable without grepping logs (see
 *    `WhatsappCoexistenceSyncService`).
 *
 * All eight columns are nullable (`onboarding_type` has a constant default
 * instead, so every existing row is unambiguously STANDARD) — a
 * metadata-only change on Postgres 11+, no table rewrite, no lock beyond the
 * brief ACCESS EXCLUSIVE needed to add the columns. `IF NOT EXISTS` /
 * `IF EXISTS` throughout, matching this repo's other additive migrations
 * (e.g. `FreeAccessNoticeTracking1730102000000`), so a re-run (or `synchronize`
 * having already added the column in a dev box) is a no-op rather than an error.
 */
export class WhatsappCoexistence1730104000000 implements MigrationInterface {
  name = 'WhatsappCoexistence1730104000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "whatsapp_accounts"
      ADD COLUMN IF NOT EXISTS "onboarding_type" varchar(20) NOT NULL DEFAULT 'STANDARD',
      ADD COLUMN IF NOT EXISTS "is_on_biz_app" boolean,
      ADD COLUMN IF NOT EXISTS "platform_type" varchar(20),
      ADD COLUMN IF NOT EXISTS "coexistence_state_sync_status" varchar(20),
      ADD COLUMN IF NOT EXISTS "coexistence_state_sync_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "coexistence_history_sync_status" varchar(20),
      ADD COLUMN IF NOT EXISTS "coexistence_history_sync_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "coexistence_last_sync_error" text
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "whatsapp_accounts"
      DROP COLUMN IF EXISTS "coexistence_last_sync_error",
      DROP COLUMN IF EXISTS "coexistence_history_sync_at",
      DROP COLUMN IF EXISTS "coexistence_history_sync_status",
      DROP COLUMN IF EXISTS "coexistence_state_sync_at",
      DROP COLUMN IF EXISTS "coexistence_state_sync_status",
      DROP COLUMN IF EXISTS "platform_type",
      DROP COLUMN IF EXISTS "is_on_biz_app",
      DROP COLUMN IF EXISTS "onboarding_type"
    `);
  }
}
