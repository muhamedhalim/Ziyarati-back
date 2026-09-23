import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nurse — clinical support staff. Tenant-wide (not branch-restricted), reads
 * appointments/CRM/clinical records, runs queue check-in and status updates,
 * and records NOTE/VITALS clinical entries only (never diagnosis/medication).
 * Never a bookable provider (`PUBLIC_BOOKING_EXCLUDED_ROLES` in
 * `rbac.constants.ts` — enforced at the `StaffService` write paths, not here).
 *
 * WHY A MIGRATION AND NOT JUST THE SEEDER
 * Same reasoning as `BranchManagerRole1730087000000`: `SEED_ON_STARTUP=false`
 * is the recommended production setting, so a role that exists only in
 * `rbac.constants.ts` would never reach a production database.
 *
 * WHY TWO NEW PERMISSION ROWS
 * This role introduces two slugs that no earlier migration created:
 * `clinical.records.nursing` (create NOTE/VITALS entries, correct only one's
 * own — enforced in `ClinicalRecordService`) and `appointments.status.update`
 * (queue/status routes only, never `PATCH`/`PUT services` on an appointment).
 * Both are frozen here at authoring-time values matching
 * `permission-metadata.ts` (`RISK_OVERRIDES`/`getScope`) exactly, so the
 * boot-time `seedPermissions()`/`seedRolePermissions()` reconciler finds
 * nothing to change (`+0/-0`).
 *
 * IDEMPOTENT — every insert is existence-checked, so re-running is a no-op.
 * REVERSIBLE — `down()` refuses if any user still holds this role (would
 * silently strip a real employee of live access) and otherwise removes this
 * role's grants, the role row, and the two permission rows this migration
 * introduced (stripping their grants from every role first, since `down()`
 * must fully retire a slug it alone created — unlike the shared, pre-existing
 * slugs `BranchManagerRole1730087000000` grants, which it correctly leaves
 * behind for other roles).
 */
export class NurseRole1730101000000 implements MigrationInterface {
  name = 'NurseRole1730101000000';

  private static readonly ROLE_SLUG = 'nurse';
  private static readonly ROLE_NAME = 'Nurse';
  private static readonly ROLE_DESCRIPTION =
    'Clinical support staff. Views patients, appointments and the clinical record; records nursing notes and vitals; runs queue check-in and status updates. No diagnoses, prescriptions, finances, staff or settings.';

  /** Frozen snapshot of ROLE_PERMISSIONS['nurse'] at authoring time. */
  private static readonly GRANTS: ReadonlyArray<{
    slug: string;
    name: string;
    module: string;
    scope: string;
    risk: string;
  }> = [
    {
      slug: 'dashboard.access',
      name: 'Access clinic dashboard',
      module: 'general',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'appointments.read',
      name: 'Read appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'appointments.status.update',
      name: 'Update appointment queue status',
      module: 'appointments',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'crm.customers.read',
      name: 'Read CRM customers',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'crm.notes.read',
      name: 'Read customer notes',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'crm.tags.read',
      name: 'Read customer tags',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'crm.files.read',
      name: 'Read customer files',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'clinical.records.read',
      name: 'Read clinical records',
      module: 'clinical',
      scope: 'tenant',
      risk: 'high',
    },
    {
      slug: 'clinical.records.nursing',
      name: 'Record nursing notes & vitals',
      module: 'clinical',
      scope: 'tenant',
      risk: 'high',
    },
    {
      slug: 'staff.read_own',
      name: 'Read own staff profile & schedule',
      module: 'staff',
      scope: 'tenant',
      risk: 'low',
    },
  ];

  /** Slugs this migration itself introduces (vs. shared, pre-existing ones). */
  private static readonly NEW_PERMISSION_SLUGS: ReadonlyArray<string> = [
    'clinical.records.nursing',
    'appointments.status.update',
  ];

  public async up(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG, ROLE_NAME, ROLE_DESCRIPTION, GRANTS } =
      NurseRole1730101000000;

