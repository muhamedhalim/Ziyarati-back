import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 14 (US10, T168,
 * data-model.md §1.10). Creates `queue_entries` — the branch's live,
 * per-day walk-in/check-in queue.
 *
 * Renumbered from the task's suggested `1730073000000`: by the time this
 * migration was written, concurrent work on other phases of this same spec
 * had already filled the sequence up to `1730079000000`
 * (`EmailSuppressionAndCampaignChannel`). Following this repo's own
 * precedent for a renumbered slot (see `WaitlistEntriesAndOffers
 * 1730078000000`'s docblock and, before it, `AuthTokenIndexes1730057100000`'s),
 * this migration takes the next free integer above whatever was actually on
 * disk at write time rather than the number the design doc guessed.
 *
 * FR-Q005's "checking in the same appointment twice must not create a second
 * queue entry" is the `UQ_queue_entries_appointment_live` partial unique
 * index — a DATABASE constraint, not an application pre-check, so a race
 * between two concurrent check-ins for the same appointment is closed at the
 * database rather than merely discouraged in application code.
 *
 * Brand new table with no existing data, so this is a plain (non-
 * `CONCURRENTLY`) build — no production write path is blocked by locking a
 * table that does not yet exist.
 */
export class QueueEntries1730080000000 implements MigrationInterface {
  name = 'QueueEntries1730080000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "queue_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "branchId" uuid NOT NULL,
        "appointmentId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "staffId" uuid,
        "business_date" date NOT NULL,
        "state" varchar(20) NOT NULL DEFAULT 'WAITING',
        "arrived_at" timestamptz NOT NULL,
        "called_at" timestamptz,
        "started_at" timestamptz,
        "ended_at" timestamptz,
        "called_byId" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_queue_entries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_queue_entries_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_queue_entries_branch" FOREIGN KEY ("branchId")
          REFERENCES "branches" ("id"),
        CONSTRAINT "FK_queue_entries_appointment" FOREIGN KEY ("appointmentId")
          REFERENCES "appointments" ("id"),
        CONSTRAINT "FK_queue_entries_customer" FOREIGN KEY ("customerId")
          REFERENCES "customers" ("id"),
        CONSTRAINT "FK_queue_entries_staff" FOREIGN KEY ("staffId")
          REFERENCES "staff_profiles" ("id"),
        CONSTRAINT "FK_queue_entries_called_by" FOREIGN KEY ("called_byId")
          REFERENCES "users" ("id")
      )
    `);

    // The live query — a branch's queue board for one business day.
    await q.query(
      `CREATE INDEX "IDX_queue_entries_live" ON "queue_entries" ("tenantId", "branchId", "business_date", "state")`,
    );
    // Practitioner view — one staff member's own patients for the day.
    await q.query(
      `CREATE INDEX "IDX_queue_entries_staff" ON "queue_entries" ("tenantId", "branchId", "business_date", "staffId")`,
    );
    // FR-Q005 — at most one LIVE (not COMPLETED/CANCELLED/NO_SHOW) queue
    // entry per appointment. Refused by the database, not by an application
    // pre-check that would race.
    await q.query(`
      CREATE UNIQUE INDEX "UQ_queue_entries_appointment_live"
      ON "queue_entries" ("tenantId", "appointmentId")
      WHERE "state" NOT IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "queue_entries"`);
  }
}
