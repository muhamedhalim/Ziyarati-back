import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Workflow Engine: tenant-configurable Event → Conditions → Actions automations
 * plus their execution audit runs. Additive; both tables use IF NOT EXISTS so
 * they are idempotent alongside the dev `synchronize` path.
 */
export class Workflows1730002600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "workflows" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid,
        "name" character varying(160) NOT NULL,
        "description" text,
        "trigger_event" character varying(80) NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "conditions" jsonb,
        "actions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workflows" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_workflows_trigger" ON "workflows" ("trigger_event")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_workflows_tenant" ON "workflows" ("tenantId")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "workflow_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid,
        "workflowId" uuid,
        "trigger_event" character varying(80) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'PENDING',
        "context" jsonb,
        "results" jsonb,
        "error" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_workflow_runs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_workflow_runs_workflow" FOREIGN KEY ("workflowId")
          REFERENCES "workflows"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_workflow_runs_workflow" ON "workflow_runs" ("workflowId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_workflow_runs_tenant" ON "workflow_runs" ("tenantId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "workflow_runs"`);
    await q.query(`DROP TABLE IF EXISTS "workflows"`);
  }
}
