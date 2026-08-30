import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T104 (US6, data-model.md §1.2–1.5).
 *
 * Creates the four clinical tables. All brand-new, no existing data — plain
 * (non-CONCURRENTLY) builds. Does NOT touch `customers` or `customer_profiles`
 * (no widening, no migration-away — the existing free-text profile fields
 * stay exactly where they are, per FR-H004).
 *
 * NOTE ON TIMESTAMP: data-model.md's own migration table names this
 * `1730068000000-ClinicalRecords` — that timestamp is already occupied by
 * `SubscriptionInvoiceWebhookDedup1730068000000` (verified live against the
 * migrations directory). Renumbered to the next free slot past every
 * migration that actually exists on disk.
 */
export class ClinicalRecords1730076000000 implements MigrationInterface {
  name = 'ClinicalRecords1730076000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── clinical_encounters ────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "clinical_encounters" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "appointmentId" uuid,
        "branchId" uuid,
        "authorId" uuid NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "summary" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_clinical_encounters" PRIMARY KEY ("id"),
        CONSTRAINT "FK_clinical_encounters_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_clinical_encounters_customer" FOREIGN KEY ("customerId")
          REFERENCES "customers" ("id"),
        CONSTRAINT "FK_clinical_encounters_appointment" FOREIGN KEY ("appointmentId")
          REFERENCES "appointments" ("id"),
        CONSTRAINT "FK_clinical_encounters_branch" FOREIGN KEY ("branchId")
          REFERENCES "branches" ("id"),
        CONSTRAINT "FK_clinical_encounters_author" FOREIGN KEY ("authorId")
          REFERENCES "users" ("id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_clinical_encounters_timeline" ON "clinical_encounters" ("tenantId", "customerId")`,
    );
    await q.query(
      `CREATE INDEX "IDX_clinical_encounters_appointment" ON "clinical_encounters" ("tenantId", "appointmentId")`,
    );

    // ── clinical_entries ────────────────────────────────────────────────
    await q.query(
      `CREATE TYPE "public"."clinical_entries_kind_enum" AS ENUM('NOTE', 'DIAGNOSIS', 'MEDICATION', 'ALLERGY', 'VITALS')`,
    );
    await q.query(`
      CREATE TABLE "clinical_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "encounterId" uuid,
        "kind" "public"."clinical_entries_kind_enum" NOT NULL,
        "data" jsonb NOT NULL,
        "recorded_at" timestamptz NOT NULL,
        "authorId" uuid NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "PK_clinical_entries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_clinical_entries_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_clinical_entries_customer" FOREIGN KEY ("customerId")
          REFERENCES "customers" ("id"),
        CONSTRAINT "FK_clinical_entries_encounter" FOREIGN KEY ("encounterId")
          REFERENCES "clinical_encounters" ("id"),
        CONSTRAINT "FK_clinical_entries_author" FOREIGN KEY ("authorId")
          REFERENCES "users" ("id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_clinical_entries_timeline" ON "clinical_entries" ("tenantId", "customerId", "recorded_at")`,
    );
    await q.query(
      `CREATE INDEX "IDX_clinical_entries_kind" ON "clinical_entries" ("tenantId", "customerId", "kind")`,
    );
    await q.query(
      `CREATE INDEX "IDX_clinical_entries_encounter" ON "clinical_entries" ("tenantId", "encounterId")`,
    );

    // ── clinical_entry_revisions (append-only) ──────────────────────────
    await q.query(`
      CREATE TABLE "clinical_entry_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "entryId" uuid NOT NULL,
        "previous_data" jsonb NOT NULL,
        "changed_byId" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_clinical_entry_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_clinical_entry_revisions_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_clinical_entry_revisions_entry" FOREIGN KEY ("entryId")
          REFERENCES "clinical_entries" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_clinical_entry_revisions_changed_by" FOREIGN KEY ("changed_byId")
          REFERENCES "users" ("id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_clinical_entry_revisions_entry" ON "clinical_entry_revisions" ("entryId", "created_at")`,
    );

    // ── clinical_access_logs (append-only) ──────────────────────────────
    await q.query(`
      CREATE TABLE "clinical_access_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "scope" varchar(40) NOT NULL,
        "entryId" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_clinical_access_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_clinical_access_logs_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_clinical_access_logs_customer" FOREIGN KEY ("customerId")
          REFERENCES "customers" ("id"),
        CONSTRAINT "FK_clinical_access_logs_user" FOREIGN KEY ("userId")
          REFERENCES "users" ("id"),
        CONSTRAINT "FK_clinical_access_logs_entry" FOREIGN KEY ("entryId")
          REFERENCES "clinical_entries" ("id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_clinical_access_logs_customer" ON "clinical_access_logs" ("tenantId", "customerId", "created_at")`,
    );
  }

  /** Drops all four tables (children first) and the enum type. Fully reversible — no existing data is touched. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "clinical_access_logs"`);
    await q.query(`DROP TABLE IF EXISTS "clinical_entry_revisions"`);
    await q.query(`DROP TABLE IF EXISTS "clinical_entries"`);
    await q.query(`DROP TYPE IF EXISTS "public"."clinical_entries_kind_enum"`);
    await q.query(`DROP TABLE IF EXISTS "clinical_encounters"`);
  }
}
