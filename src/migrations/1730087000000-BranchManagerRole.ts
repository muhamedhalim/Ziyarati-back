import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Branch Manager — the RBAC catalogue's first BRANCH-scoped role.
 *
 * WHY A MIGRATION AND NOT JUST THE SEEDER
 * `BootstrapSeederService`'s own docblock names `SEED_ON_STARTUP=false` as the
 * RECOMMENDED production setting, so a role that exists only in
 * `rbac.constants.ts` would never reach a production database. This migration
 * therefore provisions the role, every permission row it grants, and the grant
 * matrix itself — self-sufficiently, exactly as
 * `ClinicalPermissionsAndRoles1730077000000` and
 * `PlatformSupportRoleAndPermissions1730034000000` do for theirs.
 *
 * WHY THE PERMISSION LIST IS EMBEDDED RATHER THAN IMPORTED
 * A migration is an immutable snapshot of an intent at a point in time. If it
 * imported `ROLE_PERMISSIONS` from the live contract, editing that contract
 * later would silently change what this already-applied migration *would have*
 * done, and the two would no longer describe the same historical state. The
 * list below was generated from the contract at authoring time and is frozen.
 * The boot-time `seedRolePermissions()` reconciler remains the mechanism that
 * keeps FUTURE contract edits in sync; this migration only guarantees the
 * grant is correct in the database immediately.
 *
 * WHAT MAKES THIS ROLE BRANCH-SCOPED
 * `branches.update_own` WITHOUT `branches.update`. That pair is the machine-
 * readable definition of "branch-restricted" (`isBranchRestricted` in
 * rbac.constants.ts), read by `BranchScopeService` to narrow appointments,
 * staff, the activity log and the dashboard summary server-side. It is not a
 * label — removing it from this grant list would silently make the role
 * tenant-wide.
 *
 * The migration also promotes `permissions.scope` for `branches.update_own`
 * from the default `'tenant'` to `'branch'`. That column is audit/display
 * metadata only (authorization never reads it), but the staff Permission
 * Preview renders the restriction FROM it, so it must be correct in the
 * database for the preview to tell the truth.
 *
 * IDEMPOTENT — every insert is existence-checked, so re-running is a no-op.
 * REVERSIBLE — `down()` removes this role's grants, the role row itself, and
 * restores the `scope` column. It deliberately does NOT delete permission
 * rows: every one of them predates this migration in the catalogue and is
 * load-bearing for other roles.
 */
export class BranchManagerRole1730087000000 implements MigrationInterface {
  name = 'BranchManagerRole1730087000000';

  private static readonly ROLE_SLUG = 'branch_manager';
  private static readonly ROLE_NAME = 'Branch Manager';
  private static readonly ROLE_DESCRIPTION =
    'Runs one branch. Sees and manages only the branch(es) they are assigned to — appointments, queue, schedules, patients and the branch activity log. No clinic finances, billing, settings or staff provisioning.';

