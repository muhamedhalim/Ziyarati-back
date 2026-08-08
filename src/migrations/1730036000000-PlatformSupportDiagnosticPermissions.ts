import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Support Operations Console — the `platform.support.*` diagnostic permission
 * family (12 read-only + 3 safe actions), granted to `platform_support` and to
 * `super_admin`.
 *
 * Same contract as `PlatformSupportRoleAndPermissions1730034000000`, which this
 * builds on: production must not depend on `SEED_ON_STARTUP`, so the rows are
 * inserted by an idempotent data migration that matches
 * `PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS` / `ROLE_PERMISSIONS` in
 * `rbac.constants.ts` EXACTLY — so a subsequent seeder run is a no-op rather
 * than a fight. Names, modules and risk levels here mirror `PERMISSIONS` and
 * `RISK_OVERRIDES`; they are informational only and never influence
 * authorization (guards key off the slug alone).
 *
 * The role itself already exists (created by the 1730034000000 migration), so
 * this migration only adds permissions and grants.
 *
 * `super_admin` must receive every slug explicitly here because its '*'
 * mapping is expanded by the SEEDER, not by the database.
 */
export class PlatformSupportDiagnosticPermissions1730036000000
  implements MigrationInterface
{
  name = 'PlatformSupportDiagnosticPermissions1730036000000';

  /** Single source of truth for this migration's slug list (up + down). */
  private static readonly SLUGS = [
    'platform.support.clinics.read_basic',
    'platform.support.subscriptions.read',
    'platform.support.features.read',
    'platform.support.clinic_settings.read',
    'platform.support.integrations.read',
    'platform.support.notifications.read',
    'platform.support.jobs.read',
    'platform.support.audit.read',
    'platform.support.appointments.read_diagnostics',
    'platform.support.payments.read_diagnostics',
    'platform.support.ai.read_diagnostics',
    'platform.support.whatsapp.read_diagnostics',
    'platform.support.notifications.retry',
    'platform.support.email.resend',
    'platform.support.integrations.recheck',
  ];

  private static slugList(): string {
    return PlatformSupportDiagnosticPermissions1730036000000.SLUGS.map(
      (s) => `'${s}'`,
    ).join(', ');
  }

  public async up(q: QueryRunner): Promise<void> {
    // 1. Permissions (unique slug -> ON CONFLICT DO NOTHING).
    await q.query(`
      INSERT INTO "permissions" ("name", "slug", "module", "scope", "risk_level") VALUES
        ('Read a clinic support profile (basic operational identity)', 'platform.support.clinics.read_basic', 'support_diagnostics', 'platform', 'medium'),
        ('Read clinic subscription diagnostics (no pricing/cost)', 'platform.support.subscriptions.read', 'support_diagnostics', 'platform', 'medium'),
        ('Read clinic feature/module availability diagnostics', 'platform.support.features.read', 'support_diagnostics', 'platform', 'medium'),
        ('Read safe clinic operational configuration', 'platform.support.clinic_settings.read', 'support_diagnostics', 'platform', 'medium'),
        ('Read clinic integration status (no credentials)', 'platform.support.integrations.read', 'support_diagnostics', 'platform', 'medium'),
        ('Read clinic email/notification delivery history', 'platform.support.notifications.read', 'support_diagnostics', 'platform', 'high'),
        ('Read queue/worker health (no Redis administration)', 'platform.support.jobs.read', 'support_diagnostics', 'platform', 'medium'),
        ('Read sanitized clinic operational activity timeline', 'platform.support.audit.read', 'support_diagnostics', 'platform', 'medium'),
        ('Read appointment diagnostics (no medical data)', 'platform.support.appointments.read_diagnostics', 'support_diagnostics', 'platform', 'high'),
        ('Read payment diagnostics (no card data, fees or secrets)', 'platform.support.payments.read_diagnostics', 'support_diagnostics', 'platform', 'high'),
        ('Read AI diagnostics (no costs, prompts or provider keys)', 'platform.support.ai.read_diagnostics', 'support_diagnostics', 'platform', 'high'),
        ('Read WhatsApp diagnostics (no Meta tokens or secrets)', 'platform.support.whatsapp.read_diagnostics', 'support_diagnostics', 'platform', 'medium'),
        ('Retry one failed notification (safe, audited)', 'platform.support.notifications.retry', 'support_diagnostics', 'platform', 'high'),
        ('Resend one eligible transactional email (safe, audited)', 'platform.support.email.resend', 'support_diagnostics', 'platform', 'high'),
        ('Trigger a read-only integration health recheck (audited)', 'platform.support.integrations.recheck', 'support_diagnostics', 'platform', 'medium')
      ON CONFLICT ("slug") DO NOTHING
    `);

    // 2. Grants — platform_support AND super_admin receive the whole family.
    //    No tenant role receives any of it (these are RESERVED slugs).
    await q.query(`
      INSERT INTO "role_permissions" ("roleId", "permissionId")
      SELECT r.id, p.id FROM "roles" r, "permissions" p
      WHERE r."tenantId" IS NULL
        AND r.slug IN ('platform_support', 'super_admin')
        AND p.slug IN (${PlatformSupportDiagnosticPermissions1730036000000.slugList()})
      ON CONFLICT DO NOTHING
    `);
  }

  /**
   * Removes only the rows this migration could have created (grants, then the
   * 15 permissions) — safe to run even after the seeder has reconciled the
   * same state, since every DELETE is scoped to the exact slugs this migration
   * owns. The `platform_support` role itself belongs to the 1730034000000
   * migration and is deliberately left alone.
   */
  public async down(q: QueryRunner): Promise<void> {
    const slugs = PlatformSupportDiagnosticPermissions1730036000000.slugList();
    await q.query(`
      DELETE FROM "role_permissions" rp
      USING "permissions" p
      WHERE rp."permissionId" = p.id AND p.slug IN (${slugs})
    `);
    await q.query(`DELETE FROM "permissions" WHERE "slug" IN (${slugs})`);
  }
}
