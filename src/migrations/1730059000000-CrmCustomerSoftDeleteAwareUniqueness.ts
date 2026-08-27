import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CRM customer identity model fix, requested against three defects found in
 * the New/Edit Customer flow:
 *
 *  1. `phone` uniqueness is REMOVED. Multiple customers may legitimately
 *     share a phone number (a shared household line, a walk-in without their
 *     own number) — `national_id` is the intended sole hard identity key
 *     (CustomerNationalId1730053000000), and `email` is required anyway. The
 *     old unique index (`IDX_4c0d50bb04cf7976e922b5781d`) is replaced with a
 *     plain (non-unique) index so `(tenantId, phone)` lookups (search,
 *     `CustomerService.findOrCreateForBooking`) stay index-backed.
 *
 *  2. `email` and `national_id` uniqueness is now scoped to LIVE rows only
 *     (`WHERE "deleted_at" IS NULL`). Before this, soft-deleting a customer
 *     (`CustomerService.remove`, `DeleteDateColumn`) left their email/
 *     national_id permanently reserved — re-creating a customer with the
 *     same details after a delete was rejected as a duplicate, which
 *     contradicts what "delete" is supposed to mean. `phone` never had this
 *     problem in practice (see #1), but email/national_id did.
 *
 * `UQ_customers_tenant_email` and `UQ_customers_tenant_national_id` KEEP
 * their existing names — only their definition (the added `deleted_at IS
 * NULL` predicate) changes, via build-under-a-temp-name-then-rename, so
 * every existing reference to those names (typeorm-error.mapper.ts's
 * CONSTRAINT_MESSAGES, scripts/verify-migrations.ts) keeps working unchanged.
 *
 * Production-safety shape mirrors CustomerTenantScopedEmail1730019000000:
 * CONCURRENTLY builds (no long-held lock on a possibly large `customers`
 * table), each new index's validity verified before the corresponding old
 * one is dropped, `transaction = false` because `CREATE INDEX CONCURRENTLY`
 * cannot run inside a transaction block. `ALTER INDEX ... RENAME TO` is a
 * fast catalog-only rename (no table lock, no CONCURRENTLY needed).
 */
export class CrmCustomerSoftDeleteAwareUniqueness1730059000000
  implements MigrationInterface
{
  name = 'CrmCustomerSoftDeleteAwareUniqueness1730059000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    // ---- 1. phone: unique -> plain lookup index ---------------------------
    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_customers_tenant_phone" ON "customers" ("tenantId", "phone")`,
    );
    await q.query(
      `DROP INDEX IF EXISTS "IDX_4c0d50bb04cf7976e922b5781d"`,
    );

    // ---- 2. email: unique -> unique WHERE deleted_at IS NULL --------------
    await q.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_customers_tenant_email_new"
      ON "customers" ("tenantId", "email")
      WHERE "deleted_at" IS NULL
    `);
    await this.assertValid(q, 'UQ_customers_tenant_email_new');
    await q.query(`DROP INDEX IF EXISTS "UQ_customers_tenant_email"`);
    // Belt-and-braces: drop the pre-M-01 global constraint too, in case this
    // runs against an environment that somehow skipped that migration.
    await q.query(
      `ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "UQ_8536b8b85c06969f84f0c098b03"`,
    );
    await q.query(
      `ALTER INDEX "UQ_customers_tenant_email_new" RENAME TO "UQ_customers_tenant_email"`,
    );

    // ---- 3. national_id: partial unique -> also scoped to live rows -------
    await q.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_customers_tenant_national_id_new"
      ON "customers" ("tenantId", "national_id")
      WHERE "national_id" IS NOT NULL AND "deleted_at" IS NULL
    `);
    await this.assertValid(q, 'UQ_customers_tenant_national_id_new');
    await q.query(`DROP INDEX IF EXISTS "UQ_customers_tenant_national_id"`);
    await q.query(
      `ALTER INDEX "UQ_customers_tenant_national_id_new" RENAME TO "UQ_customers_tenant_national_id"`,
    );
  }

  /**
   * A `CONCURRENTLY` build that fails partway (e.g. a duplicate found
   * mid-build, or the connection dropped) leaves an INVALID index behind
   * that silently enforces nothing — never assume success, confirm it
   * (same check as CustomerTenantScopedEmail1730019000000).
   */
  private async assertValid(q: QueryRunner, indexName: string): Promise<void> {
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${indexName}"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        `CrmCustomerSoftDeleteAwareUniqueness: "${indexName}" was created but is NOT valid — a ` +
          'CONCURRENTLY build failed partway (likely a pre-existing duplicate among LIVE rows). ' +
          'Investigate, drop the invalid index, resolve the underlying data, and re-run this migration.',
      );
    }
  }

  /**
   * ASYMMETRIC ROLLBACK — NOT fully reversible in general, and never
   * described as such (same shape as CustomerTenantScopedEmail's `down`).
   * Restoring `UNIQUE (tenantId, phone)` fails outright once two live
   * customers in the same tenant share a phone — exactly what this
   * migration exists to allow. Restoring the non-partial email/national_id
   * uniqueness fails if a soft-deleted row's email/national_id has since
   * been reused by a live row. Rather than fail opaquely mid-migration,
   * this pre-checks each and reports conflicts.
   */
  public async down(q: QueryRunner): Promise<void> {
    const duplicatePhones: { tenantId: string; phone: string; rows: string }[] =
      await q.query(`
        SELECT "tenantId", phone, count(*)::text AS rows
        FROM "customers"
        WHERE "deleted_at" IS NULL
        GROUP BY "tenantId", phone
        HAVING count(*) > 1
        LIMIT 50
      `);
    if (duplicatePhones.length > 0) {
      throw new Error(
        `CrmCustomerSoftDeleteAwareUniqueness rollback refused: ${duplicatePhones.length} ` +
          `tenant/phone pair(s) now have multiple live customers (e.g. tenant ` +
          `"${duplicatePhones[0].tenantId}", phone "${duplicatePhones[0].phone}" × ` +
          `${duplicatePhones[0].rows} rows) — restoring UNIQUE (tenantId, phone) would fail. ` +
          'Resolve the conflicting rows manually before retrying.',
      );
    }

    const duplicateEmails: { tenantId: string; email: string; rows: string }[] =
      await q.query(`
        SELECT "tenantId", email, count(*)::text AS rows
        FROM "customers"
        GROUP BY "tenantId", email
        HAVING count(*) > 1
        LIMIT 50
      `);
    if (duplicateEmails.length > 0) {
      throw new Error(
        `CrmCustomerSoftDeleteAwareUniqueness rollback refused: ${duplicateEmails.length} ` +
          `tenant/email pair(s) (including soft-deleted rows) now collide — restoring the ` +
          'non-partial UNIQUE (tenantId, email) would fail. Resolve manually before retrying.',
      );
    }

    const duplicateNationalIds: {
      tenantId: string;
      national_id: string;
      rows: string;
    }[] = await q.query(`
      SELECT "tenantId", national_id, count(*)::text AS rows
      FROM "customers"
      WHERE national_id IS NOT NULL
      GROUP BY "tenantId", national_id
      HAVING count(*) > 1
      LIMIT 50
    `);
    if (duplicateNationalIds.length > 0) {
      throw new Error(
        `CrmCustomerSoftDeleteAwareUniqueness rollback refused: ${duplicateNationalIds.length} ` +
          'tenant/national_id pair(s) (including soft-deleted rows) now collide — restoring the ' +
          'non-partial national_id unique index would fail. Resolve manually before retrying.',
      );
    }

    await q.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "IDX_4c0d50bb04cf7976e922b5781d" ON "customers" ("tenantId", "phone")`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_customers_tenant_phone"`);

    await q.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_customers_tenant_email_old" ON "customers" ("tenantId", "email")`,
    );
    await q.query(`DROP INDEX IF EXISTS "UQ_customers_tenant_email"`);
    await q.query(
      `ALTER INDEX "UQ_customers_tenant_email_old" RENAME TO "UQ_customers_tenant_email"`,
    );

    await q.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_customers_tenant_national_id_old"
      ON "customers" ("tenantId", "national_id") WHERE "national_id" IS NOT NULL
    `);
    await q.query(`DROP INDEX IF EXISTS "UQ_customers_tenant_national_id"`);
    await q.query(
      `ALTER INDEX "UQ_customers_tenant_national_id_old" RENAME TO "UQ_customers_tenant_national_id"`,
    );
  }
}
