import { ClinicalPermissionsAndRoles1730077000000 } from './1730077000000-ClinicalPermissionsAndRoles';

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

describe('ClinicalPermissionsAndRoles migration (T105 — BREAKING, FR-H010b/c/f)', () => {
  // 2 permission inserts, 7 grant inserts, then the verification SELECT.
  const CLEAN_RUN = [[], [], [], [], [], [], [], [], [], [{ c: 0 }]];

  it('seeds the two permission catalog rows', async () => {
    const calls = await sqlOf(
      (q) => new ClinicalPermissionsAndRoles1730077000000().up(q as never),
      CLEAN_RUN,
    );
    expect(calls[0].statement).toContain('INSERT INTO "permissions"');
    expect(calls[0].params).toContain('clinical.records.read');
    expect(calls[1].statement).toContain('INSERT INTO "permissions"');
    expect(calls[1].params).toContain('clinical.records.manage');
  });

  it('grants exactly doctor+owner+manager the clinical slugs, and crm.customers.read to doctor only', async () => {
    const calls = await sqlOf(
      (q) => new ClinicalPermissionsAndRoles1730077000000().up(q as never),
      CLEAN_RUN,
    );
    const grantCalls = calls.slice(2, 9);
    const pairs = grantCalls.map((c) => c.params as [string, string]);

    expect(pairs).toContainEqual(['doctor', 'clinical.records.read']);
    expect(pairs).toContainEqual(['doctor', 'clinical.records.manage']);
    expect(pairs).toContainEqual(['doctor', 'crm.customers.read']);
    expect(pairs).toContainEqual(['owner', 'clinical.records.read']);
    expect(pairs).toContainEqual(['owner', 'clinical.records.manage']);
    expect(pairs).toContainEqual(['manager', 'clinical.records.read']);
    expect(pairs).toContainEqual(['manager', 'clinical.records.manage']);

    // Reception NEVER appears (FR-H010b).
    expect(pairs.some(([role]) => role === 'receptionist')).toBe(false);
  });

  it('grant inserts are existence-checked (NOT EXISTS), never a bare INSERT — idempotent on re-run', async () => {
    const calls = await sqlOf(
      (q) => new ClinicalPermissionsAndRoles1730077000000().up(q as never),
      CLEAN_RUN,
    );
    for (const call of calls.slice(2, 9)) {
      expect(call.statement).toContain('NOT EXISTS');
    }
  });

  it('aborts if any expected grant is still missing after the insert loop', async () => {
    await expect(
      sqlOf(
        (q) => new ClinicalPermissionsAndRoles1730077000000().up(q as never),
        [[], [], [], [], [], [], [], [], [], [{ c: 2 }]],
      ),
    ).rejects.toThrow(/expected grant\(s\) are still missing/);
  });

  it('down removes exactly the 7 grants this migration added, then the 2 permission rows', async () => {
    const calls = await sqlOf((q) =>
      new ClinicalPermissionsAndRoles1730077000000().down(q as never),
    );
    const deleteRpCalls = calls.filter((c) =>
      c.statement.includes('DELETE FROM "role_permissions"'),
    );
    expect(deleteRpCalls).toHaveLength(7);
    expect(
      deleteRpCalls.some(
        (c) =>
          JSON.stringify(c.params) ===
          JSON.stringify(['receptionist', 'clinical.records.read']),
      ),
    ).toBe(false);

    const deletePermCall = calls.find((c) =>
      c.statement.includes('DELETE FROM "permissions"'),
    );
    expect(deletePermCall?.params).toEqual([
      'clinical.records.read',
      'clinical.records.manage',
    ]);
  });
});
