import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `subscription_plans.max_uploaded_files` / `max_training_files` widen from
 * `integer` to `bigint`, matching `max_storage_bytes`'s existing type
 * exactly. Both columns are changing meaning from "max file COUNT" to "max
 * bytes uploaded" (Pricing Catalog: Upload Files / AI Training Files become
 * byte-priced, sold per GB via `sellable-resource.registry.ts`'s new
 * `unitSize` for these two items) — a plain 32-bit `integer` tops out around
 * 2.1 GB when denominated in bytes, nowhere near enough headroom for a real
 * storage cap.
 *
 * Postgres widens `integer` → `bigint` in place (implicit cast, no `USING`
 * clause needed, no data loss). Every plan row currently has both columns
 * NULL (verified in dev), so this is a pure type change with nothing to
 * convert.
 */
export class SubscriptionPlanFileLimitsBigint1730051000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "subscription_plans" ALTER COLUMN "max_uploaded_files" TYPE bigint`,
    );
    await q.query(
      `ALTER TABLE "subscription_plans" ALTER COLUMN "max_training_files" TYPE bigint`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "subscription_plans" ALTER COLUMN "max_uploaded_files" TYPE integer`,
    );
    await q.query(
      `ALTER TABLE "subscription_plans" ALTER COLUMN "max_training_files" TYPE integer`,
    );
  }
}
