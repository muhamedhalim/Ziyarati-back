import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5 — real outbound sync support.
 *
 * `staff_profiles` is the only one of the four integration resources
 * (customer/service/staff/appointment) without an `updated_at` column, which
 * outbound sync needs to detect "changed since the last run" the same way it
 * already does for the other three. Fully additive: a plain nullable-free
 * column with a `now()` default so every existing row gets a valid value and
 * no other table/column changes.
 */
export class IntegrationOutboundSync1730013000000 implements MigrationInterface {
  name = 'IntegrationOutboundSync1730013000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'staff_profiles' AND column_name = 'updated_at'
        ) THEN
          ALTER TABLE "staff_profiles" ADD COLUMN "updated_at" TIMESTAMP NOT NULL DEFAULT now();
        END IF;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "staff_profiles" DROP COLUMN IF EXISTS "updated_at"`);
  }
}
