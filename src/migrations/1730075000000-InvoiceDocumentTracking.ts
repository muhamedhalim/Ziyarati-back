import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — supports T095/T096 (US12,
 * FR-I009, FR-I010, FR-I012). Not itself named as a task in tasks.md's
 * Phase 8 list — T092 is the ONLY migration task that phase names — but
 * T095 ("idempotent on (invoiceId, invoiceVersion)") and T096 ("202 pending
 * … ready … 409 draft") require SOME persisted document-render state, and no
 * table for it exists anywhere in the schema (verified live). Adding the
 * minimum columns directly on `invoices` rather than a new table: one
 * rendered document per invoice at a time is the whole requirement, so a
 * side table would be pure overhead.
 *
 * `document_version` is bumped by whatever TRIGGERS a (re-)render
 * (`finalize()`, the regenerate route); `document_rendered_version` is set
 * by the worker once that version's PDF is actually stored — the gap
 * between the two IS the "pending" state T096 asks for. `document_key` is
 * the current rendered object's storage key (overwritten each successful
 * render, never accumulated) — FR-I012's private, tenant-prefixed storage.
 */
export class InvoiceDocumentTracking1730075000000 implements MigrationInterface {
  name = 'InvoiceDocumentTracking1730075000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "invoices"
        ADD COLUMN IF NOT EXISTS "document_key" varchar,
        ADD COLUMN IF NOT EXISTS "document_version" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "document_rendered_version" integer
    `);
  }

  /** Fully reversible: drops only the columns this migration added. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "invoices"
        DROP COLUMN IF EXISTS "document_key",
        DROP COLUMN IF EXISTS "document_version",
        DROP COLUMN IF EXISTS "document_rendered_version"
    `);
  }
}
