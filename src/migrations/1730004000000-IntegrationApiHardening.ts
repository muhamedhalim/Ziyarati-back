import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema support for Phase 1 of the external integration API:
 *
 *  1. `api_keys.key_prefix` — first few characters of the plaintext, safe to
 *     display so an owner can tell keys apart without ever storing/re-showing
 *     the full secret. Nullable: existing rows (created before this column)
 *     simply show no prefix until rotated.
 *  2. `api_logs.api_key_id` — attributes a request-log row to the API key that
 *     authenticated it (nullable: most traffic is JWT-cookie authenticated and
 *     carries no key). Plain column, not a TypeORM relation — this is a
 *     best-effort correlation id for usage metrics, not a loaded association.
 *     FK is `ON DELETE NO ACTION` (matches every other FK in this schema); API
 *     keys are never hard-deleted (only revoked), so the log row always
 *     resolves.
 *  3. `api_keys(tenantId)` index — the tenant list/read queries' only filter,
 *     previously unindexed.
 *
 * All additive/nullable; no backfill required, no existing behaviour changes.
 */
export class IntegrationApiHardening1730004000000 implements MigrationInterface {
  name = 'IntegrationApiHardening1730004000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "api_keys"
        ADD COLUMN IF NOT EXISTS "key_prefix" character varying(16)
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_api_keys_tenantId" ON "api_keys" ("tenantId")
    `);

    await q.query(`
      ALTER TABLE "api_logs"
        ADD COLUMN IF NOT EXISTS "api_key_id" uuid
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_api_logs_api_key_id'
        ) THEN
          ALTER TABLE "api_logs"
            ADD CONSTRAINT "FK_api_logs_api_key_id"
            FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_api_logs_api_key_id" ON "api_logs" ("api_key_id")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IX_api_logs_api_key_id"`);
    await q.query(`ALTER TABLE "api_logs" DROP CONSTRAINT IF EXISTS "FK_api_logs_api_key_id"`);
    await q.query(`ALTER TABLE "api_logs" DROP COLUMN IF EXISTS "api_key_id"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_api_keys_tenantId"`);
    await q.query(`ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "key_prefix"`);
  }
}
