import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales Staff Management — data model.
 *
 * ADDS (all additive; no existing column changes, no backfill):
 *   - role `platform_sales` (tenantId NULL, is_system) — classification only,
 *     NO permission rows: every /platform/sales/** route is Super Admin
 *     role-gated.
 *   - sales_clinic_assignments — clinic ownership + history. One ACTIVE owner
 *     per clinic (partial unique index); acquisition credit once per clinic.
 *   - sales_targets            — monthly target per employee per metric, with
 *     the bonus RULE and an optimistic-concurrency `version`.
 *   - sales_target_revisions   — append-only target history (written in the
 *     same transaction as the change; `audit_logs` is best-effort).
 *   - sales_bonus_records      — immutable approved-bonus snapshots.
 *   - sales_activities         — manually logged visits/calls/meetings.
 *   - IX_subscription_invoices_tenant_paid — partial index serving revenue /
 *     conversion attribution (previously no index on tenant_id or paid_at).
 *
 * WHY THE ROLE IS SEEDED HERE. Production runs SEED_ON_STARTUP=false, so a
 * role that exists only in rbac.constants.ts never reaches it. The text below
 * matches ROLES in rbac.constants.ts EXACTLY so a later seedRoles() finds
 * nothing to reconcile. The migration verifies its own insert and throws if
 * the role is missing (never weaken that check).
 *
 * INDEX NOTE. `paid` index is a plain CREATE INDEX inside the migration
 * transaction — fine while subscription_invoices is small. On a large table
 * run it CONCURRENTLY from a transaction-less migration instead.
 *
 * Every index/constraint below is ALSO declared on the entity classes in
 * src/entities/Sales/*, so a schema built from metadata carries the same
 * integrity guards (P0.2/P0.3).
 *
 * REVERSIBLE — down() refuses while any user still holds platform_sales.
 */
export class SalesStaffManagement1730105000000 implements MigrationInterface {
  name = 'SalesStaffManagement1730105000000';

  private static readonly ROLE_SLUG = 'platform_sales';
  private static readonly ROLE_NAME = 'Platform Sales';
  private static readonly ROLE_DESCRIPTION =
    'ZiyaraTech field-sales employee. Owns a portfolio of clinics with monthly targets, managed by Super Admin. Holds no console permissions.';

  public async up(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG, ROLE_NAME, ROLE_DESCRIPTION } =
      SalesStaffManagement1730105000000;

    // ── Role (guarded, tenantId IS NULL keeps it distinct from a tenant role
    // that happens to share the slug). ─────────────────────────────────────
    await q.query(
      `INSERT INTO "roles" ("name", "slug", "description", "is_system")
       SELECT $1, $2::varchar, $3, true
       WHERE NOT EXISTS (
         SELECT 1 FROM "roles" WHERE "slug" = $2::varchar AND "tenantId" IS NULL
       )`,
      [ROLE_NAME, ROLE_SLUG, ROLE_DESCRIPTION],
    );

    // ── sales_clinic_assignments ──────────────────────────────────────────
    await q.query(`
      CREATE TABLE "sales_clinic_assignments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sales_user_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "kind" varchar(16) NOT NULL,
        "assigned_at" timestamptz NOT NULL DEFAULT now(),
        "ended_at" timestamptz,
        "end_reason" varchar(24),
        "assigned_by" uuid,
        "ended_by" uuid,
        "note" varchar(500),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sales_clinic_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sales_assignment_user" FOREIGN KEY ("sales_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_sales_assignment_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_sales_assignment_assigned_by" FOREIGN KEY ("assigned_by") REFERENCES "users" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_sales_assignment_ended_by" FOREIGN KEY ("ended_by") REFERENCES "users" ("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_sales_assignment_kind" CHECK ("kind" IN ('acquired','managed')),
        CONSTRAINT "CHK_sales_assignment_end_reason" CHECK ("end_reason" IS NULL OR "end_reason" IN ('unassigned','reassigned','transferred')),
        CONSTRAINT "CHK_sales_assignment_period" CHECK ("ended_at" IS NULL OR "ended_at" >= "assigned_at")
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_sales_assignment_active_tenant" ON "sales_clinic_assignments" ("tenant_id") WHERE "ended_at" IS NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_sales_assignment_acquired_tenant" ON "sales_clinic_assignments" ("tenant_id") WHERE "kind" = 'acquired'`,
    );
    await q.query(
      `CREATE INDEX "IX_sales_assignment_user_active" ON "sales_clinic_assignments" ("sales_user_id", "assigned_at") WHERE "ended_at" IS NULL`,
    );
    await q.query(
      `CREATE INDEX "IX_sales_assignment_user_assigned" ON "sales_clinic_assignments" ("sales_user_id", "assigned_at")`,
    );
    await q.query(
      `CREATE INDEX "IX_sales_assignment_tenant_history" ON "sales_clinic_assignments" ("tenant_id", "assigned_at")`,
    );

