import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform Customer Service (D2) — production must not depend on
 * `SEED_ON_STARTUP`, so this idempotent data migration inserts the
 * `platform_support` role, its 6 support-ticket permission slugs, and every
 * grant, matching `ROLE_PERMISSIONS` in `rbac.constants.ts` exactly. The
 * boot seeders (`roles.seed.ts` / `permissions.seed.ts` /
 * `role-permissions.seed.ts`) remain the ongoing source of truth for
 * reconciliation and development — because this migration inserts EXACTLY
 * what they would reconcile to, a subsequent seeder run is a no-op.
 *
 * DDL shapes verified against BaselineSchema (1700000000000):
 *  - `permissions` has `UNIQUE ("slug")` -> ON CONFLICT ("slug") DO NOTHING.
 *  - `role_permissions` has `UNIQUE ("roleId","permissionId")` -> ON CONFLICT
 *    DO NOTHING.
 *  - `roles` has NO unique constraint on `slug` (uniqueness is (slug, tenant)
 *    by convention only) -> guarded INSERT ... WHERE NOT EXISTS.
 *  - all three tables default `id` to `uuid_generate_v4()`.
 *
 * `super_admin` must receive the 4 platform slugs explicitly here because its
 * '*' mapping is expanded by the SEEDER, not by the database.
 */
export class PlatformSupportRoleAndPermissions1730034000000 implements MigrationInterface {
  name = 'PlatformSupportRoleAndPermissions1730034000000';

  public async up(q: QueryRunner): Promise<void> {
    // 1. Role (no unique constraint on slug -> guarded insert).
    await q.query(`
      INSERT INTO "roles" ("name", "slug", "description", "is_system")
      SELECT
        'Platform Customer Service',
        'platform_support',
        'ZiyaraTech support employee. Triages clinic support tickets across tenants. Cannot close tickets or access Super Admin functionality.',
        true
      WHERE NOT EXISTS (
        SELECT 1 FROM "roles" WHERE "slug" = 'platform_support' AND "tenantId" IS NULL
      )
    `);

    // 2. Permissions (unique slug).
    await q.query(`
      INSERT INTO "permissions" ("name", "slug", "module", "scope", "risk_level") VALUES
        ('Read platform support tickets (cross-tenant)', 'platform.support_tickets.read', 'support_tickets', 'platform', 'medium'),
        ('Triage platform support tickets (status/priority, cannot close)', 'platform.support_tickets.triage', 'support_tickets', 'platform', 'high'),
        ('Reply to / add internal notes on platform support tickets', 'platform.support_tickets.reply', 'support_tickets', 'platform', 'high'),
        ('Close platform support tickets', 'platform.support_tickets.close', 'support_tickets', 'platform', 'critical'),
        ('Reply to own support tickets', 'support_tickets.reply', 'support_tickets', 'tenant', 'medium'),
        ('Reopen own resolved support tickets ("Issue not resolved")', 'support_tickets.reopen', 'support_tickets', 'tenant', 'medium')
      ON CONFLICT ("slug") DO NOTHING
    `);

    // 3. Grants (unique (roleId, permissionId)).
    await q.query(`
      INSERT INTO "role_permissions" ("roleId", "permissionId")
      SELECT r.id, p.id FROM "roles" r, "permissions" p
      WHERE r."tenantId" IS NULL AND (
        (r.slug = 'platform_support' AND p.slug IN (
           'platform.support_tickets.read', 'platform.support_tickets.triage', 'platform.support_tickets.reply'))
        OR (r.slug IN ('owner', 'manager', 'receptionist')
            AND p.slug IN ('support_tickets.reply', 'support_tickets.reopen'))
        OR (r.slug = 'super_admin'
            AND p.slug IN ('platform.support_tickets.read', 'platform.support_tickets.triage',
                           'platform.support_tickets.reply', 'platform.support_tickets.close',
                           'support_tickets.reply', 'support_tickets.reopen'))
      )
      ON CONFLICT DO NOTHING
    `);
  }

  /**
   * Removes only the rows this migration could have created (grants, then the
   * 6 permissions, then the role) — safe to run even after the seeder has
   * since reconciled the same state, since every DELETE is scoped to the
   * exact slugs this migration owns.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM "role_permissions" rp
      USING "permissions" p
      WHERE rp."permissionId" = p.id
        AND p.slug IN (
          'platform.support_tickets.read', 'platform.support_tickets.triage',
          'platform.support_tickets.reply', 'platform.support_tickets.close',
          'support_tickets.reply', 'support_tickets.reopen'
        )
    `);
    await q.query(`
      DELETE FROM "permissions" WHERE "slug" IN (
        'platform.support_tickets.read', 'platform.support_tickets.triage',
        'platform.support_tickets.reply', 'platform.support_tickets.close',
        'support_tickets.reply', 'support_tickets.reopen'
      )
    `);
    await q.query(`
      DELETE FROM "roles" WHERE "slug" = 'platform_support' AND "tenantId" IS NULL
    `);
  }
}
