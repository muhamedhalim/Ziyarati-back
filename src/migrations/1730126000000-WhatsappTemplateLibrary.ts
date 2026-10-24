import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp template library (the six ready-made Arabic templates).
 *
 * A library template is a clinic-owned row, adopted explicitly from a versioned
 * catalog that lives in code (`template-library.catalog.ts`). These two columns
 * record WHICH catalog entry a row came from and WHICH version it was copied
 * from, so a later catalog revision can be offered as an update without ever
 * overwriting what the clinic edited.
 *
 *  - `library_key`     NULL for every existing / hand-authored template.
 *  - `library_version` the catalog version the row was last copied from.
 *  - Partial UNIQUE (tenant, library_key): a clinic holds at most one live row per
 *    library entry, which is what makes "adopt" idempotent under a double click or
 *    two instances racing. Soft-deleted rows are excluded so a clinic can re-adopt
 *    after deleting.
 *  - `status` default: the entity default was the upper-case `'PENDING'`, which is
 *    not part of the app's vocabulary (`draft | pending_review | approved | …`).
 *    Every writer sets status explicitly, so this changed nothing at runtime; it
 *    now defaults to the one value that is actually safe (not sendable).
 *
 * Safe on a live table: nullable columns without a default are catalog-only; the
 * index is on an empty-for-now column of a small table; `SET DEFAULT` rewrites
 * nothing. Idempotent. No data is read, moved or deleted.
 */
export class WhatsappTemplateLibrary1730126000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "whatsapp_templates"
        ADD COLUMN IF NOT EXISTS "library_key" character varying(64),
        ADD COLUMN IF NOT EXISTS "library_version" integer
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_whatsapp_templates_tenant_library_key"
        ON "whatsapp_templates" ("tenantId", "library_key")
        WHERE "library_key" IS NOT NULL AND "deleted_at" IS NULL
    `);
    await q.query(`
      ALTER TABLE "whatsapp_templates" ALTER COLUMN "status" SET DEFAULT 'draft'
    `);
  }

  /** R-DB6: additive columns are never dropped on rollback; only the default is restored. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "UQ_whatsapp_templates_tenant_library_key"`,
    );
    await q.query(
      `ALTER TABLE "whatsapp_templates" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
  }
}
