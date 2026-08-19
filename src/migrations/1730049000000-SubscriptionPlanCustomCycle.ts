import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a duration to the CUSTOM billing cycle. Until now `BillingCycle.CUSTOM`
 * carried no interval at all — `SubscriptionService.computeEnds` silently
 * treated it as monthly. This adds the two columns an admin needs to express
 * "every N days/months/years": `custom_cycle_value` (the N) and
 * `custom_cycle_unit` (DAY/MONTH/YEAR). Both nullable — only meaningful when
 * `billing_cycle = 'CUSTOM'`.
 */
export class SubscriptionPlanCustomCycle1730049000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."subscription_plans_custom_cycle_unit_enum" AS ENUM('DAY', 'MONTH', 'YEAR');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await q.query(`
      ALTER TABLE "subscription_plans"
      ADD COLUMN IF NOT EXISTS "custom_cycle_value" integer
    `);
    await q.query(`
      ALTER TABLE "subscription_plans"
      ADD COLUMN IF NOT EXISTS "custom_cycle_unit" "public"."subscription_plans_custom_cycle_unit_enum"
    `);
    await q.query(`
      ALTER TABLE "subscription_plans"
      ADD CONSTRAINT "CHK_subscription_plans_custom_cycle_value_positive"
      CHECK ("custom_cycle_value" IS NULL OR "custom_cycle_value" > 0)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "subscription_plans"
      DROP CONSTRAINT IF EXISTS "CHK_subscription_plans_custom_cycle_value_positive"
    `);
    await q.query(`
      ALTER TABLE "subscription_plans"
      DROP COLUMN IF EXISTS "custom_cycle_unit"
    `);
    await q.query(`
      ALTER TABLE "subscription_plans"
      DROP COLUMN IF EXISTS "custom_cycle_value"
    `);
    await q.query(`
      DROP TYPE IF EXISTS "public"."subscription_plans_custom_cycle_unit_enum"
    `);
  }
}
