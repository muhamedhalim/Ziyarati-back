import { AiToolDispatchService } from './ai-tool-dispatch.service';
import { AI_PUBLIC_TOOL } from './ai-public-booking-tools.constants';
import { AI_TOOL } from './ai-tools.constants';

/**
 * The city step of the public booking flow.
 *
 * Two defects met here and produced the reported dead end — a visitor who said
 * which city they were in, and was told there were no clinics at all:
 *
 *  1. `list_cities` returned a bare `{ cities: [] }`. `branches.city_id` is
 *     NULLABLE, so a perfectly bookable clinic that never recorded a city
 *     contributes nothing to that list. The model could not distinguish "nobody
 *     has opted in" from "opted-in clinics exist, none placed in a city", and
 *     reported the first.
 *  2. The `search_clinics` TOOL schema exposed only `query`, which matches
 *     clinic/slug/service names. `PublicDiscoveryService.searchClinics` had
 *     taken a `cityId` all along (the REST endpoint passes one) — the model
 *     just had no parameter to put it in, so a city NAME went into `query` and
 *     matched nothing.
 *
 * These drive the dispatcher directly: what the model receives is the artefact
 * under test, and it is produced here.
 */

/** A real UUID: every public lookup casts its id to `uuid` in SQL. */
const CITY_ID = '11111111-1111-4111-8111-111111111111';

const CTX = {
  tenantId: 'guest-discovery-tenant',
  aiConversationId: 'conv-1',
  principal: { id: 'guest-sub', guest: true, permissions: [] },
} as never;

function build(
  discovery: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const patchSelection = jest.fn().mockResolvedValue({});
  // `run()`'s idempotency ledger: no prior row for this key, and the claim
  // INSERT wins (returns an id). Anything else is a no-op update.
  const dataSource = {
    query: jest
      .fn()
      .mockImplementation(async (sql: string) =>
        /INSERT INTO ai_tool_calls[\s\S]*RETURNING id/.test(sql)
          ? [{ id: 'claim-1' }]
          : [],
      ),
  };
  const tenantContext = { getCorrelationId: jest.fn().mockReturnValue(null) };
  const service = new AiToolDispatchService(
    {} as never, // appointments
    {} as never, // availability
    discovery as never,
    {} as never, // dashboardMetrics
    {} as never, // subscriptions
    {} as never, // usage
    {} as never, // customers
    {} as never, // staff
    {} as never, // aiAnalytics
    dataSource as never,
    {} as never, // handovers
    {} as never, // tenants
    {} as never, // paymentLinks
    { patchSelection, ...extra } as never, // bookingContext
    {} as never, // botActor
    tenantContext as never,
    {} as never, // sessions
    {} as never, // branches
  );
  return { service, patchSelection, dataSource };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'c1',
  name,
  arguments: JSON.stringify(args),
});

describe('list_cities — an empty city list is not an empty platform', () => {
  it('reports the bookable-clinic count so "no cities" cannot be read as "no clinics"', async () => {
    const { service } = build({
      cityCoverage: jest.fn().mockResolvedValue({
        cities: [],
        bookableClinics: 3,
        clinicsWithoutCity: 3,
      }),
    });

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_PUBLIC_TOOL.LIST_CITIES),
    );

    expect(result.success).toBe(true);
    expect(result.bookableClinics).toBe(3);
    // And it must name the recovery, not merely report the numbers.
    expect(result.guidance).toMatch(/search_clinics with no arguments/i);
    expect(result.guidance).not.toMatch(/no clinic has opted in/i);
  });

  it('only says nothing is opted in when the count is genuinely zero', async () => {
    const { service } = build({
      cityCoverage: jest.fn().mockResolvedValue({
        cities: [],
        bookableClinics: 0,
        clinicsWithoutCity: 0,
      }),
    });

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_PUBLIC_TOOL.LIST_CITIES),
    );

    expect(result.bookableClinics).toBe(0);
    expect(result.guidance).toMatch(/no clinic has opted in/i);
  });

  it('is recorded in ai_tool_calls like every other public step', async () => {
    // It used to return without writing any row, so a booking that dead-ended
    // at the city step left no trace on the monitoring surfaces at all.
    const { service, dataSource } = build({
      cityCoverage: jest.fn().mockResolvedValue({
        cities: [],
        bookableClinics: 1,
        clinicsWithoutCity: 1,
      }),
    });

    await service.execute(CTX, call(AI_PUBLIC_TOOL.LIST_CITIES));

    const inserts = dataSource.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('INSERT INTO ai_tool_calls'),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toContain(AI_PUBLIC_TOOL.LIST_CITIES);
  });
});

