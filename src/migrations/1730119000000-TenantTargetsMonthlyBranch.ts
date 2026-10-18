import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-month, per-branch dashboard targets with an append-only change ledger.
 *
 * Replaces the single standing goal on `tenant_settings`
 * (`appointment_target` / `revenue_target`) as the source of truth. Those
 * columns are KEPT (never dropped, R-DB6) but no longer read or written.
 *
 * Backfill: a tenant that had a standing goal gets ONE clinic-wide
 * (branch NULL) row for the month this migration runs in, with a history row
 * flagged `MIGRATED`. Earlier months are NOT invented — the old model kept no
 * past values, so there is nothing to reconstruct. Idempotent.
 *
 * Rollback: additive only; dropping the new tables would lose every target
 * set since deploy, so `down` leaves them in place.
 */
export class TenantTargetsMonthlyBranch1730119000000 implements MigrationInterface {
  name = 'TenantTargetsMonthlyBranch1730119000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "tenant_targets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "branch_id" uuid NULL,
        "target_type" character varying(16) NOT NULL,
        "period_month" character varying(7) NOT NULL,
        "value" numeric(14,2) NOT NULL,
        "original_value" numeric(14,2) NOT NULL,
        "created_by" uuid NULL,
        "updated_by" uuid NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_targets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tenant_targets_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tenant_targets_branch" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_tenant_targets_type" CHECK ("target_type" IN ('APPOINTMENTS','REVENUE')),
        CONSTRAINT "CHK_tenant_targets_period" CHECK ("period_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        CONSTRAINT "CHK_tenant_targets_value" CHECK ("value" >= 0 AND "original_value" >= 0)
      )`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_targets_branch"
      ON "tenant_targets" ("tenant_id","branch_id","target_type","period_month") WHERE "branch_id" IS NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_targets_org"
      ON "tenant_targets" ("tenant_id","target_type","period_month") WHERE "branch_id" IS NULL`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "tenant_target_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "target_id" uuid NULL,
        "branch_id" uuid NULL,
        "target_type" character varying(16) NOT NULL,
        "period_month" character varying(7) NOT NULL,
        "change_type" character varying(16) NOT NULL,
        "previous_value" numeric(14,2) NULL,
        "new_value" numeric(14,2) NOT NULL,
        "actor_user_id" uuid NULL,
        "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_target_history" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_tenant_target_history_scope"
      ON "tenant_target_history" ("tenant_id","branch_id","target_type","period_month","changed_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_tenant_target_history_tenant_changed"
      ON "tenant_target_history" ("tenant_id","changed_at")`);

    // Backfill the legacy standing goals into the current month, org-level.
    for (const [col, type] of [
      ['appointment_target', 'APPOINTMENTS'],
      ['revenue_target', 'REVENUE'],
    ] as const) {
      await q.query(`
        WITH ins AS (
          INSERT INTO "tenant_targets"
            ("tenant_id","branch_id","target_type","period_month","value","original_value")
          SELECT ts."tenant_id", NULL, '${type}', to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),
                 ts."${col}", ts."${col}"
          FROM "tenant_settings" ts
          WHERE ts."${col}" IS NOT NULL
          ON CONFLICT DO NOTHING
          RETURNING "id","tenant_id","target_type","period_month","value"
        )
        INSERT INTO "tenant_target_history"
          ("tenant_id","target_id","branch_id","target_type","period_month","change_type","previous_value","new_value")
        SELECT "tenant_id","id",NULL,"target_type","period_month",'MIGRATED',NULL,"value" FROM ins`);
    }
  }

  public async down(): Promise<void> {
    // Deliberately does not drop tenant_targets / tenant_target_history.
  }
}
