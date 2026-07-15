import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Access-Control Audit Center metadata for the permission catalogue.
 *
 * Additive & backward-safe: every column is nullable or defaulted, so existing
 * `permissions` rows and all current catalogue consumers keep working unchanged.
 * The seeder (`permissions.seed.ts`) reconciles the exact per-slug values from
 * the metadata registry on its next run; the deterministic SQL backfill below
 * just gives correct values immediately for existing rows without waiting for a
 * reseed. Unknown permissions are NEVER backfilled as high-risk (medium/tenant
 * defaults hold), matching the registry's safe-default rule.
 */
export class PermissionAuditMetadata1730002900000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "description" text`);
    await q.query(
      `ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "scope" character varying(16) NOT NULL DEFAULT 'tenant'`,
    );
    await q.query(
      `ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "risk_level" character varying(16) NOT NULL DEFAULT 'medium'`,
    );
    await q.query(
      `ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "is_deprecated" boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );

    // Deterministic backfill (safe defaults; no fragile high-risk guessing).
    await q.query(
      `UPDATE "permissions" SET "scope" = 'platform' WHERE ("slug" LIKE 'platform.%' OR "slug" = 'tenants.manage') AND "scope" = 'tenant'`,
    );
    await q.query(
      `UPDATE "permissions" SET "risk_level" = 'low' WHERE ("slug" LIKE '%.read' OR "slug" LIKE '%.read\\_own' OR "slug" LIKE '%\\_own' OR "slug" LIKE '%.read.%' OR "slug" = 'analytics.read') AND "risk_level" = 'medium'`,
    );

    // Indexes supporting the audit filters (module/scope/risk/status).
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_permissions_module" ON "permissions" ("module")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_permissions_scope" ON "permissions" ("scope")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_permissions_risk_level" ON "permissions" ("risk_level")`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_permissions_is_deprecated" ON "permissions" ("is_deprecated")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_permissions_is_deprecated"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_permissions_risk_level"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_permissions_scope"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_permissions_module"`);
    await q.query(`ALTER TABLE "permissions" DROP COLUMN IF EXISTS "updated_at"`);
    await q.query(`ALTER TABLE "permissions" DROP COLUMN IF EXISTS "is_deprecated"`);
    await q.query(`ALTER TABLE "permissions" DROP COLUMN IF EXISTS "risk_level"`);
    await q.query(`ALTER TABLE "permissions" DROP COLUMN IF EXISTS "scope"`);
    await q.query(`ALTER TABLE "permissions" DROP COLUMN IF EXISTS "description"`);
  }
}
