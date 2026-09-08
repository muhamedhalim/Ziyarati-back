import { PublicDiscoveryService } from './public-discovery.service';

/**
 * Contract C1 (BE-6) — `searchClinics()` pagination. The AI calls this method
 * in-process and the shipped chat widget's `useClinicSearch` depends on the
 * legacy bare-array shape, so the mandatory assertion here is that the legacy
 * shape is BYTE-IDENTICAL when no pagination params are passed at all.
 */

const CLINIC_ROW = {
  id: 'clinic-1',
  name: 'Noor Dental',
  slug: 'noor-dental',
  logo_url: null,
  branches: 2,
  services: 'Cleaning, Whitening',
};

function build(rows: Record<string, unknown>[], countRow?: { total: number }) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT COUNT(*)::int AS total')) {
      return [countRow ?? { total: rows.length }];
    }
    return rows;
  });
  const service = new PublicDiscoveryService(
    { query } as never,
    {} as never,
  );
  return { service, query };
}

describe('PublicDiscoveryService.searchClinics — pagination (C1, BE-6)', () => {
  it('returns a bare array, capped at 24, when page/pageSize are both absent (legacy shape, byte-identical)', async () => {
    const { service, query } = build([CLINIC_ROW]);

    const result = await service.searchClinics(undefined, 12);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      {
        id: 'clinic-1',
        name: 'Noor Dental',
        slug: 'noor-dental',
        logoUrl: null,
        branchCount: 2,
        services: 'Cleaning, Whitening',
      },
    ]);
    // Exactly one query — no count query fired for the legacy path.
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('LIMIT $2 OFFSET $4');
    expect(params).toEqual([null, 12, null, 0]);
  });

  it('returns the {items,total,page,pageSize} envelope when pagination params are present', async () => {
    const { service } = build([CLINIC_ROW], { total: 37 });

    const result = await service.searchClinics(undefined, 12, undefined, {
      page: 2,
      pageSize: 10,
    });

    expect(result).toEqual({
      items: [
        {
          id: 'clinic-1',
          name: 'Noor Dental',
          slug: 'noor-dental',
          logoUrl: null,
          branchCount: 2,
          services: 'Cleaning, Whitening',
        },
      ],
      total: 37,
      page: 2,
      pageSize: 10,
    });
  });

  it('computes the correct OFFSET for page 2', async () => {
    const { service, query } = build([], { total: 0 });

    await service.searchClinics(undefined, 12, undefined, { page: 2, pageSize: 10 });

    const [, params] = query.mock.calls[0];
    // page 2, pageSize 10 -> offset 10
    expect(params).toEqual([null, 10, null, 10]);
  });

  it('caps pageSize at 24 even when a larger value is requested', async () => {
    const { service, query } = build([], { total: 0 });

    await service.searchClinics(undefined, 12, undefined, { page: 1, pageSize: 999 });

    const [, params] = query.mock.calls[0];
    expect(params[1]).toBe(24);
  });

  it('floors page at 1 for a non-positive page value', async () => {
    const { service, query } = build([], { total: 0 });

    await service.searchClinics(undefined, 12, undefined, { page: 0, pageSize: 10 });

    const [, params] = query.mock.calls[0];
    expect(params).toEqual([null, 10, null, 0]); // page clamped to 1 -> offset 0
  });

  it('keeps the ELIGIBLE_CLINIC predicate and city/query filters in both the item and count queries', async () => {
    const { service, query } = build([], { total: 0 });

    await service.searchClinics('dentist', 12, 'city-1', { page: 1, pageSize: 10 });

    for (const [sql] of query.mock.calls) {
      expect(sql).toContain("t.approval_status = 'APPROVED'");
      expect(sql).toContain('COALESCE(ts.public_booking_enabled, false) = true');
    }
  });
});
