import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `file_size` to `ai_training_files`, mirroring `file_uploads.file_size`
 * exactly (`bigint`, nullable). AI Training Files previously carried no size
 * at all — the sellable "AI training files" catalog item is switching from
 * a file-COUNT cap to a byte-size cap (Pricing Catalog: priced per GB), and
 * there was nothing to bill against. `AiTrainingFileService.upload()` /
 * `uploadContent()` populate this column going forward (client-supplied on
 * the metadata-registration path, the real multer-reported byte length on
 * the direct-upload path); existing rows keep `file_size = NULL` (treated
 * as 0 bytes by the new SUM-based quota check).
 */
export class AiTrainingFileSizeColumn1730052000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_training_files" ADD COLUMN IF NOT EXISTS "file_size" bigint`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ai_training_files" DROP COLUMN IF EXISTS "file_size"`,
    );
  }
}