  /** Frozen snapshot of ROLE_PERMISSIONS['branch_manager'] at authoring time. */
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
      slug: 'appointments.create',
      name: 'Create appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'appointments.read',
      name: 'Read appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'appointments.update',
      name: 'Update appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'appointments.reschedule',
      name: 'Reschedule appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'appointments.cancel',
      name: 'Cancel appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'appointments.manage_all',
      name: 'Manage all appointments',
      module: 'appointments',
      scope: 'tenant',
      risk: 'high',
    },
    {
      slug: 'reviews.read',
      name: 'Read customer reviews',
      module: 'reviews',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'reviews.manage',
      name: 'Manage / reply to reviews',
      module: 'reviews',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'customers.create',
      name: 'Create customers',
      module: 'customers',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'customers.read',
      name: 'Read customers',
      module: 'customers',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'customers.update',
      name: 'Update customers',
      module: 'customers',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'customers.manage',
      name: 'Manage customers',
      module: 'customers',
      scope: 'tenant',
      risk: 'high',
    },
    {
      slug: 'crm.customers.read',
      name: 'Read CRM customers',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'crm.customers.manage',
      name: 'Manage CRM customers',
      module: 'crm',
      scope: 'tenant',
      risk: 'high',
    },
    {
      slug: 'crm.notes.read',
      name: 'Read customer notes',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'crm.notes.manage',
      name: 'Manage customer notes',
      module: 'crm',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'crm.tags.read',
      name: 'Read customer tags',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'crm.tags.manage',
      name: 'Manage customer tags',
      module: 'crm',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'crm.files.read',
      name: 'Read customer files',
      module: 'crm',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'crm.files.manage',
      name: 'Manage customer files',
      module: 'crm',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'support_tickets.read',
      name: 'Read support tickets',
      module: 'support_tickets',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'support_tickets.create',
      name: 'Create support tickets',
      module: 'support_tickets',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'support_tickets.close',
      name: 'Close own resolved support tickets',
      module: 'support_tickets',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'support_tickets.reply',
      name: 'Reply to own support tickets',
      module: 'support_tickets',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'support_tickets.reopen',
      name: 'Reopen own resolved support tickets ("Issue not resolved")',
      module: 'support_tickets',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'services.read',
      name: 'Read services',
      module: 'services',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'staff.read',
      name: 'Read staff',
      module: 'staff',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'staff.schedule.manage',
      name: 'Manage staff schedules & working hours',
      module: 'staff',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'staff.timeoff.manage',
      name: 'Manage staff time off',
      module: 'staff',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'staff.rating.read',
      name: 'Read staff ratings',
      module: 'staff',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'scheduling.slots.read',
      name: 'Read calendar slots',
      module: 'scheduling',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'scheduling.slots.manage',
      name: 'Manage calendar slots',
      module: 'scheduling',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'scheduling.blocked.read',
      name: 'Read blocked slots',
      module: 'scheduling',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'scheduling.blocked.manage',
      name: 'Manage blocked slots',
      module: 'scheduling',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'scheduling.holidays.read',
      name: 'Read holidays',
      module: 'scheduling',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'scheduling.holidays.manage',
      name: 'Manage holidays',
      module: 'scheduling',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'scheduling.availability.read',
      name: 'Read availability',
      module: 'scheduling',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'notifications.read',
      name: 'Read notifications',
      module: 'notifications',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'campaigns.read',
      name: 'Read campaigns',
      module: 'campaigns',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'campaign_recipients.read',
      name: 'Read campaign recipients',
      module: 'campaigns',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'campaign_analytics.read',
      name: 'Read campaign analytics',
      module: 'campaigns',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'whatsapp.send',
      name: 'Send WhatsApp messages',
      module: 'whatsapp',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'whatsapp.accounts.read',
      name: 'Read WhatsApp accounts',
      module: 'whatsapp',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'whatsapp.templates.read',
      name: 'Read WhatsApp templates',
      module: 'whatsapp',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'whatsapp.contacts.read',
      name: 'Read WhatsApp contacts',
      module: 'whatsapp',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'whatsapp.contacts.manage',
      name: 'Manage WhatsApp contacts',
      module: 'whatsapp',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'whatsapp.analytics.read',
      name: 'Read WhatsApp analytics',
      module: 'whatsapp',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'conversations.read',
      name: 'Read conversations',
      module: 'conversations',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'conversations.manage',
      name: 'Manage conversations',
      module: 'conversations',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'messages.send',
      name: 'Send messages',
      module: 'conversations',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'messages.read',
      name: 'Read messages',
      module: 'conversations',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'participants.manage',
      name: 'Manage conversation participants',
      module: 'conversations',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'attachments.manage',
      name: 'Manage message attachments',
      module: 'conversations',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'analytics.read',
      name: 'Read conversation analytics',
      module: 'conversations',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'ai.conversations.read',
      name: 'Read AI conversations',
      module: 'ai',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'ai.handover.read',
      name: 'Read AI handover requests',
      module: 'ai',
      scope: 'tenant',
      risk: 'low',
    },
    {
      slug: 'ai.handover.manage',
      name: 'Manage AI handover requests',
      module: 'ai',
      scope: 'tenant',
      risk: 'medium',
    },
    {
      slug: 'branches.update_own',
      name: 'Update own assigned branch',
      module: 'branches',
      scope: 'branch',
      risk: 'low',
    },
    {
      slug: 'audit.read',
      name: 'Read clinic activity log',
      module: 'activity_log',
      scope: 'tenant',
      risk: 'medium',
    },
  ];

  public async up(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG, ROLE_NAME, ROLE_DESCRIPTION, GRANTS } =
      BranchManagerRole1730087000000;

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

    // ── Every permission this role grants. Most already exist (they are
    // shared with owner/manager), but on a migrate-before-first-boot
    // deployment NONE of them do — the catalogue is otherwise only created
    // by boot-time seedPermissions(). Without this loop the grant loop below
    // would silently insert zero rows and ship a role with no permissions.
    for (const p of GRANTS) {
      await q.query(
        `INSERT INTO "permissions" ("name", "slug", "module", "scope", "risk_level")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO NOTHING`,
        [p.name, p.slug, p.module, p.scope, p.risk],
      );
    }

    // ── branches.update_own moves to the 'branch' scope layer. Applied with
    // an explicit UPDATE (not just the INSERT above) because the row almost
    // certainly already exists with the default 'tenant' scope.
    await q.query(
      `UPDATE "permissions" SET "scope" = 'branch' WHERE "slug" = 'branches.update_own'`,
    );

    // ── The grant matrix. Existence-checked rather than ON CONFLICT: the
    // (roleId, permissionId) pair carries no unique constraint to conflict on.
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
        `${BranchManagerRole1730087000000.name}: ${missing.c} of ${GRANTS.length} expected grant(s) are still ` +
          'missing after the insert loop — investigate before considering this migration applied.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    const { ROLE_SLUG } = BranchManagerRole1730087000000;

    // Grants first (FK), then the role row. Permission rows are left alone —
    // all of them predate this migration and other roles depend on them.
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

    // Restore the metadata default. Reverting the code without reverting this
    // would leave the Permission Preview labelling a slug 'Branch-wide' with
    // nothing behind it.
    await q.query(
      `UPDATE "permissions" SET "scope" = 'tenant' WHERE "slug" = 'branches.update_own'`,
    );
  }
}
