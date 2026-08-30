import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 10 (US8, T120).
 *
 * New `customer_segments` table (reusable rule-based audiences), a nullable
 * `campaigns.segment_id` FK (the legacy `campaigns.segment` jsonb is
 * retained, unread — see the entity's own docblock), and three indexes that
 * make every `SegmentField` condition index-servable:
 *  - `appointment_services (tenantId, serviceId)` — SERVICE_BOOKED
 *  - `customers (tenantId, created_at)` — CUSTOMER_CREATED_AT, and a useful
 *    prefix for the LAST_APPOINTMENT_AT/APPOINTMENT_COUNT subqueries' outer
 *    tenant scope
 *  - a birthday expression index on `customers (tenantId, DATE_PART('doy', date_of_birth))`
 *    — BIRTH_DATE_IN_PERIOD
 *
 * All three built `CONCURRENTLY` (`transaction = false`, mirrors
 * `AuditLogIndexes1730062000000`) — `customers`/`appointment_services` are
 * hot tables; a locking build would stall booking and CRM reads.
 */
export class CustomerSegments1730071000000 implements MigrationInterface {
  name = 'CustomerSegments1730071000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "customer_segments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(160) NOT NULL,
        "description" varchar(500),
        "rules" jsonb NOT NULL,
        "match" varchar(3) NOT NULL,
        "created_byId" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "PK_customer_segments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_customer_segments_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_customer_segments_created_by" FOREIGN KEY ("created_byId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_customer_segments_tenant_name_live"
      ON "customer_segments" ("tenantId", "name")
      WHERE "deleted_at" IS NULL
    `);

    await q.query(`ALTER TABLE "campaigns" ADD COLUMN "segment_id" uuid`);
    await q.query(
      `ALTER TABLE "campaigns" ADD CONSTRAINT "FK_campaigns_segment" FOREIGN KEY ("segment_id") REFERENCES "customer_segments"("id") ON DELETE SET NULL`,
    );

    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_appointment_services_tenant_service" ON "appointment_services" ("tenantId", "serviceId")`,
    );
    await this.assertValid(q, 'IDX_appointment_services_tenant_service');

    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_customers_tenant_created" ON "customers" ("tenantId", "created_at")`,
    );
    await this.assertValid(q, 'IDX_customers_tenant_created');

    await q.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_customers_tenant_birthday"
      ON "customers" ("tenantId", (DATE_PART('doy', "date_of_birth"::date)))
      WHERE "date_of_birth" IS NOT NULL
    `);
    await this.assertValid(q, 'IDX_customers_tenant_birthday');
  }

  private async assertValid(q: QueryRunner, indexName: string): Promise<void> {
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${indexName}"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        `CustomerSegments: "${indexName}" was created but is NOT valid — a CONCURRENTLY build ` +
          'failed partway. Investigate, drop the invalid index, and re-run this migration.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_customers_tenant_birthday"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_customers_tenant_created"`);
    await q.query(
      `DROP INDEX IF EXISTS "IDX_appointment_services_tenant_service"`,
    );
    await q.query(
      `ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "FK_campaigns_segment"`,
    );
    await q.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "segment_id"`);
    await q.query(`DROP TABLE IF EXISTS "customer_segments"`);
  }
}
