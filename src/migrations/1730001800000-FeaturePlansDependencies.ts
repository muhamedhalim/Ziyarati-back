import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feature-management upgrade: plan restrictions, dependency graph, and richer
 * catalog metadata (visibility/beta/deprecated + usage-metric link). Plan limits
 * and usage themselves are NOT stored here — they stay in `subscription_plans` /
 * `subscription_usage` (the Subscription Module remains the source of truth).
 */
export class FeaturePlansDependencies1730001800000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "feature_definitions"
        ADD COLUMN IF NOT EXISTS "visibility" character varying NOT NULL DEFAULT 'public',
        ADD COLUMN IF NOT EXISTS "is_beta" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "is_deprecated" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "usage_metric" character varying
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "feature_plans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "feature_key" character varying NOT NULL,
        "plan_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feature_plans" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_feature_plans_key_plan" UNIQUE ("feature_key", "plan_id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_feature_plans_key" ON "feature_plans" ("feature_key")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "feature_dependencies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "feature_key" character varying NOT NULL,
        "requires_key" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feature_dependencies" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_feature_deps_key_req" UNIQUE ("feature_key", "requires_key")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_feature_deps_key" ON "feature_dependencies" ("feature_key")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "feature_dependencies"`);
    await q.query(`DROP TABLE IF EXISTS "feature_plans"`);
    await q.query(`
      ALTER TABLE "feature_definitions"
        DROP COLUMN IF EXISTS "usage_metric",
        DROP COLUMN IF EXISTS "is_deprecated",
        DROP COLUMN IF EXISTS "is_beta",
        DROP COLUMN IF EXISTS "visibility"
    `);
  }
}
