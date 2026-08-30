import { PatientActionLinks1730063000000 } from './1730063000000-PatientActionLinks';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('PatientActionLinks migration', () => {
  it('creates the table with all four required constraints', async () => {
    const sql = await sqlOf((q) =>
      new PatientActionLinks1730063000000().up(q as never),
    );

    expect(sql).toContain('CREATE TABLE "patient_action_links"');
    expect(sql).toContain(
      'CONSTRAINT "UQ_patient_action_links_token_digest" UNIQUE ("token_digest")',
    );
    expect(sql).toContain(
      `CONSTRAINT "patient_action_links_waitlist_offer_required" CHECK\n          ("purpose" <> 'WAITLIST_OFFER' OR "waitlist_offer" IS NOT NULL)`,
    );
    expect(sql).toContain(
      'CONSTRAINT "FK_patient_action_links_appointment" FOREIGN KEY ("appointmentId")\n          REFERENCES "appointments" ("id") ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'CREATE INDEX "IDX_patient_action_links_appointment_purpose" ON "patient_action_links" ("appointmentId", "purpose")',
    );
    expect(sql).toContain(
      'CREATE INDEX "IDX_patient_action_links_expires_at" ON "patient_action_links" ("expires_at")',
    );
  });

  it('never creates a foreign key to waitlist_offers — T156 adds it once that table exists', async () => {
    const sql = await sqlOf((q) =>
      new PatientActionLinks1730063000000().up(q as never),
    );
    expect(sql).not.toMatch(/REFERENCES "waitlist_offers"/);
  });

  it('down drops the table', async () => {
    const sql = await sqlOf((q) =>
      new PatientActionLinks1730063000000().down(q as never),
    );
    expect(sql).toContain('DROP TABLE IF EXISTS "patient_action_links"');
  });
});
