import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `national_id` to `customers` — an optional client ID/identity number
 * captured directly in the New/Edit Customer form (CRM). Nullable: not every
 * clinic collects it. When a value IS provided it must be unique per tenant,
 * enforced with a PARTIAL unique index (`WHERE national_id IS NOT NULL`) —
 * mirrors the tenant-scoped uniqueness already proven on this table
 * (`CustomerTenantScopedEmail1730019000000`) without forcing every customer
 * to have a value.
 *
 * Brand-new nullable column with no existing data to violate the new
 * constraint, so (unlike the email migration) a plain in-transaction
 * `CREATE UNIQUE INDEX` is safe here — no `CONCURRENTLY` dance needed.
 */
export class CustomerNationalId1730053000000 implements MigrationInterface {
  name = 'CustomerNationalId1730053000000';

  public async up(q: QueryRunner): Promise<void> {
    // IF NOT EXISTS guards: a dev environment running with
    // TYPEORM_SYNCHRONIZE=true can have already created this column/index
    // from the entity definition before this migration ever ran.
    await q.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "national_id" character varying(50)`,
    );
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE tablename = 'customers'
            AND indexdef ILIKE '%UNIQUE%'
            AND indexdef ILIKE '%"tenantId"%'
            AND indexdef ILIKE '%national_id%'
        ) THEN
          CREATE UNIQUE INDEX "UQ_customers_tenant_national_id" ON "customers" ("tenantId", "national_id") WHERE "national_id" IS NOT NULL;
        END IF;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_customers_tenant_national_id"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN "national_id"`);
  }
}
