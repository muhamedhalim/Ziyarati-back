import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Doctor role permission refinement — adds `staff.read_own` (ABAC/ownership-
 * scoped — see OWNERSHIP_SCOPED_PERMISSIONS in rbac.constants.ts) and grants
 * it to `doctor`, so a doctor can read their OWN staff profile, weekly
 * schedule and time off via `GET /staff/me`, `/staff/me/schedules` and
 * `/staff/me/time-off` (`staff.controller.ts`) — routes that accept no id
 * from the client at all, so there is no ownership check to add on the
 * service side; the request shape itself makes "ask for someone else's"
 * inexpressible.
 *
 * Fully idempotent (existence-checked inserts) — safe to re-run. Reversible
 * — `down()` removes exactly the grant this migration added and deletes the
 * permission row, restoring the prior state exactly.
 *
 * This data migration and `rbac.constants.ts`'s `ROLE_PERMISSIONS` map (also
 * updated in this same change) are two expressions of the identical grant —
 * `seedRolePermissions` (the boot-time reconciler) will find this
 * migration's state already matching on next boot (`+0/-0`).
 *
 * PRODUCTION SAFETY (mirrors `ClinicalPermissionsAndRoles1730077000000`'s
 * exact pattern and rationale): the `doctor` role is created ONLY by the
 * boot-time `seedRoles()` — no earlier migration in this repo's history
 * creates it — and `BootstrapSeederService`'s own docblock says
 * `SEED_ON_STARTUP=false` is the RECOMMENDED production setting, with
 * `npm run seed` OR a migration expected to provision roles instead. A
 * grant-only migration would silently insert zero grant rows on a
 * migrate-before-first-boot deployment — exactly the scenario
 * `SEED_ON_STARTUP=false` exists for. This migration therefore seeds its
 * one dependency role itself (guarded, idempotent) before granting to it,
 * so it is self-sufficient regardless of `SEED_ON_STARTUP` or seed ordering.
 */
export class StaffReadOwnPermission1730100000000
  implements MigrationInterface
{
  name = 'StaffReadOwnPermission1730100000000';

  private static readonly STAFF_READ_OWN = 'staff.read_own';

  public async up(q: QueryRunner): Promise<void> {
    // ── Seed the `doctor` role if missing (guarded, idempotent — see the
    // class docblock's PRODUCTION SAFETY note). Text matches ROLES in
    // rbac.constants.ts exactly, so a later boot-time seedRoles() run finds
    // nothing to reconcile. ──────────────────────────────────────────────
    await q.query(
      `INSERT INTO "roles" ("name", "slug", "description", "is_system")
       SELECT $1, $2::varchar, $3, true
       WHERE NOT EXISTS (
         SELECT 1 FROM "roles" WHERE "slug" = $2::varchar AND "tenantId" IS NULL
       )`,
      [
        'Doctor',
        'doctor',
        'Clinical staff who treat customers. Manages own appointments and schedule.',
      ],
    );

    // ── Seed the permission catalog row (idempotent) ────────────────────
    await q.query(
      `INSERT INTO "permissions" ("name", "slug", "module", "description", "risk_level")
       VALUES ('Read own staff profile & schedule', $1, 'staff',
         'View only the current user''s own staff profile, weekly schedule and time-off — never another staff member''s (no id is accepted from the client on these routes).',
         'low')
       ON CONFLICT (slug) DO NOTHING`,
      [StaffReadOwnPermission1730100000000.STAFF_READ_OWN],
    );

    // ── Grant to `doctor` (idempotent — existence-checked, not ON CONFLICT:
    // the (roleId, permissionId) pair has no unique constraint to conflict on) ──
    await q.query(
      `INSERT INTO "role_permissions" ("roleId", "permissionId")
       SELECT r.id, p.id
         FROM "roles" r, "permissions" p
        WHERE r.slug = 'doctor' AND r."tenantId" IS NULL
          AND p.slug = $1
          AND NOT EXISTS (
            SELECT 1 FROM "role_permissions" rp
             WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
          )`,
      [StaffReadOwnPermission1730100000000.STAFF_READ_OWN],
    );

    const [missing] = await q.query(
      `SELECT COUNT(*)::int AS c
         FROM "roles" r, "permissions" p
        WHERE r.slug = 'doctor' AND r."tenantId" IS NULL
          AND p.slug = $1
          AND NOT EXISTS (
            SELECT 1 FROM "role_permissions" rp
             WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
          )`,
      [StaffReadOwnPermission1730100000000.STAFF_READ_OWN],
    );
    if (Number(missing?.c) > 0) {
      throw new Error(
        `StaffReadOwnPermission: the doctor -> staff.read_own grant is still missing after the ` +
          'insert — investigate before considering this migration applied. A live doctor account ' +
          'would otherwise be left without access this migration was supposed to grant.',
      );
    }
  }

  /** Removes exactly the grant this migration added, then the permission row. Reversible. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DELETE FROM "role_permissions" rp
        USING "roles" r, "permissions" p
        WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
          AND r.slug = 'doctor' AND r."tenantId" IS NULL AND p.slug = $1`,
      [StaffReadOwnPermission1730100000000.STAFF_READ_OWN],
    );
    await q.query(`DELETE FROM "permissions" WHERE slug = $1`, [
      StaffReadOwnPermission1730100000000.STAFF_READ_OWN,
    ]);
  }
}
