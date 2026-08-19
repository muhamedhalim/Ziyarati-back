import { AiCostEntryCacheWrite1730055000000 } from './1730055000000-AiCostEntryCacheWrite';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('AiCostEntryCacheWrite migration', () => {
  it('adds the cache-write token count and the rate that was applied to it', async () => {
    const sql = await sqlOf((q) =>
      new AiCostEntryCacheWrite1730055000000().up(q as never),
    );

    expect(sql).toContain(
      'ALTER TABLE ai_cost_entries ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL DEFAULT 0',
    );
    expect(sql).toContain(
      'ALTER TABLE ai_cost_entries ADD COLUMN IF NOT EXISTS cache_write_price_microusd_per_million varchar(32)',
    );
  });

  /**
   * The ledger's whole guarantee is that a written row keeps the snapshot it was
   * priced with. A migration that rewrote historical rows would break exactly
   * that — and there is no honest value to write, since the token counts for
   * those turns were never captured.
   */
  it('never backfills or rewrites an existing row', async () => {
    const sql = await sqlOf((q) =>
      new AiCostEntryCacheWrite1730055000000().up(q as never),
    );

    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it('is idempotent — re-running it is safe', async () => {
    const sql = await sqlOf((q) =>
      new AiCostEntryCacheWrite1730055000000().up(q as never),
    );

    const statements = sql.split('\n').filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).toContain('IF NOT EXISTS');
    }
  });

  it('down drops the rate before the token count, and guards both', async () => {
    const sql = await sqlOf((q) =>
      new AiCostEntryCacheWrite1730055000000().down(q as never),
    );

    expect(sql).toContain(
      'DROP COLUMN IF EXISTS cache_write_price_microusd_per_million',
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS cache_write_tokens');
    expect(sql.indexOf('cache_write_price_microusd_per_million')).toBeLessThan(
      sql.indexOf('DROP COLUMN IF EXISTS cache_write_tokens'),
    );
  });
});
