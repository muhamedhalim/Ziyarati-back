import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-10 (CAP-I18N / T157 gap-closure) — `notification_templates` gains
 * `provider_template_id_ar`, an OPTIONAL sibling to the existing
 * `provider_template_id` (added by NotificationsWhatsappIntegration1730000900000).
 *
 * Both columns hold a local `WhatsappTemplate.id` (not Meta's own template
 * id — see that entity's own field of the same name for the Meta identity).
 * `provider_template_id` remains the DEFAULT/fallback WhatsApp template a
 * rule sends; this new column lets a tenant additionally link an
 * Arabic-language sibling row (same `WhatsappTemplate.name`, different
 * `language`, per that entity's `@Unique(['tenant','name','language'])`).
 * `NotificationDispatchService` picks whichever matches the recipient
 * Customer's `preferred_locale` (M-09), falling back to the default column
 * when unset or when no Arabic variant was linked — so every
 * already-configured tenant's behavior is UNCHANGED until they explicitly
 * add the Arabic variant.
 *
 * Additive, nullable, no backfill. Rollback ceases use (R-DB6).
 */
export class NotificationTemplateArabicVariant1730026000000
  implements MigrationInterface
{
  name = 'NotificationTemplateArabicVariant1730026000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'notification_templates' AND column_name = 'provider_template_id_ar'
        ) THEN
          ALTER TABLE "notification_templates" ADD COLUMN "provider_template_id_ar" uuid NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Intentionally a no-op.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop provider_template_id_ar — see docstring.
  }
}
