import { TenantSettingSelfServiceAndReminders1730064000000 } from './1730064000000-TenantSettingSelfServiceAndReminders';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('TenantSettingSelfServiceAndReminders migration', () => {
  it('adds all four columns, fail-closed defaults', async () => {
    const sql = await sqlOf((q) =>
      new TenantSettingSelfServiceAndReminders1730064000000().up(q as never),
    );

    expect(sql).toContain(
      '"self_cancellation_enabled" boolean NOT NULL DEFAULT false',
    );
    expect(sql).toContain(
      '"self_reschedule_enabled" boolean NOT NULL DEFAULT false',
    );
    expect(sql).toContain('"reminders_enabled" boolean NOT NULL DEFAULT false');
    expect(sql).toContain(
      `"reminder_lead_minutes" integer[] NOT NULL DEFAULT '{}'`,
    );
  });

  it('down drops all four columns', async () => {
    const sql = await sqlOf((q) =>
      new TenantSettingSelfServiceAndReminders1730064000000().down(
        q as never,
      ),
    );
    for (const column of [
      'reminder_lead_minutes',
      'reminders_enabled',
      'self_reschedule_enabled',
      'self_cancellation_enabled',
    ]) {
      expect(sql).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
  });
});
