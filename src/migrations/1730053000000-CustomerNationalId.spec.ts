import { CustomerNationalId1730053000000 } from './1730053000000-CustomerNationalId';

describe('CustomerNationalId migration', () => {
  it('adds a nullable national_id column and a partial tenant-scoped unique index', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new CustomerNationalId1730053000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(
      'ALTER TABLE "customers" ADD COLUMN "national_id" character varying(50)',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "UQ_customers_tenant_national_id" ON "customers" ("tenantId", "national_id") WHERE "national_id" IS NOT NULL',
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
