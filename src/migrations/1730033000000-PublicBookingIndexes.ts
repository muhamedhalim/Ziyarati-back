import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supporting indexes for branch-scoped public booking. No new tables and no
 * new columns: branch-scoped services and branch-scoped doctors are already
 * modelled by `service_prices (serviceId, branchId, price, is_active)` and
 * `staff_schedules.branchId` respectively — they were simply never read by the
 * booking path. These indexes make the now-hot lookups cheap:
 *
 *  - `service_prices` — "which services does THIS branch offer, and at what
 *    price?" (`loadServices`, `list_branch_services`).
 *  - `staff_schedules` — "which doctors actually work at THIS branch?"
 *    (`assertStaffAtBranch`, `list_branch_doctors`). This is also the check
 *    that closes the fail-open availability hole, so it runs on every booking.
 *  - `branches.city_id` — the city filter on public clinic discovery. Partial
 *    on `deleted_at IS NULL` because public discovery never shows soft-deleted
 *    branches, so the dead rows need not be indexed.
 *
 * Purely additive and fully reversible.
 */
export class PublicBookingIndexes1730033000000 implements MigrationInterface {
  name = 'PublicBookingIndexes1730033000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_service_prices_branch_active"
         ON "service_prices" ("branchId", "is_active")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_staff_schedules_branch_active"
         ON "staff_schedules" ("branchId", "is_active")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_branches_city_active"
         ON "branches" ("city_id") WHERE "deleted_at" IS NULL`,
    );
  }

  /** Indexes carry no data — dropping them is genuinely reversible. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_branches_city_active"`);
    await q.query(`DROP INDEX IF EXISTS "idx_staff_schedules_branch_active"`);
    await q.query(`DROP INDEX IF EXISTS "idx_service_prices_branch_active"`);
  }
}
