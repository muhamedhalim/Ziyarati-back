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
 *
 * PRODUCTION SAFETY (found by `npm run migration:verify` running the FULL
 * migration set against a genuinely empty database, with no seeder ever
 * run): the base system roles (`owner`/`manager`/`doctor`/`receptionist`/
 * `super_admin`) are created ONLY by the boot-time `seedRoles()` — no
 * earlier migration in this repo's history creates them, and
 * `BootstrapSeederService`'s own docblock says `SEED_ON_STARTUP=false` is
 * the RECOMMENDED production setting, with `npm run seed` OR a migration
 * expected to provision roles instead. A migration that only GRANTS to
 * `owner`/`manager`/`doctor` — as this one originally did — would silently
 * insert zero grant rows on a fresh migrate-before-first-boot deployment,
 * exactly the scenario `SEED_ON_STARTUP=false` exists for. This migration
 * therefore seeds its three dependency roles itself (guarded, idempotent —
 * mirroring `PlatformSupportRoleAndPermissions1730034000000`'s exact
 * pattern for its own `platform_support` role) before granting to them, so
 * it is self-sufficient regardless of `SEED_ON_STARTUP` or seed ordering.
 * The same gap applies to `crm.customers.read`'s catalog row (needed for
 * doctor's FR-H010c grant) — it predates this migration but is likewise
 * never created by any migration, only by boot-time `seedPermissions()`;
 * seeded here too, guarded, for the same reason.
 *
 * `down()` deliberately does NOT remove the three roles or the
 * `crm.customers.read` permission even if this migration created them —
 * unlike this migration's OWN two clinical permissions, these are
 * foundational/pre-existing objects load-bearing across the entire RBAC
 * system (every tenant's user_roles, reception's existing grant, CRM
 * controllers); removing them is out of scope for a migration whose job is
 * one privacy boundary's permissions.
 */
export class ClinicalPermissionsAndRoles1730077000000 implements MigrationInterface {
  name = 'ClinicalPermissionsAndRoles1730077000000';

  private static readonly CLINICAL_READ = 'clinical.records.read';
  private static readonly CLINICAL_MANAGE = 'clinical.records.manage';
  private static readonly CRM_CUSTOMERS_READ = 'crm.customers.read';

  public async up(q: QueryRunner): Promise<void> {
    // ── Seed this migration's three dependency roles if missing (guarded,
    // idempotent — see the class docblock's PRODUCTION SAFETY note). Text
    // matches ROLES in rbac.constants.ts exactly, so a later boot-time
    // seedRoles() run finds nothing to reconcile. ────────────────────────
    const roles: Array<{ slug: string; name: string; description: string }> = [
      {
        slug: 'owner',
        name: 'Clinic Owner',
        description: 'Owns the clinic (tenant). Runs the business end-to-end.',
      },
      {
        slug: 'manager',
        name: 'Operations Manager',
        description:
          'Supervises staff, appointments and customers for the clinic.',
      },
      {
        slug: 'doctor',
        name: 'Doctor',
        description:
          'Clinical staff who treat customers. Manages own appointments and schedule.',
      },
    ];
    for (const role of roles) {
      await q.query(
        `INSERT INTO "roles" ("name", "slug", "description", "is_system")
         SELECT $1, $2::varchar, $3, true
         WHERE NOT EXISTS (
           SELECT 1 FROM "roles" WHERE "slug" = $2::varchar AND "tenantId" IS NULL
         )`,
        [role.name, role.slug, role.description],
      );
    }

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
    // `crm.customers.read` predates this migration (added by an earlier
    // phase's PERMISSIONS catalog entry) but — like the base roles above —
    // is never created by any migration, only by boot-time `seedPermissions()`.
    // Doctor's grant on it (FR-H010c) needs the catalog row to exist, so
    // this migration seeds it too, guarded, matching its exact catalog
    // definition (name/module only — scope/risk_level use the Permission
    // entity's own defaults, identical to what seedPermissions() would insert).
    await q.query(
      `INSERT INTO "permissions" ("name", "slug", "module")
       VALUES ('Read CRM customers', $1, 'crm')
       ON CONFLICT (slug) DO NOTHING`,
      [ClinicalPermissionsAndRoles1730077000000.CRM_CUSTOMERS_READ],
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
