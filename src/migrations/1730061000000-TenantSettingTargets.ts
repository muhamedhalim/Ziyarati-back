import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-clinic monthly goals for the dashboard target-tracking cards:
 * `appointment_target` (completed appointments) and `revenue_target` (paid
 * revenue), both scoped to the current UTC calendar month at read time —
 * this table stores only the standing goal, not a per-period snapshot.
 *
 * Nullable (no default): unlike the boolean/numeric operational settings on
 * this table, "no target set" is a real, distinct state the dashboard must
 * render differently from "target = 0" — see `tenant-target-progress.util.ts`.
 * Additive and backward-compatible: every existing tenant row simply gets
 * NULL in both columns, which the API already treats as "no target set".
 */
export class TenantSettingTargets1730061000000 implements MigrationInterface {
  name = 'TenantSettingTargets1730061000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tenant_settings'
            AND column_name = 'appointment_target'
        ) THEN
          ALTER TABLE "tenant_settings"
            ADD COLUMN "appointment_target" integer NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tenant_settings'
            AND column_name = 'revenue_target'
        ) THEN
          ALTER TABLE "tenant_settings"
            ADD COLUMN "revenue_target" numeric(14,2) NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — dropping would
   * discard every clinic's configured goal, and the columns are inert the
   * moment nothing reads them.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop appointment_target / revenue_target.
  }
}
