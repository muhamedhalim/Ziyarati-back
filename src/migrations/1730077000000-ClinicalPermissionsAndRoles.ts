import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T105 (US6, FR-H010b/c/f).
 * **[BREAKING]** — the one accepted breaking change in this phase.
 *
 * Establishes the new clinical privacy boundary in DATA: seeds the
 * `clinical.records.read`/`.manage` permission catalog rows, grants both to
 * `doctor`, `owner`, `manager`, grants `crm.customers.read` to `doctor`
 * (which today holds only `dashboard.access` and `appointments.read_own`,
 * and therefore cannot open ANY patient record — FR-H010c), and grants
 * NEITHER clinical slug to `receptionist` — reception's existing
 * `crm.customers.read` grant is untouched, but T108's enforcing code (which
 * MUST deploy in the SAME release as this migration, never before) narrows
 * what that read returns for a non-clinical caller.
 *
 * Fully idempotent (existence-checked inserts) — safe to re-run. Reversible
 * — `down()` removes exactly the grants this migration added and deletes the
 * two permission rows, restoring the prior state exactly.
 *
 * This data migration and `rbac.constants.ts`'s `ROLE_PERMISSIONS` map (also
 * updated in this same change) are two expressions of the identical grant
 * matrix — `seedRolePermissions` (the boot-time reconciler) will find this
 * migration's state already matching on next boot (`+0/-0`) and is the
 * mechanism that keeps them from drifting apart on any FUTURE change to
 * `rbac.constants.ts`; this migration exists so the grant is correct in the
 * database immediately, without waiting for the next full app restart.
 *
 * NOTE ON TIMESTAMP: data-model.md's own migration table names this
 * `1730069000000-ClinicalPermissionsAndRoles` — renumbered to follow
 * `1730076000000-ClinicalRecords` (itself renumbered — see that file's own
 * note) so both land after every migration that actually exists on disk.
 */
export class ClinicalPermissionsAndRoles1730077000000 implements MigrationInterface {
  name = 'ClinicalPermissionsAndRoles1730077000000';

  private static readonly CLINICAL_READ = 'clinical.records.read';
  private static readonly CLINICAL_MANAGE = 'clinical.records.manage';
  private static readonly CRM_CUSTOMERS_READ = 'crm.customers.read';

  public async up(q: QueryRunner): Promise<void> {
    // ── Seed the two permission catalog rows (idempotent) ───────────────
    await q.query(
      `INSERT INTO "permissions" ("name", "slug", "module", "description", "risk_level")
       VALUES ('Read clinical records', $1, 'clinical',
         'Read structured clinical entries and CustomerProfile''s clinical fields.', 'high')
       ON CONFLICT (slug) DO NOTHING`,
      [ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ],
    );
    await q.query(
      `INSERT INTO "permissions" ("name", "slug", "module", "description", "risk_level")
       VALUES ('Manage clinical records', $1, 'clinical',
         'Create, correct and soft-delete structured clinical entries.', 'high')
       ON CONFLICT (slug) DO NOTHING`,
      [ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE],
    );

    // ── Grant matrix (idempotent — existence-checked, not ON CONFLICT: the
    // (roleId, permissionId) pair has no unique constraint to conflict on) ──
    const grants: Array<{ roleSlug: string; permissionSlug: string }> = [
      {
        roleSlug: 'doctor',
        permissionSlug: ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ,
      },
      {
        roleSlug: 'doctor',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE,
      },
      {
        roleSlug: 'doctor',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CRM_CUSTOMERS_READ,
      },
      {
        roleSlug: 'owner',
        permissionSlug: ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ,
      },
      {
        roleSlug: 'owner',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE,
      },
      {
        roleSlug: 'manager',
        permissionSlug: ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ,
      },
      {
        roleSlug: 'manager',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE,
      },
    ];

    for (const { roleSlug, permissionSlug } of grants) {
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
        [roleSlug, permissionSlug],
      );
    }

    const [missing] = await q.query(`
      SELECT COUNT(*)::int AS c FROM (
        VALUES ('doctor', '${ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ}'),
               ('doctor', '${ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE}'),
               ('doctor', '${ClinicalPermissionsAndRoles1730077000000.CRM_CUSTOMERS_READ}'),
               ('owner', '${ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ}'),
               ('owner', '${ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE}'),
               ('manager', '${ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ}'),
               ('manager', '${ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE}')
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
        `ClinicalPermissionsAndRoles: ${missing.c} expected grant(s) are still missing after the ` +
          'insert loop — investigate before considering this migration applied. A live role would ' +
          'otherwise be left without access this migration was supposed to grant.',
      );
    }
  }

  /** Removes exactly the grants this migration added, then the two permission rows. Reversible. */
  public async down(q: QueryRunner): Promise<void> {
    const grants: Array<{ roleSlug: string; permissionSlug: string }> = [
      {
        roleSlug: 'doctor',
        permissionSlug: ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ,
      },
      {
        roleSlug: 'doctor',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE,
      },
      {
        roleSlug: 'doctor',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CRM_CUSTOMERS_READ,
      },
      {
        roleSlug: 'owner',
        permissionSlug: ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ,
      },
      {
        roleSlug: 'owner',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE,
      },
      {
        roleSlug: 'manager',
        permissionSlug: ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ,
      },
      {
        roleSlug: 'manager',
        permissionSlug:
          ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE,
      },
    ];
    for (const { roleSlug, permissionSlug } of grants) {
      await q.query(
        `DELETE FROM "role_permissions" rp
          USING "roles" r, "permissions" p
          WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
            AND r.slug = $1 AND r."tenantId" IS NULL AND p.slug = $2`,
        [roleSlug, permissionSlug],
      );
    }
    await q.query(`DELETE FROM "permissions" WHERE slug IN ($1, $2)`, [
      ClinicalPermissionsAndRoles1730077000000.CLINICAL_READ,
      ClinicalPermissionsAndRoles1730077000000.CLINICAL_MANAGE,
    ]);
  }
}
