import { WhatsappAiScheduleAndAssignment1730114000000 as Migration } from './1730114000000-WhatsappAiScheduleAndAssignment';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

const runUp = async () => {
  const query = jest.fn().mockResolvedValue([]);
  await new Migration().up({ query } as never);
  return query.mock.calls.map(([s]) => normalise(s as string));
};

describe('WhatsappAiScheduleAndAssignment migration', () => {
  it('has a class name and `name` property that agree', () => {
    expect(new Migration().name).toBe(
      'WhatsappAiScheduleAndAssignment1730114000000',
    );
  });

  it('is additive and idempotent — nothing dropped, rewritten or backfilled', async () => {
    const calls = await runUp();
    expect(calls).toHaveLength(1);
    const [sql] = calls;
    expect(sql).not.toMatch(/\bDROP\b|^UPDATE\b|\bDELETE\b|\bTRUNCATE\b/i);
    expect(sql.match(/ADD COLUMN/g)?.length).toBe(
      sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length,
    );
  });

  it('defaults reproduce today: ALWAYS and ALL, constrained to the known values', async () => {
    const [sql] = await runUp();
    expect(sql).toContain(
      `"ai_schedule_mode" varchar(24) NOT NULL DEFAULT 'ALWAYS'`,
    );
    expect(sql).toContain(
      `CHECK ("ai_schedule_mode" IN ('ALWAYS','WORKING_HOURS','OUTSIDE_WORKING_HOURS'))`,
    );
    expect(sql).toContain(
      `"ai_assignment_mode" varchar(16) NOT NULL DEFAULT 'ALL'`,
    );
    expect(sql).toContain(
      `CHECK ("ai_assignment_mode" IN ('ALL','ASSIGNED_ONLY'))`,
    );
  });

  it('leaves bot_enabled and the conversation columns alone', async () => {
    const [sql] = await runUp();
    expect(sql).not.toContain('bot_enabled');
    expect(sql).not.toContain('"conversations"');
  });

  it('down() never drops the columns (R-DB6)', async () => {
    await expect(new Migration().down()).resolves.toBeUndefined();
  });
});
