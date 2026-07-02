import { MigrationInterface, QueryRunner } from 'typeorm';

/** Super-admin scheduled usage reports (PART 5). */
export class UsageReportSchedules1730002100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "usage_report_schedules" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "frequency" character varying(16) NOT NULL,
        "cron" character varying,
        "delivery" character varying(16) NOT NULL,
        "target" character varying NOT NULL,
        "format" character varying(8) NOT NULL DEFAULT 'JSON',
        "sections" jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by" uuid,
        "last_run_at" TIMESTAMP WITH TIME ZONE,
        "last_status" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usage_report_schedules" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_usage_report_schedules_active" ON "usage_report_schedules" ("is_active")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_usage_report_schedules_active"`);
    await q.query(`DROP TABLE IF EXISTS "usage_report_schedules"`);
  }
}
