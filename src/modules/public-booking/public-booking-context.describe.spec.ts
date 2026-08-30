import { PublicBookingContextService } from './public-booking-context.service';

/**
 * `describeSelection` — the block pinned into every public turn's prompt.
 *
 * It exists because a tool result lives for exactly one turn: only USER and
 * ASSISTANT rows are persisted to `ai_messages`, so the ids recorded by the
 * `select_*` tools were never visible to the model again. This is what finally
 * shows them — and the reason it can be trusted is that it echoes NOTHING. Every
 * id is re-read through the same eligibility predicate the booking itself uses,
 * so these tests assert on the SQL that is actually issued, not on the session
 * that was handed in.
 */

const CONV_TENANT = 'guest-discovery-tenant';
const CONV = 'conv-1';
const PRINCIPAL = { id: 'guest-sub', guest: true } as never;

/** Routes each of `describeSelection`'s reads to a scripted answer. */
interface Rows {
  branch?: Record<string, unknown>[];
  clinic?: Record<string, unknown>[];
  city?: Record<string, unknown>[];
  services?: Record<string, unknown>[];
  doctor?: Record<string, unknown>[];
}

function build(session: Record<string, unknown>, rows: Rows = {}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM branches b')) return rows.branch ?? [];
    if (sql.includes('FROM tenants t')) return rows.clinic ?? [];
    if (sql.includes('FROM cities')) return rows.city ?? [];
    if (sql.includes('FROM services')) return rows.services ?? [];
    if (sql.includes('FROM staff_profiles')) return rows.doctor ?? [];
    return [];
  });
  const service = new PublicBookingContextService(
    { query } as never,
    { assertAccess: jest.fn().mockResolvedValue(undefined) } as never,
    { get: jest.fn().mockResolvedValue(session) } as never,
    {} as never,
  );
  return {
    describe: () => service.describeSelection(CONV_TENANT, CONV, PRINCIPAL),
    query,
  };
}

const BRANCH = {
  id: 'branch-1',
  name: 'Olaya',
  address: 'King Fahd Rd',
  tenant_id: 'clinic-a',
  city: 'الرياض',
};

describe('PublicBookingContextService.describeSelection', () => {
  it("states today's date even before anything has been selected", async () => {
    // The model has no clock. Asked for "tomorrow" it produced a date from its
    // training data — observed live as an availability lookup for 2023-10-29,
    // which returned nothing and was reported as "no appointments available".
    // A relative date can be the visitor's very first words, so the date is
    // stated from turn one.
    const f = build({ guestSubject: 'guest-sub' });

    const block = await f.describe();

    expect(block).toMatch(/today: \d{4}-\d{2}-\d{2}/);
    expect(block).toMatch(/never from memory/);
    expect(block).toMatch(/Nothing has been selected yet/);
  });

  it("uses the session's own timezone for that date", async () => {
    const f = build({ timezone: 'Asia/Riyadh' });

    await expect(f.describe()).resolves.toContain('Asia/Riyadh');
  });

  it('falls back to UTC rather than failing on an unusable timezone', async () => {
    const f = build({ timezone: 'Not/AZone' });

    const block = await f.describe();

    expect(block).toMatch(/today: \d{4}-\d{2}-\d{2}/);
  });

  it('states the clinic, its branch and where that branch is', async () => {
    const f = build(
      { selectedClinicId: 'clinic-a', selectedBranchId: 'branch-1' },
      { branch: [BRANCH], clinic: [{ name: 'Al Noor Medical' }] },
    );

    const block = await f.describe();

    expect(block).toContain('clinic: Al Noor Medical (id clinic-a)');
    expect(block).toContain('branch: Olaya');
    expect(block).toContain('الرياض');
    expect(block).toContain('King Fahd Rd');
  });

  it("states that bookability is the database's verdict, not the conversation's", async () => {
    // "Do not rely on Knowledge to prove that the clinic is available for
    // booking" — the block says where the verdict came from, so the model has
    // no reason to go looking for a second opinion.
    const f = build(
      { selectedClinicId: 'clinic-a' },
      { clinic: [{ name: 'Al Noor Medical' }] },
    );

    const block = await f.describe();

    expect(block).toMatch(/clinic bookability: CONFIRMED by the database/);
    expect(block).toMatch(/public booking enabled/);
  });

  it('tells the model the discovery steps are done and not to repeat them', async () => {
    // The literal ask: "Do not re-enter list_cities or rediscover the clinic
    // from scratch in every turn if the clinic has already been selected."
    const f = build(
      { selectedClinicId: 'clinic-a', selectedBranchId: 'branch-1' },
      { branch: [BRANCH], clinic: [{ name: 'Al Noor Medical' }] },
    );

    const block = await f.describe();

    expect(block).toMatch(/Do NOT call list_cities or search_clinics again/);
    expect(block).toMatch(/list_branch_services/);
  });

  it('re-proves the clinic every turn, so a mid-conversation opt-out drops out immediately', async () => {
    // The session still records the clinic; the database no longer accepts it
    // (opted out, deactivated or soft-deleted). It must be reported as CLEARED
    // rather than carried forward on the strength of what was recorded earlier.
    const f = build({ selectedClinicId: 'clinic-a' }, { clinic: [] });

    const block = await f.describe();

    expect(block).toContain('CLEARED');
    expect(block).toContain('clinic');
    expect(block).not.toContain('CONFIRMED');
  });

  it("never trusts the recorded clinic over the branch's real owner", async () => {
    // The pair can only diverge if something wrote a selection it did not
    // validate. Reporting half of it would be worse than reporting none.
    const f = build(
      { selectedClinicId: 'clinic-b', selectedBranchId: 'branch-1' },
      { branch: [BRANCH], clinic: [{ name: 'Clinic B' }] },
    );

    await expect(f.describe()).resolves.toBeNull();
  });

  it("scopes the service and doctor lookups to the branch's owning tenant", async () => {
    // Tenant isolation: the names shown are read under the tenant the DATABASE
    // says owns the branch, never under the conversation's own tenant and never
    // under an id the session merely claimed.
    const f = build(
      {
        selectedClinicId: 'clinic-a',
        selectedBranchId: 'branch-1',
        selectedServiceIds: ['svc-1'],
        selectedDoctorId: 'staff-1',
      },
      {
        branch: [BRANCH],
        clinic: [{ name: 'Al Noor Medical' }],
        services: [{ name: 'Consultation' }],
        doctor: [{ name: 'Dr Sara' }],
      },
    );

    const block = await f.describe();

    expect(block).toContain('services: Consultation');
    expect(block).toContain('doctor: Dr Sara');
    for (const [sql, params] of f.query.mock.calls) {
      if (
        sql.includes('FROM services') ||
        sql.includes('FROM staff_profiles')
      ) {
        expect(params[0]).toBe('clinic-a');
        expect(params[0]).not.toBe(CONV_TENANT);
      }
    }
  });

  it('degrades to no block rather than throwing when the conversation is not accessible', async () => {
    // A context that cannot be produced must not cost the visitor their reply.
    const service = new PublicBookingContextService(
      { query: jest.fn() } as never,
      { assertAccess: jest.fn().mockRejectedValue(new Error('nope')) } as never,
      { get: jest.fn() } as never,
      {} as never,
    );

    await expect(
      service.describeSelection(CONV_TENANT, CONV, PRINCIPAL),
    ).resolves.toBeNull();
  });
});
