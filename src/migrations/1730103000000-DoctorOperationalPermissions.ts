import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Doctor — operational permissions. Lets a doctor run their OWN queue and
 * appointment status, edit the details of their OWN patients, read the CRM
 * care context (notes/tags/files) and open the Branches working-hours dialog,
 * without any administrative reach. Ownership is enforced in the service layer
 * (`StaffScopeService.assertMayDriveAppointment` /
 * `.hasAppointmentWithCustomer`), not by these grants alone — see the docblocks
 * on `isStatusWriteScopedToOwnStaff` and `PERMISSION.CRM_CUSTOMERS_UPDATE_OWN`
 * in `rbac.constants.ts`.
 *
 * WHY A MIGRATION AND NOT JUST THE SEEDER
 * `SEED_ON_STARTUP=false` is the recommended production setting, so a grant
 * that exists only in `rbac.constants.ts` never reaches a production database.
 * Same reasoning as `NurseRole1730101000000` / `StaffReadOwnPermission1730100000000`.
 *
 * WHY THE FULL 12-SLUG SET, NOT JUST THE DELTA
 * `dashboard.access` and `appointments.read_own` have no migration of their own
 * (they came from the seeder), so a database whose seeder never ran could hold
 * a doctor role missing them. Re-asserting the whole set is idempotent and
 * repairs that; the existence-checked inserts add nothing where a grant exists.
 * Nothing here ever REMOVES a grant — the seeder (where it runs) is the only
 * thing that strips, and it strips to exactly this same list.
 *
 * WHY TWO NEW PERMISSION ROWS
 * `staff.schedule.read` and `crm.customers.update_own` exist in no earlier
 * migration. Both are frozen at authoring-time values that equal
 * `permission-metadata.ts` (`getRisk` / `getScope` / `PERMISSION_DESCRIPTIONS`)
 * exactly — pinned by this migration's spec — so a boot-time
 * `seedPermissions()` finds nothing to change.
 *
 * IDEMPOTENT — every insert is existence-checked, so re-running is a no-op.
 * REVERSIBLE — `down()` removes the doctor's grants for the four slugs that
 * pre-existed but were NOT the doctor's before, and fully retires the two slugs
 * this migration alone created (stripping their grants from every role first).
 * It never touches the doctor's original six grants, and never deletes the
 * doctor role.
 */
export class DoctorOperationalPermissions1730103000000 implements MigrationInterface {
  name = 'DoctorOperationalPermissions1730103000000';

  private static readonly ROLE_SLUG = 'doctor';
  private static readonly ROLE_NAME = 'Doctor';
  private static readonly ROLE_DESCRIPTION =
    'Clinical staff who treat customers. Manages own appointments and schedule.';

  /** Frozen snapshot of ROLE_PERMISSIONS['doctor'] at authoring time. */
  private static readonly GRANTS: ReadonlyArray<{
    slug: string;
    name: string;
    module: string;
    scope: string;
    risk: string;
    description: string | null;
  }> = [
    // ── The doctor's original six ─────────────────────────────────────────
    {
      slug: 'dashboard.access',
      name: 'Access clinic dashboard',
      module: 'general',
      scope: 'tenant',
      risk: 'low',
      description: null,
    },
    {
      slug: 'appointments.read_own',
      name: 'Read own appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'low',
      description: null,
    },
    {
      slug: 'crm.customers.read',
      name: 'Read CRM customers',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
      description: null,
    },
    {
      slug: 'clinical.records.read',
      name: 'Read clinical records',
      module: 'clinical',
      scope: 'tenant',
      risk: 'high',
      description: null,
    },
    {
      slug: 'clinical.records.manage',
      name: 'Manage clinical records',
      module: 'clinical',
      scope: 'tenant',
      risk: 'high',
      description: null,
    },
    {
      slug: 'staff.read_own',
      name: 'Read own staff profile & schedule',
      module: 'staff',
      scope: 'tenant',
      risk: 'low',
      description: null,
    },
    // ── Existing slugs newly assigned to the doctor ───────────────────────
    {
      slug: 'appointments.status.update',
      name: 'Update appointment queue status',
      module: 'appointments',
      scope: 'tenant',
      risk: 'medium',
      description: null,
    },
    {
      slug: 'crm.notes.read',
      name: 'Read customer notes',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
      description: null,
    },
    {
      slug: 'crm.tags.read',
      name: 'Read customer tags',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
      description: null,
    },
    {
      slug: 'crm.files.read',
      name: 'Read customer files',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
      description: null,
    },
    // ── New slugs this migration introduces ───────────────────────────────
    {
      slug: 'crm.customers.update_own',
      name: "Edit own patients' details",
      module: 'crm',
      scope: 'tenant',
      risk: 'medium',
      description:
        'Edit the contact and demographic details of patients the current user has an appointment with (ownership enforced in the service layer). Cannot create, delete, import, change consent/status flags or identity keys.',
    },
    {
      slug: 'staff.schedule.read',
      name: 'View branch working hours',
      module: 'staff',
      scope: 'tenant',
      risk: 'low',
      description:
        'View a branch’s operating hours (read-only). Does not allow browsing staff members or editing any schedule.',
    },
  ];

