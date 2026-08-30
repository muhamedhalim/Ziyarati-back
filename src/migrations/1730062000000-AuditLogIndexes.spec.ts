import { AuditLogIndexes1730062000000 } from './1730062000000-AuditLogIndexes';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([{ indisvalid: true }]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('AuditLogIndexes migration', () => {
  it('builds all three indexes CONCURRENTLY, out of a transaction', async () => {
    expect(new AuditLogIndexes1730062000000().transaction).toBe(false);
    const sql = await sqlOf((q) => new AuditLogIndexes1730062000000().up(q as never));

    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_created"',
    );
    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_action_created"',
    );
    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_entity"',
    );
  });

  it('throws if a built index is not valid', async () => {
    const query = jest.fn().mockResolvedValue([{ indisvalid: false }]);
    await expect(
      new AuditLogIndexes1730062000000().up({ query } as never),
    ).rejects.toThrow(/NOT valid/);
  });

  it('down drops all three indexes', async () => {
    const sql = await sqlOf((q) => new AuditLogIndexes1730062000000().down(q as never));
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_audit_logs_tenant_created"');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_audit_logs_tenant_action_created"');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_audit_logs_tenant_entity"');
  });
});
