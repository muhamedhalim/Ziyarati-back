import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Private avatar storage for staff profiles (Cloudflare R2), mirroring the
 * `file_url` + `storage_key` dual-column pattern already established by
 * `tenant_verification_documents` (see VerificationDocumentStorage1730001400000).
 *
 * `avatar_url` is kept as-is (legacy/external URLs, back-compat); the new
 * `avatar_storage_key` holds the private R2 object key for avatars uploaded
 * through the app going forward. No data is destroyed.
 */
export class StaffAvatarStorage1730003200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "staff_profiles" ADD COLUMN IF NOT EXISTS "avatar_storage_key" character varying`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "staff_profiles" DROP COLUMN IF EXISTS "avatar_storage_key"`,
    );
  }
}
