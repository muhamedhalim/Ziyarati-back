import { CustomerSegments1730071000000 } from './1730071000000-CustomerSegments';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([{ indisvalid: true }]);
  await run({ query } as never);
  return query.mock.calls.map(([statement]) => statement as string);
};

describe('CustomerSegments migration (T120)', () => {
  it('creates the customer_segments table with a soft-delete-aware tenant+name uniqueness', async () => {
    const statements = await sqlOf((q) =>
      new CustomerSegments1730071000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).toContain('CREATE TABLE "customer_segments"');
    expect(joined).toContain('UQ_customer_segments_tenant_name_live');
    expect(joined).toContain('WHERE "deleted_at" IS NULL');
  });

  it('adds a nullable campaigns.segment_id FK, never touching the legacy segment jsonb column', async () => {
    const statements = await sqlOf((q) =>
      new CustomerSegments1730071000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).toContain(
      'ALTER TABLE "campaigns" ADD COLUMN "segment_id" uuid',
    );
    expect(joined).not.toContain('"segment" jsonb');
    expect(joined).not.toMatch(/DROP COLUMN "segment"/);
  });

  it('builds all three indexes CONCURRENTLY and verifies validity after each', async () => {
    const statements = await sqlOf((q) =>
      new CustomerSegments1730071000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).toContain('IDX_appointment_services_tenant_service');
    expect(joined).toContain('IDX_customers_tenant_created');
    expect(joined).toContain('IDX_customers_tenant_birthday');
    for (const stmt of statements.filter((s) => s.includes('CREATE INDEX'))) {
      expect(stmt).toContain('CONCURRENTLY');
    }
  });

  it('runs with transaction = false (CONCURRENTLY cannot run inside one)', () => {
    expect(new CustomerSegments1730071000000().transaction).toBe(false);
  });

  it('throws if a CONCURRENTLY index build did not validate', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce(undefined) // unique index
      .mockResolvedValueOnce(undefined) // ADD COLUMN
      .mockResolvedValueOnce(undefined) // ADD CONSTRAINT
      .mockResolvedValueOnce(undefined) // CREATE INDEX CONCURRENTLY (appointment_services)
      .mockResolvedValueOnce([{ indisvalid: false }]); // assertValid fails
    await expect(
      new CustomerSegments1730071000000().up({ query } as never),
    ).rejects.toThrow(/NOT valid/);
  });

  it('down reverses in FK-safe order: indexes, campaigns FK/column, then the table', async () => {
    const statements = await sqlOf((q) =>
      new CustomerSegments1730071000000().down(q as never),
    );
    expect(statements[0]).toContain(
      'DROP INDEX IF EXISTS "IDX_customers_tenant_birthday"',
    );
    expect(statements[3]).toContain(
      'DROP CONSTRAINT IF EXISTS "FK_campaigns_segment"',
    );
    expect(statements[4]).toContain('DROP COLUMN IF EXISTS "segment_id"');
    expect(statements[5]).toContain('DROP TABLE IF EXISTS "customer_segments"');
  });
});
