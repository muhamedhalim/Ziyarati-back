import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Residency plan P11 / P13: the two tables that hold the ACCOUNTABILITY record
 * of data-subject handling.
 *
 *  data_subject_requests — a request a clinic received (export / correction /
 *                          deletion / restriction), who handled it, when, outcome.
 *  deletion_evidence     — append-only proof of what a deletion touched.
 *
 * ADDITIVE ONLY: two new tables, nothing existing is altered.
 *
 * NO FOREIGN KEYS, on purpose. Both rows must outlive the tenant and the subject
 * they describe; a FK to `tenants` / `customers` would either block offboarding
 * or cascade the proof away with the data it proves was deleted. Neither table
 * holds personal data — ids, enums, timestamps, counts.
 *
 * Every object is ALSO declared on its entity under the same names, so a schema
 * built from metadata carries it and `synchronize` does not drop it.
 *
 * REVERSIBLE.
 */
export class DataGovernance1730111000000 implements MigrationInterface {
  name = 'DataGovernance1730111000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS "data_subject_requests" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "tenant_id" uuid NOT NULL,
         "customer_id" uuid NOT NULL,
         "type" varchar(20) NOT NULL,
         "status" varchar(20) NOT NULL DEFAULT 'RECEIVED',
         "channel" varchar(30) NOT NULL,
         "received_at" timestamptz NOT NULL DEFAULT now(),
         "due_at" timestamptz,
         "completed_at" timestamptz,
         "requested_by_user_id" uuid,
         "handled_by_user_id" uuid,
         "note" varchar(500),
         "outcome" jsonb,
         "evidence_id" uuid,
         "created_at" timestamp NOT NULL DEFAULT now(),
         CONSTRAINT "PK_data_subject_requests" PRIMARY KEY ("id")
       )`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dsr_tenant_received"
         ON "data_subject_requests" ("tenant_id", "received_at")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dsr_tenant_customer"
         ON "data_subject_requests" ("tenant_id", "customer_id")`,
    );

    await q.query(
      `CREATE TABLE IF NOT EXISTS "deletion_evidence" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "scope" varchar(20) NOT NULL,
         "tenant_id" uuid NOT NULL,
         "subject_id" uuid,
         "request_id" uuid,
         "performed_by_user_id" uuid,
         "status" varchar(20) NOT NULL,
         "report" jsonb NOT NULL,
         "started_at" timestamptz NOT NULL,
         "completed_at" timestamptz NOT NULL,
         "created_at" timestamp NOT NULL DEFAULT now(),
         CONSTRAINT "PK_deletion_evidence" PRIMARY KEY ("id")
       )`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_deletion_evidence_tenant_created"
         ON "deletion_evidence" ("tenant_id", "created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_deletion_evidence_tenant_created"`,
    );
    await q.query(`DROP TABLE IF EXISTS "deletion_evidence"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_dsr_tenant_customer"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_dsr_tenant_received"`);
    await q.query(`DROP TABLE IF EXISTS "data_subject_requests"`);
  }
}
