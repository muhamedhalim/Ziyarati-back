import { CustomerNationalId1730053000000 } from './1730053000000-CustomerNationalId';

describe('CustomerNationalId migration', () => {
  it('adds a nullable national_id column and a partial tenant-scoped unique index', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new CustomerNationalId1730053000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    // IF NOT EXISTS guards (a dev environment running with
    // TYPEORM_SYNCHRONIZE=true can already have created this column/index
    // from the entity before this migration ever runs — see Feature 013
    // Phase 0, T005).
    expect(sql).toContain(
      'ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "national_id" character varying(50)',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "UQ_customers_tenant_national_id" ON "customers" ("tenantId", "national_id") WHERE "national_id" IS NOT NULL',
    );
    expect(sql).toContain(
      'IF NOT EXISTS (\n          SELECT 1 FROM pg_indexes',
    );
  });

  it('down drops the index then the column', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new CustomerNationalId1730053000000().down({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(
      'DROP INDEX IF EXISTS "UQ_customers_tenant_national_id"',
    );
    expect(sql).toContain('ALTER TABLE "customers" DROP COLUMN "national_id"');
  });
});
