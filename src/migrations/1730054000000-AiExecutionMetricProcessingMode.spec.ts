import { AiExecutionMetricProcessingMode1730054000000 } from './1730054000000-AiExecutionMetricProcessingMode';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('AiExecutionMetricProcessingMode migration', () => {
  it('adds the composed label and the two source dimensions separately', async () => {
    const sql = await sqlOf((q) =>
      new AiExecutionMetricProcessingMode1730054000000().up(q as never),
    );

    // The composed label answers "how was this processed" without a join; the
    // dimensions stay queryable on their own so a residency audit does not have
    // to parse a string.
    for (const column of [
      'processing_mode',
      'data_residency_required',
      'data_residency_region',
      'data_residency_reason',
    ]) {
      expect(sql).toContain(
        `ALTER TABLE "ai_execution_metrics" ADD COLUMN IF NOT EXISTS "${column}"`,
      );
    }
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_ai_execution_metrics_processing_mode"',
    );
  });

  it('adds every column as nullable — a pre-existing row predates the signal', async () => {
    const sql = await sqlOf((q) =>
      new AiExecutionMetricProcessingMode1730054000000().up(q as never),
    );

    // Stamping historical rows 'STANDARD' would assert something this migration
    // cannot verify: nothing recorded how those turns were actually processed.
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });

  it('down drops the index before the column it covers', async () => {
    const sql = await sqlOf((q) =>
      new AiExecutionMetricProcessingMode1730054000000().down(q as never),
    );

    expect(sql).toContain(
      'DROP INDEX IF EXISTS "IDX_ai_execution_metrics_processing_mode"',
    );
    expect(sql.indexOf('DROP INDEX')).toBeLessThan(
      sql.indexOf('DROP COLUMN IF EXISTS "processing_mode"'),
    );
  });
});
