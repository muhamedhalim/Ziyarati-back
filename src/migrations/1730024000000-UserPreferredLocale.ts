import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-08 (CAP-I18N) — persisted locale preference on `users`.
 *
 * `preferred_locale` is nullable with NO backfill: `NULL` is meaningful — it
 * means "no explicit choice yet, fall back to the AD-09 detection rule"
 * (URL segment -> cookie -> Accept-Language -> configured default). Backfilling
 * every existing user to a guessed locale would override that resolution
 * order for accounts that never actually chose one (spec data-model.md §M-08).
 *
 * Additive, nullable: no existing row can violate this, no data migration
 * needed. Rollback ceases use rather than dropping the column (R-DB6) —
 * see `down()`.
 */
export class UserPreferredLocale1730024000000 implements MigrationInterface {
  name = 'UserPreferredLocale1730024000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'preferred_locale'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "preferred_locale" varchar(10) NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Dropping would destroy any locale choice already recorded, which
   * is exactly the data this migration exists to protect. Intentionally a
   * no-op (mirrors CustomerConsentState1730018000000's identical rationale).
   */
  public async down(): Promise<void> {
    // Deliberately does not drop preferred_locale — see docstring.
  }
}
