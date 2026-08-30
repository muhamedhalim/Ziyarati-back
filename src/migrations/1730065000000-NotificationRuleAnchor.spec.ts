import { NotificationRuleAnchor1730065000000 } from './1730065000000-NotificationRuleAnchor';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('NotificationRuleAnchor migration', () => {
  it('adds anchor NOT NULL DEFAULT AFTER_EVENT — every existing rule keeps identical scheduling behaviour', async () => {
    const sql = await sqlOf((q) =>
      new NotificationRuleAnchor1730065000000().up(q as never),
    );
    expect(sql).toContain(
      `ADD COLUMN IF NOT EXISTS "anchor" varchar(24) NOT NULL DEFAULT 'AFTER_EVENT'`,
    );
  });

  it('down drops the column', async () => {
    const sql = await sqlOf((q) =>
      new NotificationRuleAnchor1730065000000().down(q as never),
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS "anchor"');
  });
});
