import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data repair for the `max_users` seat leak.
 *
 * `StaffService.remove` used to soft-delete only the `staff_profiles` row,
 * leaving the linked `users` row live — and the seat cap counts live `users`.
 * The code is fixed; this releases the seats of staff removed BEFORE the fix.
 *
 * A user is released only when ALL of these hold:
 *  - the account is live (`deleted_at IS NULL`) and belongs to a tenant
 *    (platform accounts, `tenantId IS NULL`, are never touched);
 *  - it HAS at least one staff profile, and EVERY one of them is soft-deleted
 *    (a live profile anywhere keeps the account);
 *  - it holds neither the `owner` nor the `super_admin` role.
 *
 * Their un-revoked refresh tokens are revoked first, then the account is
 * soft-deleted — the same two effects `StaffService.remove` now has. The set
 * is derived per row, so tenants cannot affect each other. Idempotent: once
 * released, a user no longer matches `deleted_at IS NULL`, so a re-run is a
 * no-op. Runs inside the migration transaction; nothing is hard-deleted.
 */
export class ReleaseSeatsOfRemovedStaff1730115000000 implements MigrationInterface {
  name = 'ReleaseSeatsOfRemovedStaff1730115000000';

  /** Exposed for the unit test and for operators wanting a read-only preview. */
  static readonly ORPHANED_USERS_SQL = `
    SELECT u."id"
      FROM "users" u
     WHERE u."deleted_at" IS NULL
       AND u."tenantId" IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM "staff_profiles" sp
              WHERE sp."user_id" = u."id")
       AND NOT EXISTS (
             SELECT 1 FROM "staff_profiles" sp
              WHERE sp."user_id" = u."id" AND sp."deleted_at" IS NULL)
       AND NOT EXISTS (
             SELECT 1 FROM "user_roles" ur
               JOIN "roles" r ON r."id" = ur."roleId"
              WHERE ur."userId" = u."id"
                AND r."slug" IN ('owner', 'super_admin'))`;

  public async up(q: QueryRunner): Promise<void> {
    const orphaned = ReleaseSeatsOfRemovedStaff1730115000000.ORPHANED_USERS_SQL;
    await q.query(`
      UPDATE "refresh_tokens"
         SET "revoked_at" = now()
       WHERE "revoked_at" IS NULL
         AND "userId" IN (${orphaned})`);
    await q.query(`
      UPDATE "users"
         SET "deleted_at" = now()
       WHERE "id" IN (${orphaned})`);
  }

  /** Data repair: a removed account is never resurrected on rollback. */
  public async down(): Promise<void> {
    // Intentionally a no-op.
  }
}
