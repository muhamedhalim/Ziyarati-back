import { PlatformSupportRoleAndPermissions1730034000000 } from './1730034000000-PlatformSupportRoleAndPermissions';

describe('PlatformSupportRoleAndPermissions migration', () => {
  it('up() inserts the role guarded by WHERE NOT EXISTS (roles has no unique constraint on slug)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformSupportRoleAndPermissions1730034000000().up({
      query,
    } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('INSERT INTO "roles"');
    expect(sql).toContain("'platform_support'");
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).toContain('"tenantId" IS NULL');
  });

  it('up() inserts exactly the 6 permission slugs with ON CONFLICT DO NOTHING', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformSupportRoleAndPermissions1730034000000().up({
      query,
    } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    for (const slug of [
      'platform.support_tickets.read',
      'platform.support_tickets.triage',
      'platform.support_tickets.reply',
      'platform.support_tickets.close',
      'support_tickets.reply',
      'support_tickets.reopen',
    ]) {
      expect(sql).toContain(`'${slug}'`);
    }
    expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it('up() grants platform_support exactly read/triage/reply, never close or dashboard.access', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformSupportRoleAndPermissions1730034000000().up({
      query,
    } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    const grantsStatement = query.mock.calls
      .map(([s]) => s)
      .find((s: string) => s.includes('INSERT INTO "role_permissions"'));
    expect(grantsStatement).toBeDefined();
    expect(grantsStatement).toContain("r.slug = 'platform_support'");
    expect(grantsStatement).toContain(
      "p.slug IN (\n           'platform.support_tickets.read', 'platform.support_tickets.triage', 'platform.support_tickets.reply')",
    );
    // The platform_support branch's own IN-list must not mention close or dashboard.access.
    const platformSupportBranch = grantsStatement!
      .split("r.slug = 'platform_support'")[1]
      .split(')')[0];
    expect(platformSupportBranch).not.toContain(
      'platform.support_tickets.close',
    );
    expect(platformSupportBranch).not.toContain('dashboard.access');
    expect(sql).toContain("r.slug IN ('owner', 'manager', 'receptionist')");
    expect(sql).toContain("r.slug = 'super_admin'");
  });

  it('up() grants super_admin all 4 platform slugs explicitly (the * wildcard is seeder-only, not DB-level)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformSupportRoleAndPermissions1730034000000().up({
      query,
    } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    const superAdminBranch = sql.split("r.slug = 'super_admin'")[1];

    expect(superAdminBranch).toContain('platform.support_tickets.read');
    expect(superAdminBranch).toContain('platform.support_tickets.triage');
    expect(superAdminBranch).toContain('platform.support_tickets.reply');
    expect(superAdminBranch).toContain('platform.support_tickets.close');
  });

  it('down() removes only the rows this migration could have created, in FK-safe order', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformSupportRoleAndPermissions1730034000000().down({
      query,
    } as any);
    const statements = query.mock.calls.map(([s]) => s as string);

    const grantsIdx = statements.findIndex((s) =>
      s.includes('DELETE FROM "role_permissions"'),
    );
    const permsIdx = statements.findIndex((s) =>
      s.includes('DELETE FROM "permissions"'),
    );
    const roleIdx = statements.findIndex((s) =>
      s.includes('DELETE FROM "roles"'),
    );

    expect(grantsIdx).toBeGreaterThanOrEqual(0);
    expect(permsIdx).toBeGreaterThan(grantsIdx);
    expect(roleIdx).toBeGreaterThan(permsIdx);
    expect(statements[roleIdx]).toContain("'platform_support'");
  });
});
