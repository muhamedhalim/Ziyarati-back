import { SupportTicketTimestampTzFix1730027100000 } from './1730027100000-SupportTicketTimestampTzFix';

describe('SupportTicketTimestampTzFix migration', () => {
  it('converts created_at/updated_at to timestamptz, reinterpreting existing naive values as UTC', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new SupportTicketTimestampTzFix1730027100000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('"support_tickets"');
    expect(sql).toContain('ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE \'UTC\'');
    expect(sql).toContain('ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE \'UTC\'');
    expect(sql).toContain('"support_ticket_events"');
  });

  it('down converts back to naive timestamp without shifting the represented instant', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new SupportTicketTimestampTzFix1730027100000().down({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE \'UTC\'');
  });
});
