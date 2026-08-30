import { ExportJobs1730081000000 } from './1730081000000-ExportJobs';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('ExportJobs migration (T179)', () => {
  it('creates export_jobs with tenant/requestedBy FKs and the frozen filters/branch_scope columns', async () => {
    const sql = await sqlOf((q) =>
      new ExportJobs1730081000000().up(q as never),
    );

    expect(sql).toContain('CREATE TABLE "export_jobs"');
    expect(sql).toContain('"filters" jsonb NOT NULL');
    expect(sql).toContain('"branch_scope" jsonb');
    expect(sql).toContain(
      'CONSTRAINT "FK_export_jobs_tenant" FOREIGN KEY ("tenantId")',
    );
    expect(sql).toContain(
      'CONSTRAINT "FK_export_jobs_requested_by" FOREIGN KEY ("requestedById")',
    );
  });

  it('creates the (tenant, requestedBy, created_at DESC) list index and the (state, expires_at) sweep index', async () => {
    const sql = await sqlOf((q) =>
      new ExportJobs1730081000000().up(q as never),
    );

    expect(sql).toContain(
      'CREATE INDEX "IDX_export_jobs_tenant_requested_created" ON "export_jobs" ("tenantId", "requestedById", "created_at" DESC)',
    );
    expect(sql).toContain(
      'CREATE INDEX "IDX_export_jobs_state_expires" ON "export_jobs" ("state", "expires_at")',
    );
  });

  it('down drops the table', async () => {
    const sql = await sqlOf((q) =>
      new ExportJobs1730081000000().down(q as never),
    );
    expect(sql).toContain('DROP TABLE IF EXISTS "export_jobs"');
  });
});
