import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Private document storage for tenant verification (Cloudflare R2).
 *
 * Moves verification documents off ad-hoc public `file_url` strings onto private
 * object keys: adds `storage_key` + file metadata (`original_filename`,
 * `mime_type`, `size_bytes`, `uploaded_by`) and relaxes `file_url` to nullable
 * (legacy/external rows keep their URL; new R2 rows store only the key). No data
 * is destroyed — existing `file_url` values are preserved.
 */
export class VerificationDocumentStorage1730001400000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ALTER COLUMN "file_url" DROP NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ADD COLUMN IF NOT EXISTS "storage_key" character varying`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ADD COLUMN IF NOT EXISTS "original_filename" character varying`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ADD COLUMN IF NOT EXISTS "mime_type" character varying`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ADD COLUMN IF NOT EXISTS "size_bytes" integer`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ADD COLUMN IF NOT EXISTS "uploaded_by" character varying`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "tenant_verification_documents" DROP COLUMN IF EXISTS "uploaded_by"`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" DROP COLUMN IF EXISTS "size_bytes"`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" DROP COLUMN IF EXISTS "mime_type"`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" DROP COLUMN IF EXISTS "original_filename"`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" DROP COLUMN IF EXISTS "storage_key"`,
    );
    // Re-imposing NOT NULL could fail if R2-only rows exist (null file_url);
    // backfill a placeholder so the down-migration is safe to run.
    await q.query(
      `UPDATE "tenant_verification_documents" SET "file_url" = '' WHERE "file_url" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "tenant_verification_documents" ALTER COLUMN "file_url" SET NOT NULL`,
    );
  }
}
