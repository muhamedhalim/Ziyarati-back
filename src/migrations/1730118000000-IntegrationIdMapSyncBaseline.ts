import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integration API audit remediation (F01) — sync baseline on the id mapping.
 *
 * Adds two nullable columns to `integration_id_map`:
 *   - `last_synced_hash`  SHA-256 fingerprint of the platform record's
 *                         comparable view as of the last write the integration
 *                         applied (or observed equal);
 *   - `last_synced_at`    when that baseline was recorded.
 *
 * With them the default `reject_and_report` policy can tell "nobody but this
 * integration has touched the record" (apply the partner's update) from "the
 * clinic edited it" (a genuine conflict). Before this, ANY differing update on a
 * default connection was refused, including a partner updating a record it had
 * created itself.
 *
 * Safe on a live table: nullable columns without defaults are catalog-only (no
 * rewrite) and NULL means "no baseline known → stay conservative", i.e. existing
 * mappings behave exactly as they did until their next observed write. Idempotent
 * (`IF NOT EXISTS`). No data is read, moved or deleted.
 */
export class IntegrationIdMapSyncBaseline1730118000000 implements MigrationInterface {
  name = 'IntegrationIdMapSyncBaseline1730118000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "integration_id_map"
        ADD COLUMN IF NOT EXISTS "last_synced_hash" character varying(64),
        ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  /** R-DB6: additive columns are never dropped on rollback. */
  public async down(): Promise<void> {
    // Deliberately does not drop the columns.
  }
}
