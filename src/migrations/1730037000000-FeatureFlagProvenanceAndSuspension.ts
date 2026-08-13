import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes `feature_flags` safe to use as an AUTHORIZATION input, and repairs the
 * `ai` / `ai.assistant` key drift.
 *
 * Three problems this fixes:
 *
 * 1. NO PROVENANCE. `PUT /feature-flags` (tenant self-service, permission
 *    `featureflag.manage`) and `PUT /platform/feature-flags/tenants/:id/features`
 *    (super-admin) both wrote the SAME row, and `AccessControlService` granted
 *    access from it without asking who wrote it. Since `featureflag.manage` was
 *    delegable into a tenant custom role by any Owner holding `roles.manage`, a
 *    clinic could self-grant paid features and unmetered usage. `source` makes
 *    the writer explicit; only PLATFORM_ADMIN / BILLING_UPGRADE rows carry
 *    authorization weight.
 *
 * 2. NO KILL-SWITCH. `is_enabled = false` was overloaded to mean both "no
 *    override here" and "denied", so clearing an override could not be
 *    distinguished from deliberately suspending a capability — and the deny
 *    silently outranked a paid plan. `is_suspended` is the explicit,
 *    reason-carrying administrative denial; `is_enabled = false` now simply
 *    means "not granted".
 *
 * 3. KEY DRIFT. 10 AI controllers gated on `'ai'` while the catalog only ever
 *    published `'ai.assistant'`, so the toggle a super-admin could reach was
 *    not the key any route checked. The code now uses `ai.assistant`
 *    everywhere; existing rows are migrated to match, keeping the grant.
 *
 * The key remap is deliberately NOT reversed in `down()` — reversing it would
 * re-break every grant it repaired. `down()` only drops the added columns.
 */
export class FeatureFlagProvenanceAndSuspension1730037000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "feature_flags"
        ADD COLUMN IF NOT EXISTS "source" character varying(24) NOT NULL DEFAULT 'TENANT',
        ADD COLUMN IF NOT EXISTS "is_suspended" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "suspended_reason" text,
        ADD COLUMN IF NOT EXISTS "suspended_by" uuid,
        ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "updated_by" uuid,
        ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    `);

    // Every pre-existing row was written before the tenant-facing endpoint was
    // neutered, but in practice these were set by super-admins through the
    // platform UI (that is the only workflow the product documents). Defaulting
    // them to TENANT would REVOKE access the platform intended to grant, so the
    // safe backfill is PLATFORM_ADMIN. New rows take the column default.
    await q.query(
      `UPDATE "feature_flags" SET "source" = 'PLATFORM_ADMIN' WHERE "source" = 'TENANT'`,
    );

    // ── ai → ai.assistant ────────────────────────────────────────────────
    // Merge first (a tenant may hold BOTH rows): the grant wins, so a tenant
    // enabled under either key stays enabled.
    await q.query(`
      UPDATE "feature_flags" target
         SET "is_enabled" = true
        FROM "feature_flags" legacy
       WHERE target."feature_key" = 'ai.assistant'
         AND legacy."feature_key" = 'ai'
         AND target."tenantId" = legacy."tenantId"
         AND legacy."is_enabled" = true
    `);
    await q.query(`
      DELETE FROM "feature_flags" legacy
       USING "feature_flags" target
       WHERE legacy."feature_key" = 'ai'
         AND target."feature_key" = 'ai.assistant'
         AND legacy."tenantId" = target."tenantId"
    `);
    await q.query(
      `UPDATE "feature_flags" SET "feature_key" = 'ai.assistant' WHERE "feature_key" = 'ai'`,
    );

    // Same remap for the catalog-side tables, with the same conflict-first
    // ordering so the unique constraints hold.
    await q.query(`
      DELETE FROM "feature_plans" legacy
       USING "feature_plans" target
       WHERE legacy."feature_key" = 'ai'
         AND target."feature_key" = 'ai.assistant'
         AND legacy."plan_id" = target."plan_id"
    `);
    await q.query(
      `UPDATE "feature_plans" SET "feature_key" = 'ai.assistant' WHERE "feature_key" = 'ai'`,
    );

    await q.query(`
      DELETE FROM "feature_dependencies" legacy
       USING "feature_dependencies" target
       WHERE legacy."feature_key" = 'ai'
         AND target."feature_key" = 'ai.assistant'
         AND legacy."requires_key" = target."requires_key"
    `);
    await q.query(
      `UPDATE "feature_dependencies" SET "feature_key" = 'ai.assistant' WHERE "feature_key" = 'ai'`,
    );
    await q.query(
      `UPDATE "feature_dependencies" SET "requires_key" = 'ai.assistant' WHERE "requires_key" = 'ai'`,
    );

    // A stray `ai` definition (hand-created to work around the drift) is now
    // redundant: FeatureCatalogBootstrap syncs `ai.assistant` on every boot.
    await q.query(
      `DELETE FROM "feature_definitions" WHERE "feature_key" = 'ai'`,
    );

    // Capabilities that had NO runtime gate before this release are about to
    // get one (`@RequireFeature` is being added to their controllers). Their
    // catalog rows were seeded `default_enabled = false` back when nothing
    // read them, so leaving them alone would newly 403 every PAYING clinic the
    // moment the platform switches to PAID mode. Turning them on preserves
    // exactly today's behaviour; an operator can still switch them off
    // deliberately afterwards.
    await q.query(`
      UPDATE "feature_definitions"
         SET "default_enabled" = true
       WHERE "feature_key" IN ('reviews', 'payments')
         AND "default_enabled" = false
    `);

    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_feature_flags_tenant_source" ON "feature_flags" ("tenantId", "source")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_feature_flags_tenant_source"`);
    await q.query(`
      ALTER TABLE "feature_flags"
        DROP COLUMN IF EXISTS "updated_at",
        DROP COLUMN IF EXISTS "updated_by",
        DROP COLUMN IF EXISTS "suspended_at",
        DROP COLUMN IF EXISTS "suspended_by",
        DROP COLUMN IF EXISTS "suspended_reason",
        DROP COLUMN IF EXISTS "is_suspended",
        DROP COLUMN IF EXISTS "source"
    `);
  }
}
