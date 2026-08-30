import { AppointmentActionOrigin1730063500000 } from './1730063500000-AppointmentActionOrigin';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('AppointmentActionOrigin migration', () => {
  it('adds origin NOT NULL DEFAULT STAFF to both tables — every historical row was staff-initiated', async () => {
    const sql = await sqlOf((q) =>
      new AppointmentActionOrigin1730063500000().up(q as never),
    );
    expect(sql).toContain(
      `ALTER TABLE "appointment_cancellations"\n        ADD COLUMN IF NOT EXISTS "origin" varchar(16) NOT NULL DEFAULT 'STAFF'`,
    );
    expect(sql).toContain(
      `ALTER TABLE "appointment_reschedules"\n        ADD COLUMN IF NOT EXISTS "origin" varchar(16) NOT NULL DEFAULT 'STAFF'`,
    );
  });

  it('down drops both columns', async () => {
    const sql = await sqlOf((q) =>
      new AppointmentActionOrigin1730063500000().down(q as never),
    );
    expect(sql).toContain(
      'ALTER TABLE "appointment_reschedules" DROP COLUMN IF EXISTS "origin"',
    );
    expect(sql).toContain(
      'ALTER TABLE "appointment_cancellations" DROP COLUMN IF EXISTS "origin"',
    );
  });
});
