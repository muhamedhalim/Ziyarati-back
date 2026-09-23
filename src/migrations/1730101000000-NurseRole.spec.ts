import { NurseRole1730101000000 } from './1730101000000-NurseRole';

const sqlOf = async (
  run: (q: { query: jest.Mock }) => Promise<void>,
  responses: unknown[] = [],
) => {
  const query = jest.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  query.mockResolvedValue([]);
  await run({ query } as never);
  return query.mock.calls.map(([statement, params]) => ({
    statement: statement as string,
    params,
  }));
};

const NURSE_PERMISSION_SLUGS = [
  'dashboard.access',
  'appointments.read',
  'appointments.status.update',
  'crm.customers.read',
  'crm.notes.read',
  'crm.tags.read',
  'crm.files.read',
  'clinical.records.read',
  'clinical.records.nursing',
  'staff.read_own',
];

describe('NurseRole migration', () => {
  // 1 collision pre-check + 1 role insert + 10 permission inserts +
  // 10 grant inserts + 1 verification SELECT = 23 calls.
  const CLEAN_RUN = [
    [], // 0: collision pre-check — no tenant-scoped "nurse" role
    [], // 1: role insert
    ...Array.from({ length: 10 }, () => []), // 2-11: 10 permission inserts
    ...Array.from({ length: 10 }, () => []), // 12-21: 10 grant inserts
    [{ c: 0 }], // 22: verification SELECT — nothing missing
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('checks for a tenant-scoped "nurse" role collision first, without mutating it', async () => {
    const calls = await sqlOf(
      (q) => new NurseRole1730101000000().up(q as never),
      CLEAN_RUN,
    );
    expect(calls[0].statement).toContain('SELECT id, "tenantId", name');
    expect(calls[0].statement).toContain('"tenantId" IS NOT NULL');
    expect(calls[0].params).toEqual(['nurse']);
  });

  it('warns (does not throw or mutate) when a tenant already has a role slugged "nurse"', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const collision = [{ id: 'r-1', tenantId: 't-1', name: 'Nurse (custom)' }];
    const responses = [collision, ...CLEAN_RUN.slice(1)];

    await expect(
      sqlOf((q) => new NurseRole1730101000000().up(q as never), responses),
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('t-1');
    // Only the pre-check SELECT and the ordinary up() writes run — no DELETE
    // or UPDATE targeting the colliding tenant role.
    const calls = await sqlOf(
      (q) => new NurseRole1730101000000().up(q as never),
      responses,
    );
    expect(
      calls.some((c) => c.statement.includes('r-1') || c.params?.includes('r-1')),
    ).toBe(false);
  });

  it('seeds the global role row guarded by NOT EXISTS', async () => {
    const calls = await sqlOf(
      (q) => new NurseRole1730101000000().up(q as never),
      CLEAN_RUN,
    );
    expect(calls[1].statement).toContain('INSERT INTO "roles"');
    expect(calls[1].statement).toContain('NOT EXISTS');
    expect(calls[1].params).toEqual([
      'Nurse',
      'nurse',
      expect.stringContaining('Clinical support staff'),
    ]);
  });

  it('seeds exactly the 10 nurse permission rows, ON CONFLICT DO NOTHING, including both new slugs', async () => {
    const calls = await sqlOf(
      (q) => new NurseRole1730101000000().up(q as never),
      CLEAN_RUN,
    );
    const permCalls = calls.slice(2, 12);
    expect(permCalls).toHaveLength(10);
    for (const call of permCalls) {
      expect(call.statement).toContain('INSERT INTO "permissions"');
      expect(call.statement).toContain('ON CONFLICT');
    }
    const slugs = permCalls.map((c) => (c.params as unknown[])[1]);
    expect(slugs.sort()).toEqual([...NURSE_PERMISSION_SLUGS].sort());
  });

  it('grants exactly the 10 nurse permissions, existence-checked (NOT EXISTS) — idempotent on re-run', async () => {
    const calls = await sqlOf(
      (q) => new NurseRole1730101000000().up(q as never),
      CLEAN_RUN,
    );
    const grantCalls = calls.slice(12, 22);
    expect(grantCalls).toHaveLength(10);
    const slugs = grantCalls.map((c) => (c.params as [string, string])[1]);
    expect(slugs.sort()).toEqual([...NURSE_PERMISSION_SLUGS].sort());
    for (const call of grantCalls) {
      expect(call.statement).toContain('INSERT INTO "role_permissions"');
      expect(call.statement).toContain('NOT EXISTS');
      expect((call.params as [string, string])[0]).toBe('nurse');
    }
  });

  it('never grants appointments.update, clinical.records.manage or crm.files.manage', async () => {
    const calls = await sqlOf(
      (q) => new NurseRole1730101000000().up(q as never),
      CLEAN_RUN,
    );
    const grantedSlugs = calls
      .slice(12, 22)
      .map((c) => (c.params as [string, string])[1]);
    expect(grantedSlugs).not.toContain('appointments.update');
    expect(grantedSlugs).not.toContain('clinical.records.manage');
    expect(grantedSlugs).not.toContain('crm.files.manage');
    expect(grantedSlugs).not.toContain('branches.update_own');
  });

  it('aborts if any expected grant is still missing after the insert loop', async () => {
    const responses = [...CLEAN_RUN.slice(0, -1), [{ c: 3 }]];
    await expect(
      sqlOf((q) => new NurseRole1730101000000().up(q as never), responses),
    ).rejects.toThrow(/expected grant\(s\) are still missing/);
  });

  describe('down', () => {
    it('refuses to revert while any user is still assigned the nurse role', async () => {
      await expect(
        sqlOf(
          (q) => new NurseRole1730101000000().down(q as never),
          [[{ c: 2 }]],
        ),
      ).rejects.toThrow(/refusing to revert/);
    });

    it('checks user_roles joined to the global nurse role before refusing/proceeding', async () => {
      const calls = await sqlOf(
        (q) => new NurseRole1730101000000().down(q as never),
        [[{ c: 0 }]],
      );
      expect(calls[0].statement).toContain('FROM "user_roles"');
      expect(calls[0].statement).toContain('"tenantId" IS NULL');
      expect(calls[0].params).toEqual(['nurse']);
    });

    it('removes the role grants and the role row, then fully retires both new permission slugs', async () => {
      const calls = await sqlOf(
        (q) => new NurseRole1730101000000().down(q as never),
        [[{ c: 0 }]],
      );
      expect(calls).toHaveLength(7);

      expect(calls[1].statement).toContain('DELETE FROM "role_permissions"');
      expect(calls[1].params).toEqual(['nurse']);

      expect(calls[2].statement).toContain('DELETE FROM "roles"');
      expect(calls[2].params).toEqual(['nurse']);

      const newSlugRpDeletes = [calls[3], calls[5]];
      const newSlugPermDeletes = [calls[4], calls[6]];

      const rpSlugs = newSlugRpDeletes.map((c) => (c.params as [string])[0]);
      expect(rpSlugs.sort()).toEqual(
        ['appointments.status.update', 'clinical.records.nursing'].sort(),
      );
      for (const call of newSlugRpDeletes) {
        expect(call.statement).toContain('DELETE FROM "role_permissions"');
        expect(call.statement).toContain('USING "permissions"');
      }

      const permSlugs = newSlugPermDeletes.map((c) => (c.params as [string])[0]);
      expect(permSlugs.sort()).toEqual(
        ['appointments.status.update', 'clinical.records.nursing'].sort(),
      );
      for (const call of newSlugPermDeletes) {
        expect(call.statement).toContain('DELETE FROM "permissions"');
      }

      // The two new slugs are deleted — never clinical.records.read (shared,
      // pre-existing, used by doctor/owner/manager and must survive).
      expect(rpSlugs).not.toContain('clinical.records.read');
      expect(permSlugs).not.toContain('clinical.records.read');
    });
  });
});
