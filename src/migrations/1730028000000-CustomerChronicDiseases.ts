import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chronic-disease intake fields on `customers`, captured directly in the
 * New/Edit Customer form (not the separate `customer_profiles` clinical
 * record). `has_chronic_diseases` defaults false so existing rows are valid
 * without backfill; `chronic_diseases` is nullable free text, required only
 * when the boolean is true (enforced in CustomerService, not just the DTO).
 *
 * Additive, mostly-nullable: no existing row can violate this. Rollback
 * ceases use rather than dropping columns (R-DB6) — see `down()`.
 */
export class CustomerChronicDiseases1730028000000
  implements MigrationInterface
{
  name = 'CustomerChronicDiseases1730028000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'customers' AND column_name = 'has_chronic_diseases'
        ) THEN
          ALTER TABLE "customers" ADD COLUMN "has_chronic_diseases" boolean NOT NULL DEFAULT false;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'customers' AND column_name = 'chronic_diseases'
        ) THEN
          ALTER TABLE "customers" ADD COLUMN "chronic_diseases" text NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Dropping would destroy any chronic-disease data already recorded.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop has_chronic_diseases/chronic_diseases — see docstring.
  }
}
