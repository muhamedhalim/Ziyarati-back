import { ReleaseSeatsOfRemovedStaff1730115000000 as Migration } from './1730115000000-ReleaseSeatsOfRemovedStaff';

describe('ReleaseSeatsOfRemovedStaff migration', () => {
  const run = async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new Migration().up({ query } as any);
    return query.mock.calls.map(([sql]) => sql as string);
  };

  it('revokes refresh tokens BEFORE soft-deleting the users, nothing else', async () => {
    const [tokens, users, ...rest] = await run();
    expect(rest).toEqual([]);
    expect(tokens).toMatch(
      /UPDATE "refresh_tokens"\s+SET "revoked_at" = now\(\)/,
    );
    expect(tokens).toMatch(/"revoked_at" IS NULL/);
    expect(users).toMatch(/UPDATE "users"\s+SET "deleted_at" = now\(\)/);
    expect(`${tokens}${users}`).not.toMatch(/DELETE\s+FROM/i);
  });

  it.each(['refresh_tokens', 'users'])(
    'scopes the %s update to the orphaned-user set',
    async (table) => {
      const sql = (await run()).find((s) => s.includes(`UPDATE "${table}"`))!;
      expect(sql).toContain(Migration.ORPHANED_USERS_SQL);
    },
  );

  describe('orphaned-user predicate', () => {
    const sql = Migration.ORPHANED_USERS_SQL.replace(/\s+/g, ' ');

    it('only considers live, tenant-bound accounts (idempotent; never platform users)', () => {
      expect(sql).toContain('u."deleted_at" IS NULL');
      expect(sql).toContain('u."tenantId" IS NOT NULL');
    });

    it('requires a staff profile to exist and none to be live', () => {
      expect(sql).toContain(
        'AND EXISTS ( SELECT 1 FROM "staff_profiles" sp WHERE sp."user_id" = u."id")',
      );
      expect(sql).toContain(
        'AND NOT EXISTS ( SELECT 1 FROM "staff_profiles" sp WHERE sp."user_id" = u."id" AND sp."deleted_at" IS NULL)',
      );
    });

    it('never matches an owner or super admin', () => {
      expect(sql).toMatch(
        /NOT EXISTS \( SELECT 1 FROM "user_roles" ur JOIN "roles" r ON r\."id" = ur\."roleId" WHERE ur\."userId" = u\."id" AND r\."slug" IN \('owner', 'super_admin'\)\)/,
      );
    });
  });

  it('down() is a no-op (a removed account is never resurrected)', async () => {
    await expect(new Migration().down()).resolves.toBeUndefined();
  });
});