  /** Pre-existing slugs the doctor did NOT hold before this migration. */
  private static readonly NEWLY_ASSIGNED_SLUGS: ReadonlyArray<string> = [
    'appointments.status.update',
    'crm.notes.read',
    'crm.tags.read',
    'crm.files.read',
  ];

  /** Slugs this migration itself introduces (vs. shared, pre-existing ones). */
  private static readonly NEW_PERMISSION_SLUGS: ReadonlyArray<string> = [
    'crm.customers.update_own',
    'staff.schedule.read',
  ];

  public async up(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG, ROLE_NAME, ROLE_DESCRIPTION, GRANTS } =
      DoctorOperationalPermissions1730103000000;

    // ── The role row (guarded — a database that already has it, from an
    // earlier migration or the seeder, inserts nothing). Text matches ROLES in
    // rbac.constants.ts exactly. ──────────────────────────────────────────────
    await q.query(
      `INSERT INTO "roles" ("name", "slug", "description", "is_system")
       SELECT $1, $2::varchar, $3, true
       WHERE NOT EXISTS (
         SELECT 1 FROM "roles" WHERE "slug" = $2::varchar AND "tenantId" IS NULL
       )`,
      [ROLE_NAME, ROLE_SLUG, ROLE_DESCRIPTION],
    );

    // ── Every permission this role grants. Ten already exist on any database
    // that has ever run the seeder or an earlier RBAC migration; the two NEW
    // slugs do not. Without this loop the grant loop below would silently
    // insert zero rows for them. ─────────────────────────────────────────────
    for (const p of GRANTS) {
      await q.query(
        `INSERT INTO "permissions" ("name", "slug", "module", "description", "scope", "risk_level")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO NOTHING`,
        [p.name, p.slug, p.module, p.description, p.scope, p.risk],
      );
    }

    // ── The grant matrix. Existence-checked rather than ON CONFLICT: the
    // (roleId, permissionId) pair carries no unique constraint to conflict on
    // in a migrated (non-synchronize) database. ──────────────────────────────
    for (const p of GRANTS) {
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
        [ROLE_SLUG, p.slug],
      );
    }

    // ── Prove it landed. A doctor role that reaches production with a
    // partial grant set leaves the queue/patient screens half-working with no
    // error to point at. Fail the migration instead. ─────────────────────────
    const [missing] = (await q.query(
      `SELECT COUNT(*)::int AS c
         FROM unnest($1::text[]) AS expected(perm_slug)
        WHERE NOT EXISTS (
          SELECT 1 FROM role_permissions rp
            JOIN roles r ON r.id = rp."roleId" AND r."tenantId" IS NULL
            JOIN permissions p ON p.id = rp."permissionId"
           WHERE r.slug = $2 AND p.slug = expected.perm_slug
        )`,
      [GRANTS.map((p) => p.slug), ROLE_SLUG],
    )) as [{ c: number }];

    if (Number(missing?.c) > 0) {
      throw new Error(
        `${DoctorOperationalPermissions1730103000000.name}: ${missing.c} of ${GRANTS.length} expected grant(s) are still ` +
          'missing after the insert loop — investigate before considering this migration applied.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG, NEWLY_ASSIGNED_SLUGS, NEW_PERMISSION_SLUGS } =
      DoctorOperationalPermissions1730103000000;

    // The doctor's four newly-assigned pre-existing slugs: remove ONLY the
    // doctor's grant. The permission rows stay — the nurse (and others) hold
    // them.
    for (const slug of NEWLY_ASSIGNED_SLUGS) {
      await q.query(
        `DELETE FROM "role_permissions" rp
          USING "roles" r, "permissions" p
          WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
            AND r.slug = $1 AND r."tenantId" IS NULL
            AND p.slug = $2`,
        [ROLE_SLUG, slug],
      );
    }

    // The two slugs this migration CREATED: fully retire them — strip their
    // grants from every remaining role first (a tenant could have delegated the
    // non-reserved `crm.customers.update_own` / `staff.schedule.read` to a
    // custom role since this migration ran), then delete the permission rows.
    for (const slug of NEW_PERMISSION_SLUGS) {
      await q.query(
        `DELETE FROM "role_permissions" rp
          USING "permissions" p
          WHERE rp."permissionId" = p.id AND p.slug = $1`,
        [slug],
      );
      await q.query(`DELETE FROM "permissions" WHERE "slug" = $1`, [slug]);
    }
  }
}
