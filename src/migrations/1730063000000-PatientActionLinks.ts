import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — S1. Creates `patient_action_links`,
 * the single credential mechanism for every patient self-service action. See
 * `PatientActionLink` entity for field-level docs and
 * `PatientActionLinkService` (T009) for issue/resolve/consume semantics.
 *
 * A brand-new table with no existing data, so this is a plain (non-
 * CONCURRENTLY) build — no production write path is blocked by locking a
 * table that does not yet exist.
 *
 * `waitlist_offer` has NO foreign key here: `waitlist_offers` does not exist
 * until T156 (Phase 13), which ALTERs this table to add the constraint once
 * its target exists.
 */
export class PatientActionLinks1730063000000 implements MigrationInterface {
  name = 'PatientActionLinks1730063000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "patient_action_links" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "appointmentId" uuid NOT NULL,
        "purpose" varchar(20) NOT NULL,
        "token_digest" varchar(64) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz,
        "waitlist_offer" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patient_action_links" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patient_action_links_token_digest" UNIQUE ("token_digest"),
        CONSTRAINT "patient_action_links_waitlist_offer_required" CHECK
          ("purpose" <> 'WAITLIST_OFFER' OR "waitlist_offer" IS NOT NULL),
        CONSTRAINT "FK_patient_action_links_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants" ("id"),
        CONSTRAINT "FK_patient_action_links_appointment" FOREIGN KEY ("appointmentId")
          REFERENCES "appointments" ("id") ON DELETE CASCADE
      )
    `);

    await q.query(
      `CREATE INDEX "IDX_patient_action_links_appointment_purpose" ON "patient_action_links" ("appointmentId", "purpose")`,
    );
    await q.query(
      `CREATE INDEX "IDX_patient_action_links_expires_at" ON "patient_action_links" ("expires_at")`,
    );
    await q.query(
      `CREATE INDEX "IDX_patient_action_links_tenant" ON "patient_action_links" ("tenantId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "patient_action_links"`);
  }
}
