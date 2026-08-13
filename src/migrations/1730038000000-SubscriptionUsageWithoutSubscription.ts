import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets usage be RECORDED for a tenant that has no subscription.
 *
 * A clinic running on a super-admin feature grant has no plan, so there is no
 * limit to enforce — but "no limit" is not the same as "no visibility". Until
 * now `subscription_usage.subscription_id` was NOT NULL, so those tenants
 * produced no rows at all and the platform was blind to what they consumed:
 * no way to size a plan for them, spot abuse, or bill retroactively.
 *
 * The alternative would have been to mint a placeholder subscription, which is
 * exactly the "fake subscription" this design refuses — it would make every
 * downstream question ("is this tenant paying?") answer wrongly.
 *
 * Uniqueness: the existing `(subscription_id, period_month)` constraint still
 * governs subscribed tenants. Postgres treats NULLs as distinct in a unique
 * index, so it would happily allow many rows per tenant-month once the column
 * is nullable; the partial index below restores exactly one row per
 * tenant-month for the subscription-less case, which is what makes the
 * idempotent `ON CONFLICT DO NOTHING` upsert safe on that path too.
 */
export class SubscriptionUsageWithoutSubscription1730038000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "subscription_usage" ALTER COLUMN "subscription_id" DROP NOT NULL`,
    );
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subscription_usage_tenant_period_unsubscribed"
        ON "subscription_usage" ("tenant_id", "period_month")
        WHERE "subscription_id" IS NULL
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_subscription_usage_tenant_period" ON "subscription_usage" ("tenant_id", "period_month")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_subscription_usage_tenant_period"`,
    );
    await q.query(
      `DROP INDEX IF EXISTS "UQ_subscription_usage_tenant_period_unsubscribed"`,
    );
    // Rows recorded for subscription-less tenants have no subscription to
    // point at, so restoring NOT NULL requires removing them.
    await q.query(
      `DELETE FROM "subscription_usage" WHERE "subscription_id" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "subscription_usage" ALTER COLUMN "subscription_id" SET NOT NULL`,
    );
  }
}
