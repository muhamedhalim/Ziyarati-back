import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp template ↔ clinic data binding.
 *
 * Adds `whatsapp_templates.variable_mapping` — a jsonb map of placeholder name
 * → a trusted data source (`patient_name`, `appointment_date`, …) resolved
 * server-side when a notification is sent. Before this column an approved
 * template with `{{1}}`/`{{2}}` placeholders could not be driven by the
 * notification pipeline at all: nothing supplied the values, so every such
 * send failed validation and fell back to email.
 *
 * Safe on a live table: a nullable column with no default is catalog-only (no
 * rewrite). Existing rows stay NULL, which means "no automation binding" and
 * changes no current behaviour. Idempotent (`IF NOT EXISTS`). No data is read,
 * moved or deleted.
 */
export class WhatsappTemplateVariableMapping1730116000000 implements MigrationInterface {
  name = 'WhatsappTemplateVariableMapping1730116000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "whatsapp_templates"
        ADD COLUMN IF NOT EXISTS "variable_mapping" jsonb
    `);
  }

  /** R-DB6: additive columns are never dropped on rollback. */
  public async down(): Promise<void> {
    // Deliberately does not drop the column.
  }
}
