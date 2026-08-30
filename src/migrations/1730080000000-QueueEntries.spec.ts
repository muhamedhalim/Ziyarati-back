import { QueueEntries1730080000000 } from './1730080000000-QueueEntries';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('QueueEntries migration (T168)', () => {
  it('creates queue_entries with the FR-Q005 partial-unique double-check-in-refusal constraint', async () => {
    const sql = await sqlOf((q) =>
      new QueueEntries1730080000000().up(q as never),
    );

    expect(sql).toContain('CREATE TABLE "queue_entries"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "UQ_queue_entries_appointment_live"',
    );
    expect(sql).toContain('ON "queue_entries" ("tenantId", "appointmentId")');
    expect(sql).toContain(
      `WHERE "state" NOT IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')`,
    );
  });

  it('creates the live-board and practitioner-view indexes', async () => {
    const sql = await sqlOf((q) =>
      new QueueEntries1730080000000().up(q as never),
    );

    expect(sql).toContain(
      'CREATE INDEX "IDX_queue_entries_live" ON "queue_entries" ("tenantId", "branchId", "business_date", "state")',
    );
    expect(sql).toContain(
      'CREATE INDEX "IDX_queue_entries_staff" ON "queue_entries" ("tenantId", "branchId", "business_date", "staffId")',
    );
  });

  it('down drops the table', async () => {
    const sql = await sqlOf((q) =>
      new QueueEntries1730080000000().down(q as never),
    );
    expect(sql).toContain('DROP TABLE IF EXISTS "queue_entries"');
  });
});
