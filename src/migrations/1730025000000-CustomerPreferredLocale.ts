import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-09 (CAP-I18N / T157 gap-closure) — persisted locale preference on
 * `customers`, mirroring M-08's `users.preferred_locale` exactly.
 *
 * WhatsApp is the customer's actual notification channel (see
 * notification-dispatch.service.ts); `Customer` had no locale field at all,
 * which is what left LG-7/LG-8 unable to select a per-recipient WhatsApp
 * template language automatically. `NULL` is meaningful — it means "no
 * explicit choice recorded, fall back to `DEFAULT_LOCALE`" (the same
 * fallback semantics as M-08), not a guessed value. No backfill.
 *
 * Additive, nullable: no existing row can violate this, no data migration
 * needed. Rollback ceases use rather than dropping the column (R-DB6) —
 * see `down()`.
 */
export class CustomerPreferredLocale1730025000000
  implements MigrationInterface
{
  name = 'CustomerPreferredLocale1730025000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'customers' AND column_name = 'preferred_locale'
        ) THEN
          ALTER TABLE "customers" ADD COLUMN "preferred_locale" varchar(10) NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Dropping would destroy any locale choice already recorded.
   * Intentionally a no-op (mirrors UserPreferredLocale1730024000000's
   * identical rationale).
   */
  public async down(): Promise<void> {
    // Deliberately does not drop preferred_locale — see docstring.
  }
}
