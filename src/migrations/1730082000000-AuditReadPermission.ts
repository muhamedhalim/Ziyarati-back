import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T192 (US14, FR-U009).
 *
 * Seeds the `audit.read` permission catalog row and grants it to `owner` and
 * `manager` ONLY — the Activity UI (T193's `ActivityLogController`) must be
 * reachable by clinic ownership and management, and by nobody else.
 * `receptionist`/`doctor` deliberately receive nothing here (the frontend
 * navigation absence is T196's job; this migration is what makes the
 * BACKEND enforcement correct).
 *
 * Fully idempotent (`ON CONFLICT DO NOTHING` for the catalog row,
 * existence-checked inserts for the grants) — safe to re-run. Reversible —
 * `down()` removes exactly the two grants this migration added, then the
 * permission row, restoring the prior state exactly.
 *
 * This data migration and `rbac.constants.ts`'s `ROLE_PERMISSIONS` map (also
 * updated in this same change, adding `PERMISSION.AUDIT_READ` to OWNER and
 * MANAGER) are two expressions of the identical grant matrix —
 * `seedRolePermissions` (the boot-time reconciler) will find this migration's
 * state already matching on next boot (`+0/-0`); this migration exists so the
 * grant is correct in the database immediately, without waiting for the next
 * full app restart. See `1730077000000-ClinicalPermissionsAndRoles.ts` for
 * the identical precedent this migration follows structurally.
 *
 * NOTE ON TIMESTAMP: T192's own task text suggests
 * `1730076000000-AuditReadPermission.ts`, but that exact timestamp was
 * already taken by `1730076000000-ClinicalRecords.ts` (Phase 9, earlier this
 * session) by the time this phase landed. Renumbered to
 * `1730082000000` — one slot after the highest migration that actually
 * exists on disk at this handoff (`1730081000000-ExportJobs.ts`, Phase 15),
 * so this migration is guaranteed to run after every migration that already
 * exists.
 */
export class AuditReadPermission1730082000000 implements MigrationInterface {
  name = 'AuditReadPermission1730082000000';

  private static readonly AUDIT_READ = 'audit.read';
  private static readonly GRANT_ROLES = ['owner', 'manager'] as const;

  public async up(q: QueryRunner): Promise<void> {
    // ── Seed the permission catalog row (idempotent) ────────────────────
    await q.query(
      `INSERT INTO "permissions" ("name", "slug", "module", "description", "risk_level")
       VALUES ('Read clinic activity log', $1, 'activity_log',
         'Read the clinic-facing accountability timeline (allow-listed actions only, field names never values).', 'medium')
       ON CONFLICT (slug) DO NOTHING`,
      [AuditReadPermission1730082000000.AUDIT_READ],
    );

    // ── Grant matrix (idempotent — existence-checked, not ON CONFLICT: the
    // (roleId, permissionId) pair has no unique constraint to conflict on) ──
    for (const roleSlug of AuditReadPermission1730082000000.GRANT_ROLES) {
      await q.query(
        `INSERT INTO "role_permissions" ("roleId", "permissionId")
         SELECT r.id, p.id
           FROM "roles" r, "permissions" p
          WHERE r.slug = $1 AND r."tenantId" IS NULL
            AND p.slug = $2
            AND NOT EXISTS (
              SELECT 1 FROM "role_permissions" rp
               WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
            )`,
        [roleSlug, AuditReadPermission1730082000000.AUDIT_READ],
      );
    }

    const [missing] = await q.query(`
      SELECT COUNT(*)::int AS c FROM (
        VALUES ('owner', '${AuditReadPermission1730082000000.AUDIT_READ}'),
               ('manager', '${AuditReadPermission1730082000000.AUDIT_READ}')
      ) AS expected(role_slug, perm_slug)
      WHERE NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        JOIN roles r ON r.id = rp."roleId" AND r."tenantId" IS NULL
        JOIN permissions p ON p.id = rp."permissionId"
        WHERE r.slug = expected.role_slug AND p.slug = expected.perm_slug
      )
    `);
    if (Number(missing?.c) > 0) {
      throw new Error(
        `AuditReadPermission: ${missing.c} expected grant(s) are still missing after the ` +
          'insert loop — investigate before considering this migration applied. A live role ' +
          'would otherwise be left without access this migration was supposed to grant.',
      );
    }
  }

  /** Removes exactly the grants this migration added, then the permission row. Reversible. */
  public async down(q: QueryRunner): Promise<void> {
    for (const roleSlug of AuditReadPermission1730082000000.GRANT_ROLES) {
      await q.query(
        `DELETE FROM "role_permissions" rp
          USING "roles" r, "permissions" p
          WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
            AND r.slug = $1 AND r."tenantId" IS NULL AND p.slug = $2`,
        [roleSlug, AuditReadPermission1730082000000.AUDIT_READ],
      );
    }
    await q.query(`DELETE FROM "permissions" WHERE slug = $1`, [
      AuditReadPermission1730082000000.AUDIT_READ,
    ]);
  }
}