    // ── Pre-check: a tenant could already have created a custom role slugged
    // 'nurse' via POST /roles (no unique constraint on slug). That row is
    // untouched by this migration — global roles and tenant roles are
    // distinguished by `tenantId IS NULL` — but an operator should know it
    // exists before staff start being assigned the new global role.
    const collisions: Array<{ id: string; tenantId: string; name: string }> =
      await q.query(
        `SELECT id, "tenantId", name FROM "roles"
          WHERE lower(slug) = $1 AND "tenantId" IS NOT NULL`,
        [ROLE_SLUG],
      );
    if (collisions.length > 0) {
      console.warn(
        `[${NurseRole1730101000000.name}] ${collisions.length} tenant-scoped role(s) already use the slug ` +
          `"${ROLE_SLUG}" (tenant ids: ${collisions.map((c) => c.tenantId).join(', ')}). ` +
          'They are untouched by this migration (tenantId IS NOT NULL keeps them distinct from the new ' +
          'global role), but staff on those tenants will now see two different roles named/slugged "nurse" ' +
          'in role pickers — review before assigning the new global role there.',
      );
    }

    // ── The role row (guarded — a re-run, or a database where the seeder
    // already created it, inserts nothing). Text matches ROLES in
    // rbac.constants.ts exactly, so a later boot-time seedRoles() finds
    // nothing to reconcile. ────────────────────────────────────────────────
    await q.query(
      `INSERT INTO "roles" ("name", "slug", "description", "is_system")
       SELECT $1, $2::varchar, $3, true
       WHERE NOT EXISTS (
         SELECT 1 FROM "roles" WHERE "slug" = $2::varchar AND "tenantId" IS NULL
       )`,
      [ROLE_NAME, ROLE_SLUG, ROLE_DESCRIPTION],
    );

    // ── Every permission this role grants. Most already exist (shared with
    // other roles); the two NEW_PERMISSION_SLUGS do not, on any database that
    // migrates before first boot. Without this loop the grant loop below
    // would silently insert zero rows for them.
    for (const p of GRANTS) {
      await q.query(
        `INSERT INTO "permissions" ("name", "slug", "module", "scope", "risk_level")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO NOTHING`,
        [p.name, p.slug, p.module, p.scope, p.risk],
      );
    }

    // ── The grant matrix. Existence-checked rather than ON CONFLICT: the
    // (roleId, permissionId) pair carries no unique constraint to conflict on
    // in a migrated (non-synchronize) database.
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

    // ── Prove it landed. A role that reaches production with a partial grant
    // set is worse than one that never deployed: staff get created against it
    // and then cannot work. Fail the migration instead.
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
        `${NurseRole1730101000000.name}: ${missing.c} of ${GRANTS.length} expected grant(s) are still ` +
          'missing after the insert loop — investigate before considering this migration applied.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG, NEW_PERMISSION_SLUGS } = NurseRole1730101000000;

    // ── Refuse if any real user still holds this role. Removing it under
    // them would silently revoke every nurse's dashboard access — a fully
    // reversible migration must not do that unattended; the operator has to
    // reassign those users first.
    const [{ c: assigned }] = (await q.query(
      `SELECT COUNT(*)::int AS c
         FROM "user_roles" ur
         JOIN "roles" r ON r.id = ur."roleId"
        WHERE r.slug = $1 AND r."tenantId" IS NULL`,
      [ROLE_SLUG],
    )) as [{ c: number }];

    if (Number(assigned) > 0) {
      throw new Error(
        `${NurseRole1730101000000.name}.down(): refusing to revert — ${assigned} user(s) are still assigned ` +
          'the "nurse" role. Reassign or remove them first.',
      );
    }

    // Grants first (FK), then the role row.
    await q.query(
      `DELETE FROM "role_permissions" rp
        USING "roles" r
        WHERE rp."roleId" = r.id AND r.slug = $1 AND r."tenantId" IS NULL`,
      [ROLE_SLUG],
    );
    await q.query(
      `DELETE FROM "roles" WHERE "slug" = $1 AND "tenantId" IS NULL`,
      [ROLE_SLUG],
    );

    // ── Unlike the shared, pre-existing slugs BranchManagerRole grants (left
    // behind for other roles), the two slugs below were CREATED by this
    // migration, so down() must fully retire them: strip their grants from
    // every remaining role first (a tenant could have granted the
    // non-reserved `appointments.status.update` to a custom role since this
    // migration ran), then delete the permission rows themselves.
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
