import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where and when a patient's marketing consent came from.
 *
 * Until now only the boolean `marketing_opt_in` existed: nothing recorded WHEN it
 * was given or through WHICH channel, so a clinic could not answer "who agreed,
 * and how?". Both columns are NULL for every existing row, which reads as
 * "legacy — provenance unknown"; nothing is back-filled or invented.
 *
 *  - `marketing_opt_in_at`     when the flag last became true.
 *  - `marketing_opt_in_source` how (`staff`, `import`, `patient_form`, …).
 *
 * The consent decision itself is unchanged (it still reads `marketing_opt_in` and
 * `opted_out_at`); these columns only add the record. Additive, nullable, no data
 * moved. Idempotent.
 */
export class CustomerMarketingConsentProvenance1730129000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "customers"
        ADD COLUMN IF NOT EXISTS "marketing_opt_in_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "marketing_opt_in_source" character varying(32)
    `);
  }

  /** R-DB6: additive columns are never dropped on rollback. */
  public async down(): Promise<void> {
    // intentionally empty
  }
}
