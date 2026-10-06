import { DataGovernance1730111000000 as Migration } from './1730111000000-DataGovernance';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

const run = async (fn: 'up' | 'down') => {
  const query = jest.fn().mockResolvedValue([]);
  await new Migration()[fn]({ query } as never);
  return query.mock.calls.map(([s]) => normalise(s as string));
};

describe('DataGovernance migration (residency plan P11 / P13)', () => {
  it('has a class name and `name` property that agree', () => {
    expect(new Migration().name).toBe('DataGovernance1730111000000');
  });

  it('creates both tables idempotently, with no foreign keys', async () => {
    const calls = await run('up');
    const tables = calls.filter((c) => c.startsWith('CREATE TABLE'));
    expect(tables).toHaveLength(2);
    for (const t of tables) {
      expect(t).toContain('IF NOT EXISTS');
      // The proof must outlive the tenant and the subject it describes.
      expect(t).not.toMatch(/REFERENCES|FOREIGN KEY/i);
    }
    expect(calls.join(' ')).toContain('"data_subject_requests"');
    expect(calls.join(' ')).toContain('"deletion_evidence"');
  });

  it('declares the same index names the entities do (so synchronize cannot drop them)', async () => {
    const sql = (await run('up')).join(' ');
    for (const idx of [
      'IDX_dsr_tenant_received',
      'IDX_dsr_tenant_customer',
      'IDX_deletion_evidence_tenant_created',
    ]) {
      expect(sql).toContain(`"${idx}"`);
    }
  });

  it('holds no column that could carry personal data beyond ids, enums, counts and a capped note', async () => {
    const sql = (await run('up')).join(' ');
    for (const forbidden of [
      '"email"',
      '"phone"',
      '"full_name"',
      '"national_id"',
    ]) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).toContain('"note" varchar(500)');
  });

  it('is reversible', async () => {
    const down = (await run('down')).join(' ');
    expect(down).toContain('DROP TABLE IF EXISTS "deletion_evidence"');
    expect(down).toContain('DROP TABLE IF EXISTS "data_subject_requests"');
  });
});
