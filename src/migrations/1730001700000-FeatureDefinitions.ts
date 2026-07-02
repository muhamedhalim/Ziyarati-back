import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feature catalog table backing the super-admin Feature Flags manager. The
 * per-tenant `feature_flags` override table is unchanged; this stores the global
 * definition (name/description/category/default) so features are DB-driven and
 * unbounded rather than hardcoded.
 */
export class FeatureDefinitions1730001700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "feature_definitions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "feature_key" character varying NOT NULL,
        "name" character varying NOT NULL,
        "description" text,
        "category" character varying NOT NULL DEFAULT 'General',
        "default_enabled" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feature_definitions" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feature_definitions_key" ON "feature_definitions" ("feature_key")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "feature_definitions"`);
  }
}
