import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Health-insurance intake field on `customers`, captured directly in the AI
 * booking conversation (and editable from the New/Edit Customer form, same as
 * `has_chronic_diseases` — see `CustomerChronicDiseases1730028000000`).
 *
 * Nullable (tri-state), unlike `has_chronic_diseases`'s `NOT NULL DEFAULT
 * false`: `NULL` means "never asked", `true`/`false` mean a confirmed answer.
 * The AI booking flow relies on this distinction to confirm an on-file answer
 * instead of re-asking a returning patient from scratch.
 *
 * Additive, fully nullable: no existing row can violate this. Rollback ceases
 * use rather than dropping the column (R-DB6) — see `down()`.
 */
export class CustomerHealthInsurance1730030000000
  implements MigrationInterface
{
  name = 'CustomerHealthInsurance1730030000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'customers' AND column_name = 'has_health_insurance'
        ) THEN
          ALTER TABLE "customers" ADD COLUMN "has_health_insurance" boolean NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Dropping would destroy any recorded insurance answers.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop has_health_insurance — see docstring.
  }
}
