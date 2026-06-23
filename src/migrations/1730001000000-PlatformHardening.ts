import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform hardening indexes:
 *  - api_logs / webhook_logs: (created_at) for the retention purge.
 *  - api_keys: (key_hash) is already UNIQUE (auth lookup); add (expires_at) for
 *    expiry housekeeping and (is_active) filter.
 * Idempotent.
 */
export class PlatformHardening1730001000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_api_logs_created" ON "api_logs" ("created_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_webhook_logs_created" ON "webhook_logs" ("created_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_api_keys_expires_at" ON "api_keys" ("expires_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IX_api_keys_expires_at"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_webhook_logs_created"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_api_logs_created"`);
  }
}
