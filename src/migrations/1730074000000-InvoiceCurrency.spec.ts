import { InvoiceCurrency1730074000000 } from './1730074000000-InvoiceCurrency';

const sqlOf = async (
  run: (q: { query: jest.Mock }) => Promise<void>,
  responses: unknown[] = [],
) => {
  const query = jest.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  query.mockResolvedValue([]);
  await run({ query } as never);
  return query.mock.calls.map(([statement]) => statement as string);
};

describe('InvoiceCurrency migration', () => {
  const NO_MISMATCH_RUN = [
    [], // ADD COLUMN
    [], // mismatch report
    [{ c: 0 }], // missing tenant_settings check
    [[], 0], // backfill batch — drains immediately
    [{ c: 0 }], // remaining-NULL check
  ];

  it('adds the currency column', async () => {
    const statements = await sqlOf(
      (q) => new InvoiceCurrency1730074000000().up(q as never),
      NO_MISMATCH_RUN,
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "currency" varchar(3)',
    );
  });

  it('logs the per-tenant mismatch report BEFORE the backfill runs', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await sqlOf(
      (q) => new InvoiceCurrency1730074000000().up(q as never),
      [
        [],
        [
          {
            tenant_id: 't1',
            tenant_name: 'Clinic One',
            tenant_currency: 'SAR',
            invoice_count: '5',
            mismatched_count: '2',
          },
        ],
        [{ c: 0 }],
        [[], 0],
        [{ c: 0 }],
      ],
    );
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('tenant=t1');
    expect(logged).toContain('*** MISMATCH ***');
    logSpy.mockRestore();
  });

  it('aborts before backfilling if a tenant has invoices but no tenant_settings row', async () => {
    await expect(
      sqlOf(
        (q) => new InvoiceCurrency1730074000000().up(q as never),
        [[], [], [{ c: 3 }]],
      ),
    ).rejects.toThrow(/no "tenant_settings" row/);
  });

  it('sets the column NOT NULL once every invoice is backfilled', async () => {
    const statements = await sqlOf(
      (q) => new InvoiceCurrency1730074000000().up(q as never),
      NO_MISMATCH_RUN,
    );
    expect(statements.at(-1)).toContain('ALTER COLUMN "currency" SET NOT NULL');
  });

  it('aborts if the backfill loop does not drain within the batch cap', async () => {
    const alwaysOneRow = [[], [], [{ c: 0 }]];
    const query = jest.fn();
    for (const r of alwaysOneRow) query.mockResolvedValueOnce(r);
    query.mockResolvedValue([[{ id: 'still-there' }], 1]); // never drains
    await expect(
      new InvoiceCurrency1730074000000().up({ query } as never),
    ).rejects.toThrow(/did not drain after/);
  });

  it('aborts if rows remain NULL after the backfill loop somehow drains early', async () => {
    await expect(
      sqlOf(
        (q) => new InvoiceCurrency1730074000000().up(q as never),
        [[], [], [{ c: 0 }], [[], 0], [{ c: 4 }]],
      ),
    ).rejects.toThrow(/still have a NULL currency/);
  });

  it('down drops only the currency column', async () => {
    const statements = await sqlOf((q) =>
      new InvoiceCurrency1730074000000().down(q as never),
    );
    expect(statements[0]).toBe(
      'ALTER TABLE "invoices" DROP COLUMN IF EXISTS "currency"',
    );
  });
});
