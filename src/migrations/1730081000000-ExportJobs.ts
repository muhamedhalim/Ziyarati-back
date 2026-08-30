import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T179 (US13, data-model.md §1.11).
 * New `export_jobs` table tracking one report-export request per row.
 *
 * Renumbered from tasks.md's suggested `1730075000000`: that slot was
 * already taken by `InvoiceDocumentTracking1730075000000` (Phase 8) by the
 * time this migration was written. Following this repo's own precedent for
 * a renumbered slot (see `CustomerSegments1730071000000`'s and
 * `WaitlistEntriesAndOffers1730078000000`'s docblocks), this migration takes
 * the next free integer above whatever was actually on disk at write time
 * (`1730080000000-QueueEntries`, Phase 14) rather than the number the
 * design doc guessed.
 *
 * `filters`/`branch_scope` are captured at request time and never updated
 * afterward (FR-X001/security note in tasks.md T179/T181) — no UPDATE path
 * in the application ever touches those two columns after INSERT. `report`
 * is a plain varchar validated against the closed registry at the
 * application layer (`export-registry.ts`, T180), never a DB enum — adding
 * an exportable report must never require a migration. `state`/`format` are
 * varchar (not native Postgres enums), matching this schema's existing
 * convention for short lifecycle/kind columns (see `waitlist_offers.state`,
 * `waitlist_entries.state`).
 *
 * Brand new table with no existing data, so a plain (non-`CONCURRENTLY`)
 * build is safe — no production write path is blocked by locking a table
 * that does not yet exist.
 */
export class ExportJobs1730081000000 implements MigrationInterface {
  name = 'ExportJobs1730081000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "export_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "requestedById" uuid NOT NULL,
        "report" varchar(60) NOT NULL,
        "format" varchar(10) NOT NULL DEFAULT 'XLSX',
        "filters" jsonb NOT NULL,
        "branch_scope" jsonb,
        "state" varchar(20) NOT NULL DEFAULT 'PENDING',
        "storage_key" varchar,
        "row_count" integer,
        "error" text,
        "expires_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_export_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_export_jobs_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_export_jobs_requested_by" FOREIGN KEY ("requestedById")
          REFERENCES "users" ("id")
      )
    `);

    // The user's export list (T184 GET, most-recent-first).
    await q.query(
      `CREATE INDEX "IDX_export_jobs_tenant_requested_created" ON "export_jobs" ("tenantId", "requestedById", "created_at" DESC)`,
    );
    // The expiry sweep (T183 platform.exportExpiry).
    await q.query(
      `CREATE INDEX "IDX_export_jobs_state_expires" ON "export_jobs" ("state", "expires_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "export_jobs"`);
  }
}
