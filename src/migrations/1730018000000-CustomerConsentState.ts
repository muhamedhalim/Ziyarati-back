import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-05 (FND-024) — additive consent-state fields on `customers`.
 *
 * `opted_out_at` / `opt_out_source` record WHEN and HOW an inbound WhatsApp
 * opt-out (e.g. "STOP") was detected. `marketing_opt_in` (existing,
 * `boolean NOT NULL DEFAULT false`) is retained UNCHANGED — these new fields
 * are additive, not a replacement; the boolean alone cannot express when/how
 * an opt-out was registered.
 *
 * Both nullable, no backfill: `NULL` on `opted_out_at` correctly means
 * "never opted out" for every existing row. Rollback ceases use rather than
 * dropping the columns (R-DB6, spec §7) — see `down()`.
 */
export class CustomerConsentState1730018000000 implements MigrationInterface {
  name = 'CustomerConsentState1730018000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'customers' AND column_name = 'opted_out_at'
        ) THEN
          ALTER TABLE "customers" ADD COLUMN "opted_out_at" timestamptz NULL;
        END IF;
      END $$;
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'customers' AND column_name = 'opt_out_source'
        ) THEN
          ALTER TABLE "customers" ADD COLUMN "opt_out_source" varchar(50) NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases (reverting the application code that reads/writes them). Dropping
   * would destroy any opt-out signal already recorded, which is exactly the
   * data this migration exists to protect. Intentionally a no-op.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop opted_out_at / opt_out_source — see docstring.
  }
}
