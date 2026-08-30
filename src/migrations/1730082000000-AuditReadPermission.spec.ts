import { AuditReadPermission1730082000000 } from './1730082000000-AuditReadPermission';

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

describe('AuditReadPermission migration (T192, FR-U009)', () => {
  // 1 permission insert, 2 grant inserts, then the verification SELECT.
  const CLEAN_RUN = [[], [], [], [{ c: 0 }]];

  it('seeds the audit.read permission catalog row', async () => {
    const calls = await sqlOf(
      (q) => new AuditReadPermission1730082000000().up(q as never),
      CLEAN_RUN,
    );
    expect(calls[0].statement).toContain('INSERT INTO "permissions"');
    expect(calls[0].params).toContain('audit.read');
  });

  it('grants exactly owner+manager audit.read', async () => {
    const calls = await sqlOf(
      (q) => new AuditReadPermission1730082000000().up(q as never),
      CLEAN_RUN,
    );
    const grantCalls = calls.slice(1, 3);
    const pairs = grantCalls.map((c) => c.params as [string, string]);

    expect(pairs).toContainEqual(['owner', 'audit.read']);
    expect(pairs).toContainEqual(['manager', 'audit.read']);

    // Reception and doctor NEVER appear (FR-U009 — surface absent, not just refused).
    expect(pairs.some(([role]) => role === 'receptionist')).toBe(false);
    expect(pairs.some(([role]) => role === 'doctor')).toBe(false);
  });

  it('grant inserts are existence-checked (NOT EXISTS), never a bare INSERT — idempotent on re-run', async () => {
    const calls = await sqlOf(
      (q) => new AuditReadPermission1730082000000().up(q as never),
      CLEAN_RUN,
    );
    for (const call of calls.slice(1, 3)) {
      expect(call.statement).toContain('NOT EXISTS');
    }
  });

  it('aborts if any expected grant is still missing after the insert loop', async () => {
    await expect(
      sqlOf(
        (q) => new AuditReadPermission1730082000000().up(q as never),
        [[], [], [], [{ c: 1 }]],
      ),
    ).rejects.toThrow(/expected grant\(s\) are still missing/);
  });

  it('down removes exactly the 2 grants this migration added, then the permission row', async () => {
    const calls = await sqlOf((q) =>
      new AuditReadPermission1730082000000().down(q as never),
    );
    const deleteRpCalls = calls.filter((c) =>
      c.statement.includes('DELETE FROM "role_permissions"'),
    );
    expect(deleteRpCalls).toHaveLength(2);
    expect(
      deleteRpCalls.some(
        (c) =>
          JSON.stringify(c.params) ===
          JSON.stringify(['receptionist', 'audit.read']),
      ),
    ).toBe(false);

    const deletePermCall = calls.find((c) =>
      c.statement.includes('DELETE FROM "permissions"'),
    );
    expect(deletePermCall?.params).toEqual(['audit.read']);
  });
});