    // ── sales_targets ─────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "sales_targets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sales_user_id" uuid NOT NULL,
        "period_month" date NOT NULL,
        "metric" varchar(24) NOT NULL,
        "target_value" numeric(14,2) NOT NULL,
        "currency" char(3),
        "bonus_type" varchar(24) NOT NULL DEFAULT 'none',
        "bonus_threshold_pct" numeric(6,2),
        "bonus_amount" numeric(14,2),
        "bonus_percent" numeric(5,2),
        "bonus_currency" char(3),
        "version" integer NOT NULL DEFAULT 1,
        "created_by" uuid,
        "updated_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sales_targets" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sales_targets_user_period_metric" UNIQUE ("sales_user_id", "period_month", "metric"),
        CONSTRAINT "FK_sales_targets_user" FOREIGN KEY ("sales_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_sales_targets_metric" CHECK ("metric" IN ('new_clinics','subscription_revenue','paid_conversions')),
        CONSTRAINT "CHK_sales_targets_period_first_day" CHECK (EXTRACT(DAY FROM "period_month") = 1),
        CONSTRAINT "CHK_sales_targets_value" CHECK ("target_value" >= 0),
        CONSTRAINT "CHK_sales_targets_currency" CHECK (("metric" = 'subscription_revenue') = ("currency" IS NOT NULL)),
        CONSTRAINT "CHK_sales_targets_bonus_type" CHECK ("bonus_type" IN ('none','fixed_on_threshold','percent_of_achieved')),
        CONSTRAINT "CHK_sales_targets_bonus_shape" CHECK (
          ("bonus_type" = 'none' AND "bonus_amount" IS NULL AND "bonus_percent" IS NULL)
          OR ("bonus_type" = 'fixed_on_threshold' AND "bonus_amount" IS NOT NULL AND "bonus_percent" IS NULL AND "bonus_threshold_pct" IS NOT NULL)
          OR ("bonus_type" = 'percent_of_achieved' AND "bonus_percent" IS NOT NULL AND "bonus_amount" IS NULL AND "metric" = 'subscription_revenue')
        )
      )`);
    await q.query(
      `CREATE INDEX "IX_sales_targets_period" ON "sales_targets" ("period_month", "sales_user_id")`,
    );

    // ── sales_target_revisions ────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "sales_target_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "target_id" uuid NOT NULL,
        "revision" integer NOT NULL,
        "before" jsonb,
        "after" jsonb,
        "reason" varchar(500),
        "changed_by" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sales_target_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sales_target_revisions_target_revision" UNIQUE ("target_id", "revision"),
        CONSTRAINT "FK_sales_target_revisions_target" FOREIGN KEY ("target_id") REFERENCES "sales_targets" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_sales_target_revisions_user" FOREIGN KEY ("changed_by") REFERENCES "users" ("id") ON DELETE RESTRICT
      )`);

    // ── sales_bonus_records ───────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "sales_bonus_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "target_id" uuid NOT NULL,
        "sales_user_id" uuid NOT NULL,
        "period_month" date NOT NULL,
        "metric" varchar(24) NOT NULL,
        "target_value" numeric(14,2) NOT NULL,
        "achieved_value" numeric(14,2) NOT NULL,
        "achievement_pct" numeric(8,2) NOT NULL,
        "rule_snapshot" jsonb NOT NULL,
        "bonus_amount" numeric(14,2) NOT NULL,
        "currency" char(3),
        "status" varchar(12) NOT NULL DEFAULT 'approved',
        "computed_at" timestamptz NOT NULL,
        "approved_by" uuid NOT NULL,
        "approved_at" timestamptz NOT NULL,
        "paid_marked_by" uuid,
        "paid_marked_at" timestamptz,
        "void_reason" varchar(500),
        "voided_by" uuid,
        "voided_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sales_bonus_records" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sales_bonus_target" FOREIGN KEY ("target_id") REFERENCES "sales_targets" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_sales_bonus_user" FOREIGN KEY ("sales_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_sales_bonus_status" CHECK ("status" IN ('approved','paid','void')),
        CONSTRAINT "CHK_sales_bonus_amount" CHECK ("bonus_amount" >= 0)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_sales_bonus_live_per_target" ON "sales_bonus_records" ("target_id") WHERE "status" <> 'void'`,
    );
    await q.query(
      `CREATE INDEX "IX_sales_bonus_user_period" ON "sales_bonus_records" ("sales_user_id", "period_month")`,
    );

    // ── sales_activities ──────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "sales_activities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sales_user_id" uuid NOT NULL,
        "tenant_id" uuid,
        "prospect_name" varchar(200),
        "type" varchar(16) NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "outcome" varchar(24),
        "note" varchar(1000),
        "source" varchar(16) NOT NULL DEFAULT 'admin_manual',
        "recorded_by" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "PK_sales_activities" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sales_activities_user" FOREIGN KEY ("sales_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_sales_activities_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_sales_activities_recorded_by" FOREIGN KEY ("recorded_by") REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_sales_activities_type" CHECK ("type" IN ('visit','call','meeting','demo','follow_up')),
        CONSTRAINT "CHK_sales_activities_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('interested','not_interested','follow_up_needed','signed_up','no_answer')),
        CONSTRAINT "CHK_sales_activities_subject" CHECK ("tenant_id" IS NOT NULL OR "prospect_name" IS NOT NULL)
      )`);
    await q.query(
      `CREATE INDEX "IX_sales_activities_user_occurred" ON "sales_activities" ("sales_user_id", "occurred_at") WHERE "deleted_at" IS NULL`,
    );
    await q.query(
      `CREATE INDEX "IX_sales_activities_tenant_occurred" ON "sales_activities" ("tenant_id", "occurred_at") WHERE "deleted_at" IS NULL`,
    );

    // ── Revenue / conversion attribution index ────────────────────────────
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_subscription_invoices_tenant_paid" ON "subscription_invoices" ("tenant_id", "paid_at") WHERE "status" = 'PAID'`,
    );

    // ── Prove the role landed. A sales employee created against a missing
    // role would be un-assignable; fail the migration instead. ─────────────
    const [row] = (await q.query(
      `SELECT COUNT(*)::int AS c FROM "roles" WHERE "slug" = $1::varchar AND "tenantId" IS NULL AND "is_system" = true`,
      [ROLE_SLUG],
    )) as [{ c: number }];
    if (Number(row?.c) !== 1) {
      throw new Error(
        `${SalesStaffManagement1730105000000.name}: role "${ROLE_SLUG}" is missing after the insert — investigate before considering this migration applied.`,
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG } = SalesStaffManagement1730105000000;

    // Refuse if a real user still holds the role: dropping it would silently
    // strip a real employee's classification. The operator reassigns first.
    const [{ c: assigned }] = (await q.query(
      `SELECT COUNT(*)::int AS c
         FROM "user_roles" ur
         JOIN "roles" r ON r.id = ur."roleId"
        WHERE r.slug = $1::varchar AND r."tenantId" IS NULL`,
      [ROLE_SLUG],
    )) as [{ c: number }];
    if (Number(assigned) > 0) {
      throw new Error(
        `${SalesStaffManagement1730105000000.name}.down(): refusing to revert — ${assigned} user(s) still hold the "${ROLE_SLUG}" role. Reassign or remove them first.`,
      );
    }

    await q.query(`DROP INDEX IF EXISTS "IX_subscription_invoices_tenant_paid"`);
    await q.query(`DROP TABLE IF EXISTS "sales_activities"`);
    await q.query(`DROP TABLE IF EXISTS "sales_bonus_records"`);
    await q.query(`DROP TABLE IF EXISTS "sales_target_revisions"`);
    await q.query(`DROP TABLE IF EXISTS "sales_targets"`);
    await q.query(`DROP TABLE IF EXISTS "sales_clinic_assignments"`);

    // The role has no permission grants (by design), so only the row goes.
    await q.query(
      `DELETE FROM "roles" WHERE "slug" = $1::varchar AND "tenantId" IS NULL`,
      [ROLE_SLUG],
    );
  }
}
