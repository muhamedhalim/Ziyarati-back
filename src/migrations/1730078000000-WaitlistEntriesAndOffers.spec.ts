import { WaitlistEntriesAndOffers1730078000000 } from './1730078000000-WaitlistEntriesAndOffers';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query });
  return query.mock.calls.map(([statement]) => statement).join('\n');
};

describe('WaitlistEntriesAndOffers migration (T155)', () => {
  it('creates waitlist_entries with the FR-W013 partial-unique duplicate-refusal constraint', async () => {
    const sql = await sqlOf((q) =>
      new WaitlistEntriesAndOffers1730078000000().up(q as never),
    );

    expect(sql).toContain('CREATE TABLE "waitlist_entries"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "UQ_waitlist_entries_active_dup"',
    );
    expect(sql).toContain(
      'ON "waitlist_entries" ("tenantId", "customerId", "serviceId")',
    );
    expect(sql).toContain(`WHERE "state" IN ('WAITING', 'OFFERED')`);
  });

  it('creates waitlist_offers with the one-live-offer-per-entry-per-slot constraint', async () => {
    const sql = await sqlOf((q) =>
      new WaitlistEntriesAndOffers1730078000000().up(q as never),
    );

    expect(sql).toContain('CREATE TABLE "waitlist_offers"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "UQ_waitlist_offers_entry_pending_slot"',
    );
    expect(sql).toContain('ON "waitlist_offers" ("entryId", "start_at")');
    expect(sql).toContain(`WHERE "state" = 'PENDING'`);
  });

  it('completes the patient_action_links.waitlist_offer FK now that its target exists', async () => {
    const sql = await sqlOf((q) =>
      new WaitlistEntriesAndOffers1730078000000().up(q as never),
    );
    expect(sql).toContain(
      'ADD CONSTRAINT "FK_patient_action_links_waitlist_offer"',
    );
    expect(sql).toContain('REFERENCES "waitlist_offers" ("id")');
  });

  it('down drops both tables and the completed FK, in FK-safe order', async () => {
    const sql = await sqlOf((q) =>
      new WaitlistEntriesAndOffers1730078000000().down(q as never),
    );
    const fkIdx = sql.indexOf('FK_patient_action_links_waitlist_offer');
    const offersIdx = sql.indexOf('DROP TABLE IF EXISTS "waitlist_offers"');
    const entriesIdx = sql.indexOf('DROP TABLE IF EXISTS "waitlist_entries"');
    expect(fkIdx).toBeGreaterThanOrEqual(0);
    expect(offersIdx).toBeGreaterThan(fkIdx);
    expect(entriesIdx).toBeGreaterThan(offersIdx);
  });
});
