import { WhatsappAiControls1730113000000 as Migration } from './1730113000000-WhatsappAiControls';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

const runUp = async () => {
  const query = jest.fn().mockResolvedValue([]);
  await new Migration().up({ query } as never);
  return query.mock.calls.map(([s]) => normalise(s as string));
};

const find = (calls: string[], needle: string) =>
  calls.find((c) => c.includes(needle))!;

describe('WhatsappAiControls migration', () => {
  it('has a class name and `name` property that agree', () => {
    expect(new Migration().name).toBe('WhatsappAiControls1730113000000');
  });

  it('is purely additive and idempotent: every column uses ADD COLUMN IF NOT EXISTS, nothing is dropped, rewritten or backfilled', async () => {
    const calls = await runUp();

    for (const sql of calls) {
      expect(sql).not.toMatch(/\bDROP\b/i);
      // (`ON DELETE SET NULL` on the FK is a constraint rule, not a data change.)
      expect(sql).not.toMatch(/^UPDATE\b/i);
      expect(sql).not.toMatch(/\bDELETE FROM\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql.match(/ADD COLUMN/g)?.length).toBe(
        sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length,
      );
    }
  });

  it('conversations: DEFAULT-mode override, takeover deadline, and who/when — defaults reproduce today', async () => {
    const sql = find(await runUp(), 'ALTER TABLE "conversations"');

    expect(sql).toContain(`"ai_mode" varchar(16) NOT NULL DEFAULT 'DEFAULT'`);
    expect(sql).toContain(
      `CHECK ("ai_mode" IN ('DEFAULT','ENABLED','DISABLED'))`,
    );
    expect(sql).toContain('"ai_paused_until" timestamptz NULL');
    expect(sql).toContain('"ai_mode_changed_at" timestamptz NULL');
    expect(sql).toContain('"ai_mode_changed_by_id" uuid NULL');
    // A deleted user must not break the conversation.
    expect(sql).toContain('REFERENCES "users" ("id") ON DELETE SET NULL');
  });

  it('customers: nobody is excluded after the migration', async () => {
    const sql = find(await runUp(), 'ALTER TABLE "customers"');

    expect(sql).toContain(
      '"ai_replies_disabled" boolean NOT NULL DEFAULT false',
    );
    expect(sql).toContain('"ai_replies_disabled_at" timestamptz NULL');
  });

  it('tenant_settings: automatic takeover is OFF (0) and bounded to 0–1440', async () => {
    const sql = find(await runUp(), 'ALTER TABLE "tenant_settings"');

    expect(sql).toContain(
      '"ai_human_takeover_minutes" integer NOT NULL DEFAULT 0',
    );
    expect(sql).toContain('BETWEEN 0 AND 1440');
  });

  it('leaves the clinic switch alone — bot_enabled is not touched', async () => {
    for (const sql of await runUp()) {
      expect(sql).not.toContain('bot_enabled');
    }
  });

  it('down() never drops the columns (R-DB6): rolling back the code must not discard pauses and exclusions', async () => {
    const query = jest.fn();
    await new Migration().down();
    expect(query).not.toHaveBeenCalled();
  });
});
