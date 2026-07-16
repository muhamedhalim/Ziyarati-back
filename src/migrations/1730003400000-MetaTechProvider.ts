import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 — Meta Tech Provider schema.
 *
 * Four related changes:
 *
 * 1. `whatsapp_accounts` gains the Embedded Signup connection facts
 *    (provider, meta_business_id, display_phone_number, verified_name,
 *    connection_status, connected_at, last_synced_at) plus `is_default`.
 *
 * 2. Multi-number support: DROP `UQ_whatsapp_account_branch_mode` and make
 *    `branch_id` nullable. That constraint capped each branch at one number per
 *    mode and (with a NOT NULL branch) made both "several numbers per tenant"
 *    and "a tenant-level number" unrepresentable. Uniqueness moves to where it
 *    is a real invariant — the Meta phone number — which Phase 1 already
 *    enforces via UQ_whatsapp_account_phone_number_id_live. Dropping a UNIQUE
 *    constraint only widens what is accepted, so no existing row can violate it.
 *
 * 3. `whatsapp_templates` gains the Meta-side identity needed to sync and to
 *    enforce template↔account WABA matching (provider_template_id, waba_id,
 *    rejected_reason, last_synced_at).
 *
 * 4. `campaigns` gains an explicit `whatsapp_account_id` — which number the
 *    campaign sends from. NULLABLE so existing campaigns keep working (they
 *    fall back to the tenant default at launch).
 *
 * Backfill: existing accounts predate Embedded Signup, so any row that already
 * carries credentials is marked CONNECTED (it was working before this deploy —
 * calling it PENDING would strand it), and each tenant's oldest account becomes
 * its default, preserving Phase 1's oldest-first selection for anyone already
 * relying on it. Everything is idempotent (IF NOT EXISTS / guarded UPDATEs).
 */
export class MetaTechProvider1730003400000 implements MigrationInterface {
  name = 'MetaTechProvider1730003400000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 1. Connection facts on whatsapp_accounts ───────────────────────────
    await q.query(`
      ALTER TABLE "whatsapp_accounts"
        ADD COLUMN IF NOT EXISTS "provider" character varying(30) NOT NULL DEFAULT 'META_CLOUD',
        ADD COLUMN IF NOT EXISTS "meta_business_id" character varying(100),
        ADD COLUMN IF NOT EXISTS "display_phone_number" character varying(30),
        ADD COLUMN IF NOT EXISTS "verified_name" character varying(255),
        ADD COLUMN IF NOT EXISTS "connection_status" character varying(20) NOT NULL DEFAULT 'PENDING',
        ADD COLUMN IF NOT EXISTS "connected_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false
    `);

    // ── 2. Multi-number support ────────────────────────────────────────────
    await q.query(`
      ALTER TABLE "whatsapp_accounts"
        DROP CONSTRAINT IF EXISTS "UQ_whatsapp_account_branch_mode"
    `);
    await q.query(`
      ALTER TABLE "whatsapp_accounts"
        ALTER COLUMN "branch_id" DROP NOT NULL
    `);

