import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `free_access_overrides` as a real migration.
 *
 * The table has existed only because `PlatformBillingBootstrap` runs
 * `CREATE TABLE IF NOT EXISTS` on every boot — and SWALLOWS failures, logging a
 * warning. That is fine on a dev box where the app owns the schema, and a
 * silent trap in production: a deployment whose runtime role holds no DDL
 * grant (the normal hardening for a migrations-managed database) would log one
 * warning at startup and then run with the table absent, so
 * `FreeAccessOverrideService` — consulted on EVERY gated request as step 3 of
 * the access chain — would throw on a missing relation.
 *
 * `IF NOT EXISTS` throughout, so this is a no-op on any environment where the
 * bootstrap already created it. The bootstrap stays in place as a dev
 * convenience; this is what makes the schema guaranteed.
 */
export class FreeAccessOverridesTable1730039000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "free_access_overrides" (
        "id"         uuid PRIMARY KEY,
        "tenant_id"  uuid NOT NULL,
        "granted_by" uuid,
        "reason"     text,
        "starts_at"  timestamptz NOT NULL DEFAULT now(),
        "ends_at"    timestamptz,
        "status"     varchar(20) NOT NULL DEFAULT 'ACTIVE',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz
      )
    `);

    // The hot path on every gated request is
    // `WHERE tenant_id = $1 AND status = 'ACTIVE'`.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_free_override_tenant_status"
        ON "free_access_overrides" ("tenant_id", "status")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Deliberately does NOT drop the table: it may predate this migration
    // (created by the boot DDL), and dropping it would destroy the record of
    // which clinics the platform granted free access to.
    await q.query(`DROP INDEX IF EXISTS "idx_free_override_tenant_status"`);
  }
}