describe('search_clinics — the city is a validated filter, and it is remembered', () => {
  const coverage = {
    searchClinics: jest.fn(),
    findCity: jest.fn(),
  };

  beforeEach(() => {
    coverage.searchClinics.mockReset();
    coverage.findCity.mockReset();
  });

  it('passes an accepted cityId through to the query instead of dropping it', async () => {
    coverage.findCity.mockResolvedValue({
      id: CITY_ID,
      nameAr: 'الرياض',
      nameEn: 'Riyadh',
    });
    coverage.searchClinics.mockResolvedValue([
      { id: 'clinic-a', name: 'Al Noor' },
    ]);
    const { service } = build(coverage);

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_TOOL.SEARCH_CLINICS, { cityId: CITY_ID }),
    );

    // Third positional argument is the city — the one the tool used to discard.
    expect(coverage.searchClinics).toHaveBeenCalledWith(
      undefined,
      undefined,
      CITY_ID,
    );
    expect(result.count).toBe(1);
  });

  it('records the city on the session so the next turn does not start over', async () => {
    coverage.findCity.mockResolvedValue({
      id: CITY_ID,
      nameAr: null,
      nameEn: 'Riyadh',
    });
    coverage.searchClinics.mockResolvedValue([]);
    const { service, patchSelection } = build(coverage);

    await service.execute(
      CTX,
      call(AI_TOOL.SEARCH_CLINICS, { cityId: CITY_ID }),
    );

    expect(patchSelection).toHaveBeenCalledWith(
      'guest-discovery-tenant',
      'conv-1',
      { selectedCityId: CITY_ID },
    );
  });

  it('refuses a well-formed cityId the database does not know, and never records it', async () => {
    // The session only ever holds ids the database confirmed — an id the model
    // invented is rejected at the door, not stored and trusted later.
    coverage.findCity.mockResolvedValue(null);
    const { service, patchSelection } = build(coverage);

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_TOOL.SEARCH_CLINICS, {
        cityId: '99999999-9999-4999-8999-999999999999',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a city the platform knows/);
    expect(patchSelection).not.toHaveBeenCalled();
    expect(coverage.searchClinics).not.toHaveBeenCalled();
  });

  it('refuses a city NAME without ever reaching the database', async () => {
    // Observed live in a different tool: every public lookup casts its id to
    // `uuid`, so a non-UUID does not "find nothing" — Postgres raises, and the
    // driver's own `invalid input syntax for type uuid: "..."` came back as the
    // tool's error. The model read that as a platform fault and escalated to a
    // human. The shape check turns it into a recoverable refusal instead.
    const { service, patchSelection } = build(coverage);

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_TOOL.SEARCH_CLINICS, { cityId: 'الرياض' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/never a city name/);
    // Never reached the database, so no driver error could be produced.
    expect(coverage.findCity).not.toHaveBeenCalled();
    expect(patchSelection).not.toHaveBeenCalled();
  });

  it('refuses a clinic NAME passed as clinicId, and says how to recover', async () => {
    // The exact live failure: `search_clinics` returned a clinic whose NAME
    // looks like an identifier (`owner@inovra`), the model passed that name as
    // `clinicId`, and the raw uuid-cast error reached the conversation.
    const clinicDetail = jest.fn();
    const { service } = build({ ...coverage, clinicDetail });

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_PUBLIC_TOOL.SELECT_CLINIC, { clinicId: 'owner@inovra' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UUID exactly as returned by search_clinics/);
    // And the driver's own message never reaches the conversation.
    expect(result.error).not.toMatch(/invalid input syntax/i);
    expect(clinicDetail).not.toHaveBeenCalled();
  });

  it('does not write a booking session for an authenticated staff turn', async () => {
    // Staff share this read-only tool but have no anonymous booking session.
    coverage.findCity.mockResolvedValue({
      id: CITY_ID,
      nameAr: null,
      nameEn: 'Riyadh',
    });
    coverage.searchClinics.mockResolvedValue([]);
    const { service, patchSelection } = build(coverage);

    await service.execute(
      {
        tenantId: 'clinic-a',
        aiConversationId: 'conv-1',
        principal: { id: 'staff-1', guest: false, permissions: [] },
      } as never,
      call(AI_TOOL.SEARCH_CLINICS, { cityId: CITY_ID }),
    );

    expect(patchSelection).not.toHaveBeenCalled();
  });

  it('spells out which id in the result select_clinic wants', async () => {
    // Both ids in this result are uuids. Observed live: the model grabbed
    // `cityId`, passed it to select_clinic, and gave up on the bare refusal.
    coverage.findCity.mockResolvedValue({
      id: CITY_ID,
      nameAr: null,
      nameEn: 'Riyadh',
    });
    coverage.searchClinics.mockResolvedValue([
      { id: 'bc7814f5-02f1-4237-a9ed-11b1a6ebbb89', name: 'Al Noor' },
    ]);
    const { service } = build(coverage);

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_TOOL.SEARCH_CLINICS, { cityId: CITY_ID }),
    );

    expect(result.usage).toMatch(/clinics\[\]\.id/);
    expect(result.usage).toMatch(/never a clinic/);
  });

  it('makes a rejected clinicId recoverable instead of a dead end', async () => {
    // A well-formed uuid that is not a bookable clinic — the shape guard cannot
    // catch this one, so the refusal itself has to carry the recovery.
    const clinicDetail = jest
      .fn()
      .mockRejectedValue(new Error('Clinic not found'));
    const { service } = build({ ...coverage, clinicDetail });

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_PUBLIC_TOOL.SELECT_CLINIC, { clinicId: CITY_ID }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a city id/);
    expect(result.error).toMatch(/search_clinics returned/);
  });

  it('tells the model to retry without the city before declaring nothing available', async () => {
    coverage.findCity.mockResolvedValue({
      id: CITY_ID,
      nameAr: null,
      nameEn: 'Riyadh',
    });
    coverage.searchClinics.mockResolvedValue([]);
    const { service } = build(coverage);

    const result: Record<string, unknown> = await service.execute(
      CTX,
      call(AI_TOOL.SEARCH_CLINICS, { cityId: CITY_ID }),
    );

    expect(result.count).toBe(0);
    expect(result.guidance).toMatch(/Retry with no cityId/);
  });
});