    // At most ONE default account per tenant among live rows. Partial so
    // soft-deleted rows and non-defaults never collide. This is the constraint
    // that lets the resolver trust `is_default` instead of guessing.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_whatsapp_account_one_default_per_tenant"
      ON "whatsapp_accounts" ("tenantId")
      WHERE "is_default" = true AND "deleted_at" IS NULL
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_whatsapp_account_tenant_active"
      ON "whatsapp_accounts" ("tenantId", "is_active")
    `);

    // ── 3. Template sync identity ──────────────────────────────────────────
    await q.query(`
      ALTER TABLE "whatsapp_templates"
        ADD COLUMN IF NOT EXISTS "provider_template_id" character varying(100),
        ADD COLUMN IF NOT EXISTS "waba_id" character varying(100),
        ADD COLUMN IF NOT EXISTS "rejected_reason" text,
        ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP WITH TIME ZONE
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_whatsapp_template_waba"
      ON "whatsapp_templates" ("waba_id")
    `);

    // ── 4. Campaign → sending account ──────────────────────────────────────
    await q.query(`
      ALTER TABLE "campaigns"
        ADD COLUMN IF NOT EXISTS "whatsapp_account_id" uuid
    `);
    // ON DELETE SET NULL, not CASCADE: disconnecting a number must never delete
    // the campaigns (and their audit history) that were sent from it.
    //
    // The constraint name is TypeORM's own generated name for this relation, so
    // `synchronize` (dev) recognises it as already-correct instead of dropping
    // and recreating it under its own name on every boot.
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_5fb4b22bf204607ce65af40635c'
        ) THEN
          ALTER TABLE "campaigns"
            ADD CONSTRAINT "FK_5fb4b22bf204607ce65af40635c"
            FOREIGN KEY ("whatsapp_account_id") REFERENCES "whatsapp_accounts"("id")
            ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // ── 5. Inbound media idempotency ───────────────────────────────────────
    // Media download is a retryable worker job, so it needs a stable key to
    // answer "did I already store this?". `file_name` cannot serve: WhatsApp
    // media often arrives unnamed, and two photos can share a filename.
    await q.query(`
      ALTER TABLE "message_attachments"
        ADD COLUMN IF NOT EXISTS "provider_media_id" character varying(100)
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_message_attachment_provider_media"
      ON "message_attachments" ("messageId", "provider_media_id")
    `);

    // ── Backfill ───────────────────────────────────────────────────────────
    // Rows with credentials were already sending before this deploy; leaving
    // them PENDING would strand working connections.
    await q.query(`
      UPDATE "whatsapp_accounts"
      SET "connection_status" = 'CONNECTED',
          "connected_at" = COALESCE("connected_at", "created_at")
      WHERE "access_token" IS NOT NULL
        AND "access_token" <> ''
        AND "phone_number_id" IS NOT NULL
        AND "deleted_at" IS NULL
        AND "connection_status" = 'PENDING'
    `);

    // Preserve Phase 1's oldest-first pick as each tenant's explicit default,
    // so selection behaviour does not change under anyone on upgrade.
    await q.query(`
      UPDATE "whatsapp_accounts" AS wa
      SET "is_default" = true
      FROM (
        SELECT DISTINCT ON ("tenantId") "id"
        FROM "whatsapp_accounts"
        WHERE "deleted_at" IS NULL AND "is_active" = true
        ORDER BY "tenantId", "created_at" ASC
      ) AS first_per_tenant
      WHERE wa."id" = first_per_tenant."id"
        AND NOT EXISTS (
          SELECT 1 FROM "whatsapp_accounts" existing
          WHERE existing."tenantId" = wa."tenantId"
            AND existing."is_default" = true
            AND existing."deleted_at" IS NULL
        )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_message_attachment_provider_media"`);
    await q.query(
      `ALTER TABLE "message_attachments" DROP COLUMN IF EXISTS "provider_media_id"`,
    );

    await q.query(
      `ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "FK_5fb4b22bf204607ce65af40635c"`,
    );
    await q.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "whatsapp_account_id"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_whatsapp_template_waba"`);
    await q.query(`
      ALTER TABLE "whatsapp_templates"
        DROP COLUMN IF EXISTS "provider_template_id",
        DROP COLUMN IF EXISTS "waba_id",
        DROP COLUMN IF EXISTS "rejected_reason",
        DROP COLUMN IF EXISTS "last_synced_at"
    `);

    await q.query(`DROP INDEX IF EXISTS "IDX_whatsapp_account_tenant_active"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_whatsapp_account_one_default_per_tenant"`);
    await q.query(`
      ALTER TABLE "whatsapp_accounts"
        DROP COLUMN IF EXISTS "provider",
        DROP COLUMN IF EXISTS "meta_business_id",
        DROP COLUMN IF EXISTS "display_phone_number",
        DROP COLUMN IF EXISTS "verified_name",
        DROP COLUMN IF EXISTS "connection_status",
        DROP COLUMN IF EXISTS "connected_at",
        DROP COLUMN IF EXISTS "last_synced_at",
        DROP COLUMN IF EXISTS "is_default"
    `);
    // NOTE: `branch_id` is intentionally NOT restored to NOT NULL and the
    // (branch, mode) UNIQUE is not recreated — tenant-level accounts created
    // under this migration would have a NULL branch and could not satisfy
    // either. Rolling those back needs a deliberate data decision, not a
    // blind DDL revert.
  }
}
