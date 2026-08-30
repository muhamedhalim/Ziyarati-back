import { ScheduledNotificationDeliveryChannel1730065500000 } from './1730065500000-ScheduledNotificationDeliveryChannel';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('ScheduledNotificationDeliveryChannel migration', () => {
  it('adds both nullable columns', async () => {
    const sql = await sqlOf((q) =>
      new ScheduledNotificationDeliveryChannel1730065500000().up(q as never),
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "channel" varchar(16)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "skip_reason" varchar(40)');
    expect(sql).not.toMatch(/"channel".*NOT NULL/);
    expect(sql).not.toMatch(/"skip_reason".*NOT NULL/);
  });

  it('down drops both columns', async () => {
    const sql = await sqlOf((q) =>
      new ScheduledNotificationDeliveryChannel1730065500000().down(q as never),
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS "channel"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "skip_reason"');
  });
});
