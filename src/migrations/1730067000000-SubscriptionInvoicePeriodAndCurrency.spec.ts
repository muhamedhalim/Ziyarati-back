import { SubscriptionInvoicePeriodAndCurrency1730067000000 } from './1730067000000-SubscriptionInvoicePeriodAndCurrency';

/**
 * Response order mirrors the EXACT query call sequence `up()` issues:
 *   1. ALTER TABLE ADD COLUMN (6 columns) — return value ignored
 *   2. Orphan check SELECT
 *   3. Platform default-currency SELECT
 *   4. Batch UPDATE...RETURNING loop (0 or more calls) — TUPLE `[rows, affectedCount]`
 *   5. Remaining-NULL COUNT SELECT
 *   6. ALTER TABLE SET NOT NULL — return value ignored
 *   7. CREATE UNIQUE INDEX CONCURRENTLY — return value ignored
 *   8. SELECT indisvalid (validity check)
 */
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

const HAPPY_PATH = [
  [], // 1. ALTER TABLE ADD COLUMN
  [], // 2. orphan check: none
  [{ currency: 'SAR' }], // 3. platform default currency
  [[], 0], // 4. batch loop: [rows, affectedCount] tuple — 0 rows → breaks immediately
  [{ c: 0 }], // 5. remaining NULL count
  [], // 6. ALTER ... SET NOT NULL
  [], // 7. CREATE UNIQUE INDEX CONCURRENTLY
  [{ indisvalid: true }], // 8. validity check
];

describe('SubscriptionInvoicePeriodAndCurrency migration', () => {
  it('adds the six new columns', async () => {
    const statements = await sqlOf(
      (q) =>
        new SubscriptionInvoicePeriodAndCurrency1730067000000().up(q as never),
      HAPPY_PATH,
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "period_start" timestamptz',
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "period_end" timestamptz',
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "currency" varchar(3)',
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0',
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "next_retry_at" timestamptz',
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "failure_class" varchar(64)',
    );
  });

  it('aborts before touching any row when an invoice references a missing subscription', async () => {
    await expect(
      sqlOf(
        (q) =>
          new SubscriptionInvoicePeriodAndCurrency1730067000000().up(
            q as never,
          ),
        [[], [{ id: 'orphan-invoice-1' }]], // 1. ALTER; 2. orphan check finds one
      ),
    ).rejects.toThrow(/reference a subscription_id.*that no longer exists/);
  });

  it('sets NOT NULL on all three backfilled columns after the loop drains', async () => {
    const statements = await sqlOf(
      (q) =>
        new SubscriptionInvoicePeriodAndCurrency1730067000000().up(q as never),
      HAPPY_PATH,
    );
    const setNotNull = statements.find((s) => s.includes('SET NOT NULL'));
    expect(setNotNull).toContain('ALTER COLUMN "period_start" SET NOT NULL');
    expect(setNotNull).toContain('ALTER COLUMN "period_end" SET NOT NULL');
    expect(setNotNull).toContain('ALTER COLUMN "currency" SET NOT NULL');
  });

  it('aborts if rows still have a NULL period_start after the backfill loop', async () => {
    await expect(
      sqlOf(
        (q) =>
          new SubscriptionInvoicePeriodAndCurrency1730067000000().up(
            q as never,
          ),
        [[], [], [{ currency: 'SAR' }], [[], 0], [{ c: 3 }]],
      ),
    ).rejects.toThrow(/3 row\(s\) still have a NULL period_start/);
  });

  it('aborts if the CONCURRENTLY index build is left invalid', async () => {
    await expect(
      sqlOf(
        (q) =>
          new SubscriptionInvoicePeriodAndCurrency1730067000000().up(
            q as never,
          ),
        [
          [],
          [],
          [{ currency: 'SAR' }],
          [[], 0],
          [{ c: 0 }],
          [],
          [],
          [{ indisvalid: false }],
        ],
      ),
    ).rejects.toThrow(/was created but is NOT valid/);
  });

  it('drains across multiple non-empty batches before stopping — regression guard for the [rows, affectedCount] tuple shape', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce([]); // 1. ALTER TABLE
    query.mockResolvedValueOnce([]); // 2. orphan check
    query.mockResolvedValueOnce([{ currency: 'SAR' }]); // 3. platform currency
    // Three real batches, then an empty one — `queryRunner.query()` returns
    // a `[rows, affectedCount]` TUPLE for RETURNING, never a plain array;
    // checking the tuple's own `.length` (always 2) instead of the rows
    // array's length previously looped forever even on a batch that
    // genuinely affected 0 rows — caught only by running this migration
    // against real Postgres, not by a mocked unit test alone.
    query.mockResolvedValueOnce([[{ id: 'a' }, { id: 'b' }], 2]); // 4a.
    query.mockResolvedValueOnce([[{ id: 'c' }], 1]); // 4b.
    query.mockResolvedValueOnce([[], 0]); // 4c. drains
    query.mockResolvedValueOnce([{ c: 0 }]); // 5. remaining NULL count
    query.mockResolvedValueOnce([]); // 6. ALTER ... SET NOT NULL
    query.mockResolvedValueOnce([]); // 7. CREATE UNIQUE INDEX CONCURRENTLY
    query.mockResolvedValueOnce([{ indisvalid: true }]); // 8. validity check

    await new SubscriptionInvoicePeriodAndCurrency1730067000000().up({
      query,
    } as never);

    const updateCalls = query.mock.calls.filter(([sql]) =>
      (sql as string).includes('WITH batch AS'),
    );
    expect(updateCalls).toHaveLength(3);
  });

  it('down drops the index and all six columns', async () => {
    const statements = await sqlOf((q) =>
      new SubscriptionInvoicePeriodAndCurrency1730067000000().down(q as never),
    );
    expect(statements[0]).toBe('DROP INDEX IF EXISTS "UQ_sub_invoice_period"');
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "period_start"');
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "period_end"');
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "currency"');
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "retry_count"');
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "next_retry_at"');
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "failure_class"');
  });

  it('does not run inside a transaction — CONCURRENTLY cannot', () => {
    expect(
      new SubscriptionInvoicePeriodAndCurrency1730067000000().transaction,
    ).toBe(false);
  });
});
