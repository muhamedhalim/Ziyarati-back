import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Private file storage for customer files (Cloudflare R2), mirroring the
 * `file_url` + `storage_key` dual-column pattern already established by
 * `tenant_verification_documents` (VerificationDocumentStorage1730001400000)
 * and `staff_profiles.avatar_storage_key` (StaffAvatarStorage1730003200000).
 *
 * `file_url` is kept as-is (legacy rows created via the old URL-input flow);
 * the new `storage_key` holds the private R2 object key for files uploaded
 * through the app going forward. No data is destroyed.
 */
export class CustomerFileStorage1730003600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "customer_files" ADD COLUMN IF NOT EXISTS "storage_key" character varying`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "customer_files" DROP COLUMN IF EXISTS "storage_key"`,
    );
  }
}
