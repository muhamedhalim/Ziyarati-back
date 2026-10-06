import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `customers.email` becomes optional.
 *
 * Safe: `DROP NOT NULL` is a metadata-only change (no rewrite, brief lock) and
 * existing rows/indexes are untouched. The tenant-scoped partial unique index
 * `UQ_customers_tenant_email` keeps enforcing uniqueness for non-NULL values;
 * Postgres treats NULLs as distinct, so multiple email-less customers are fine.
 *
 * down(): re-adding NOT NULL fails if NULLs exist, so refuse with a clear
 * message instead of inventing placeholder addresses.
 */
export class CustomerEmailNullable1730112000000 implements MigrationInterface {
  name = 'CustomerEmailNullable1730112000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "customers" ALTER COLUMN "email" DROP NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    const [{ count }]: { count: string }[] = await q.query(
      `SELECT count(*)::text AS count FROM "customers" WHERE "email" IS NULL`,
    );
    if (Number(count) > 0) {
      throw new Error(
        `CustomerEmailNullable rollback refused: ${count} customer(s) have no email — ` +
          'restoring NOT NULL would fail. Backfill or remove them manually first.',
      );
    }
    await q.query(`ALTER TABLE "customers" ALTER COLUMN "email" SET NOT NULL`);
  }
}
