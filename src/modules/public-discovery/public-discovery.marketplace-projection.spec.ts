import { PublicDiscoveryService } from './public-discovery.service';
import { ErrorCode } from '../../common/errors';

/**
 * Contract C2b — the Marketplace clinic projection. `clinicDetail()`
 * (AI-facing, frozen) is asserted UNTOUCHED (SC-020, `public-discovery.slug-
 * lookup.spec.ts` / `.pagination.spec.ts` already pin its exact shape);
 * this file covers ONLY the new, separate method.
 */

const TENANT = {
  id: 'clinic-1',
  name: 'Noor Dental',
  slug: 'noor-dental',
  logo_url: null,
  contact_phone: '+201000000000',
  default_currency: 'EGP',
  default_timezone: 'Africa/Cairo',
};

const BRANCH_A = { id: 'branch-a', name: 'Maadi', address: 'St 9', phone: null, timezone: 'Africa/Cairo', city_id: 'city-1', city_ar: 'القاهرة', city_en: 'Cairo' };
const BRANCH_B = { id: 'branch-b', name: 'Zamalek', address: 'St 5', phone: null, timezone: 'Africa/Cairo', city_id: null, city_ar: null, city_en: null };

const SERVICE_UNPRICED = { id: 'svc-1', name: 'Cleaning', description: 'Basic cleaning', duration_minutes: 30, base_price: 200 };
const SERVICE_PRICED = { id: 'svc-2', name: 'Whitening', description: null, duration_minutes: 60, base_price: 500 };

function build(opts: {
  tenant?: Record<string, unknown>[];
  branches?: Record<string, unknown>[];
  branchCount?: number;
  services?: Record<string, unknown>[];
  serviceCount?: number;
  doctors?: Record<string, unknown>[];
  doctorCount?: number;
  prices?: Record<string, unknown>[];
  allBranches?: Record<string, unknown>[];
}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM tenants t')) return opts.tenant ?? [];
    if (sql.includes('SELECT COUNT(*)::int AS total FROM branches')) return [{ total: opts.branchCount ?? 0 }];
    if (sql.includes('SELECT COUNT(*)::int AS total FROM services')) return [{ total: opts.serviceCount ?? 0 }];
    if (sql.includes('SELECT COUNT(*)::int AS total FROM staff_profiles')) return [{ total: opts.doctorCount ?? 0 }];
    if (sql.includes('FROM branches b')) return opts.branches ?? [];
    if (sql.includes('FROM services') && sql.includes('duration_minutes')) return opts.services ?? [];
    if (sql.includes('FROM staff_profiles sp')) return opts.doctors ?? [];
    if (sql.includes('FROM service_prices sp')) return opts.prices ?? [];
    if (sql.includes('SELECT id FROM branches')) return opts.allBranches ?? opts.branches ?? [];
    return [];
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

describe('PublicDiscoveryService.marketplaceClinicDetail (C2b)', () => {
  it('404s for an unknown/de-listed clinic', async () => {
    const { service } = build({ tenant: [] });
    await expect(service.marketplaceClinicDetail('nope')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('returns clinic core fields including phone/currency/timezone (withheld: contact_email, per A1)', async () => {
    const { service } = build({ tenant: [TENANT] });
    const result = await service.marketplaceClinicDetail('noor-dental');
    expect(result.clinic).toEqual({
      id: 'clinic-1',
      name: 'Noor Dental',
      slug: 'noor-dental',
      logoUrl: null,
      phone: '+201000000000',
      currency: 'EGP',
      timezone: 'Africa/Cairo',
    });
    expect(result.clinic).not.toHaveProperty('contact_email');
    expect(result.clinic).not.toHaveProperty('email');
  });

  it('returns explicit totals and page/pageSize for every collection (P7 — no silent truncation)', async () => {
    const { service } = build({
      tenant: [TENANT],
      branches: [BRANCH_A],
      branchCount: 5,
      services: [SERVICE_UNPRICED],
      serviceCount: 12,
      doctors: [],
      doctorCount: 0,
      allBranches: [BRANCH_A],
    });

    const result = await service.marketplaceClinicDetail('noor-dental');

    expect(result.branches.total).toBe(5);
    expect(result.branches.page).toBe(1);
    expect(result.services.total).toBe(12);
    expect(result.doctors.total).toBe(0);
  });

  it('prices a service with no branch-specific rows at base_price for EVERY active branch of the clinic, not just the current page', async () => {
    const { service } = build({
      tenant: [TENANT],
      branches: [BRANCH_A], // only one branch on this page...
      allBranches: [BRANCH_A, BRANCH_B], // ...but the clinic has two active branches
      services: [SERVICE_UNPRICED],
      prices: [], // no service_prices rows at all
    });

    const result = await service.marketplaceClinicDetail('noor-dental');

    const svc = result.services.items[0];
    expect(svc.prices).toEqual(
      expect.arrayContaining([
        { branchId: 'branch-a', price: 200 },
        { branchId: 'branch-b', price: 200 },
      ]),
    );
    expect(svc.prices).toHaveLength(2);
  });

  it('prices a service WITH branch-specific rows only at those branches (explicit configuration wins)', async () => {
    const { service } = build({
      tenant: [TENANT],
      branches: [BRANCH_A, BRANCH_B],
      allBranches: [BRANCH_A, BRANCH_B],
      services: [SERVICE_PRICED],
      prices: [{ service_id: 'svc-2', branch_id: 'branch-a', price: 450 }],
    });

    const result = await service.marketplaceClinicDetail('noor-dental');

    expect(result.services.items[0].prices).toEqual([{ branchId: 'branch-a', price: 450 }]);
  });

  it('never returns a single clinic-wide price field — only per-branch prices[]', async () => {
    const { service } = build({
      tenant: [TENANT],
      branches: [BRANCH_A],
      allBranches: [BRANCH_A],
      services: [SERVICE_UNPRICED],
    });

    const result = await service.marketplaceClinicDetail('noor-dental');

    expect(result.services.items[0]).not.toHaveProperty('price');
    expect(result.services.items[0].prices).toBeInstanceOf(Array);
  });

  it('omits services[].slug (documented gap — no slug column exists on services)', async () => {
    const { service } = build({
      tenant: [TENANT],
      branches: [BRANCH_A],
      allBranches: [BRANCH_A],
      services: [SERVICE_UNPRICED],
    });

    const result = await service.marketplaceClinicDetail('noor-dental');

    expect(result.services.items[0]).not.toHaveProperty('slug');
  });

  it('returns an empty specialties array (specialty domain not yet built — omitted, not invented)', async () => {
    const { service } = build({ tenant: [TENANT] });
    const result = await service.marketplaceClinicDetail('noor-dental');
    expect(result.specialties).toEqual([]);
  });

  it('caps pageSize at 50 and floors page at 1', async () => {
    const { service, query } = build({ tenant: [TENANT] });

    await service.marketplaceClinicDetail('noor-dental', {
      branchesPage: 0,
      branchesPageSize: 999,
    });

    const branchQuery = query.mock.calls.find((c) => (c[0] as string).includes('FROM branches b'));
    expect(branchQuery?.[1]).toEqual(['clinic-1', 50, 0]); // pageSize capped 50, page floored to 1 -> offset 0
  });

  it("resolves by slug OR uuid, exactly like clinicDetail's C2a lookup", async () => {
    const { service, query } = build({ tenant: [TENANT] });
    await service.marketplaceClinicDetail('11111111-1111-1111-1111-111111111111');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('t.id = $1::uuid');
  });
});
