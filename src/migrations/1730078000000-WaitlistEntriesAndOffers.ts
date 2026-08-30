import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 13 (US9, data-model.md §1.8,
 * §1.9, §3 row 11). Creates `waitlist_entries` and `waitlist_offers`, then
 * ALTERs `patient_action_links` to add the FK its `waitlist_offer` column
 * has always declared but could never enforce until this table existed (see
 * `PatientActionLink`'s own docblock and migration
 * `PatientActionLinks1730063000000`).
 *
 * Renumbered from data-model.md's suggested `1730072000000`: by the time
 * this migration was written, concurrent work on other phases of this same
 * spec had already filled the sequence up to `1730077000000`
 * (`ClinicalPermissionsAndRoles`). Following this repo's own precedent for a
 * renumbered slot (see `AuthTokenIndexes1730057100000`'s docblock), this
 * migration takes the next free integer above whatever was actually on disk
 * at write time rather than the number the design doc guessed.
 *
 * Both tables are brand new with no existing data, so this is a plain
 * (non-`CONCURRENTLY`) build — no production write path is blocked by
 * locking a table that does not yet exist. The two partial unique indexes
 * (FR-W013's duplicate-entry refusal, and one-live-offer-per-slot-per-entry)
 * are DATABASE constraints, not application pre-checks, so a race between
 * two concurrent creates is closed at the database, not merely discouraged
 * in application code.
 */
export class WaitlistEntriesAndOffers1730078000000 implements MigrationInterface {
  name = 'WaitlistEntriesAndOffers1730078000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "waitlist_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "serviceId" uuid NOT NULL,
        "preferredStaffId" uuid,
        "preferredBranchId" uuid,
        "window_start" timestamptz,
        "window_end" timestamptz,
        "priority" integer NOT NULL DEFAULT 0,
        "state" varchar(20) NOT NULL DEFAULT 'WAITING',
        "expires_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_waitlist_entries" PRIMARY KEY ("id"),
        CONSTRAINT "waitlist_entries_window_order" CHECK
          ("window_end" IS NULL OR "window_start" IS NULL OR "window_end" > "window_start"),
        CONSTRAINT "FK_waitlist_entries_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_waitlist_entries_customer" FOREIGN KEY ("customerId")
          REFERENCES "customers" ("id"),
        CONSTRAINT "FK_waitlist_entries_service" FOREIGN KEY ("serviceId")
          REFERENCES "services" ("id"),
        CONSTRAINT "FK_waitlist_entries_preferred_staff" FOREIGN KEY ("preferredStaffId")
          REFERENCES "staff_profiles" ("id"),
        CONSTRAINT "FK_waitlist_entries_preferred_branch" FOREIGN KEY ("preferredBranchId")
          REFERENCES "branches" ("id")
      )
    `);

    await q.query(
      `CREATE INDEX "IDX_waitlist_entries_match" ON "waitlist_entries" ("tenantId", "serviceId", "state")`,
    );
    await q.query(
      `CREATE INDEX "IDX_waitlist_entries_expiry" ON "waitlist_entries" ("tenantId", "state", "expires_at")`,
    );
    await q.query(
      `CREATE INDEX "IDX_waitlist_entries_dup_lookup" ON "waitlist_entries" ("tenantId", "customerId", "serviceId", "state")`,
    );
    // FR-W013 — a patient may hold at most one ACTIVE (WAITING or OFFERED)
    // entry per (tenant, customer, service). Refused by the database, not by
    // an application pre-check that would race.
    await q.query(`
      CREATE UNIQUE INDEX "UQ_waitlist_entries_active_dup"
      ON "waitlist_entries" ("tenantId", "customerId", "serviceId")
      WHERE "state" IN ('WAITING', 'OFFERED')
    `);

    await q.query(`
      CREATE TABLE "waitlist_offers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "entryId" uuid NOT NULL,
        "branchId" uuid NOT NULL,
        "staffId" uuid NOT NULL,
        "start_at" timestamptz NOT NULL,
        "end_at" timestamptz NOT NULL,
        "state" varchar(20) NOT NULL DEFAULT 'PENDING',
        "responds_by" timestamptz NOT NULL,
        "appointmentId" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_waitlist_offers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_waitlist_offers_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_waitlist_offers_entry" FOREIGN KEY ("entryId")
          REFERENCES "waitlist_entries" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_waitlist_offers_branch" FOREIGN KEY ("branchId")
          REFERENCES "branches" ("id"),
        CONSTRAINT "FK_waitlist_offers_staff" FOREIGN KEY ("staffId")
          REFERENCES "staff_profiles" ("id"),
        CONSTRAINT "FK_waitlist_offers_appointment" FOREIGN KEY ("appointmentId")
          REFERENCES "appointments" ("id")
      )
    `);

    await q.query(
      `CREATE INDEX "IDX_waitlist_offers_expiry" ON "waitlist_offers" ("tenantId", "state", "responds_by")`,
    );
    await q.query(
      `CREATE INDEX "IDX_waitlist_offers_entry_state" ON "waitlist_offers" ("entryId", "state")`,
    );
    // One LIVE (PENDING) offer per (entry, slot) — does not prevent the same
    // slot being offered to several different entries at once (T157's
    // bounded top-N matching); accepting one withdraws every sibling
    // (FR-W012).
    await q.query(`
      CREATE UNIQUE INDEX "UQ_waitlist_offers_entry_pending_slot"
      ON "waitlist_offers" ("entryId", "start_at")
      WHERE "state" = 'PENDING'
    `);

    // Completes the FK `PatientActionLink` has declared (column-only) since
    // migration `PatientActionLinks1730063000000` — its target now exists.
    await q.query(`
      ALTER TABLE "patient_action_links"
      ADD CONSTRAINT "FK_patient_action_links_waitlist_offer"
      FOREIGN KEY ("waitlist_offer") REFERENCES "waitlist_offers" ("id")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "patient_action_links" DROP CONSTRAINT IF EXISTS "FK_patient_action_links_waitlist_offer"`,
    );
    await q.query(`DROP TABLE IF EXISTS "waitlist_offers"`);
    await q.query(`DROP TABLE IF EXISTS "waitlist_entries"`);
  }
}
