import { PublicDiscoveryService } from './public-discovery.service';

/**
 * FR-088 / SC-020 — `clinicDetail()` and `searchClinics()` are the two
 * AI-facing (+ legacy widget) methods this whole feature promised to leave
 * byte-identical in shape. `searchClinics()`'s exact shape (bare array,
 * cap-24, and the opt-in `{items,total,page,pageSize}` envelope) is already
 * pinned by `public-discovery.pagination.spec.ts`. This file adds the pin
 * `clinicDetail()` was missing: `public-discovery.slug-lookup.spec.ts`
 * (C2a) only asserts `detail.clinic.{id,slug}` — never the full
 * `{clinic,branches,services,doctors}` shape with each collection's exact
 * field set. A drift in any of those fields — an added/removed/renamed key
 * on the clinic, a branch, a service, or a doctor — must fail HERE.
 */

const TENANT_ROW = {
  id: 'clinic-1',
  name: 'Noor Dental',
  slug: 'noor-dental',
  logo_url: 'https://example.com/logo.png',
};

const BRANCH_ROW = {
  id: 'branch-1',
  name: 'Maadi',
  address: 'St 9',
  city_id: 'city-1',
  city_ar: 'القاهرة',
  city_en: 'Cairo',
};

const SERVICE_ROW = { id: 'svc-1', name: 'Cleaning', base_price: '200.00' };

const DOCTOR_ROW = { id: 'doc-1', name: 'Dr. Sara', title: 'Dentist' };

function build() {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM tenants t')) return [TENANT_ROW];
    if (sql.includes('FROM branches b')) return [BRANCH_ROW];
    if (sql.includes('FROM services')) return [SERVICE_ROW];
    if (sql.includes('FROM staff_profiles sp')) return [DOCTOR_ROW];
    return [];
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

describe('PublicDiscoveryService — frozen-shape pins (FR-088, SC-020)', () => {
  it('clinicDetail() returns EXACTLY {clinic,branches,services,doctors} with each field pinned', async () => {
    const { service } = build();

    const detail = await service.clinicDetail('noor-dental');

    // Top-level shape — no extra, no missing keys.
    expect(Object.keys(detail).sort()).toEqual(
      ['clinic', 'branches', 'services', 'doctors'].sort(),
    );

    expect(detail.clinic).toEqual({
      id: 'clinic-1',
      name: 'Noor Dental',
      slug: 'noor-dental',
      logoUrl: 'https://example.com/logo.png',
    });
    expect(Object.keys(detail.clinic).sort()).toEqual(
      ['id', 'name', 'slug', 'logoUrl'].sort(),
    );

    expect(detail.branches).toEqual([
      {
        id: 'branch-1',
        name: 'Maadi',
        address: 'St 9',
        city: { id: 'city-1', nameAr: 'القاهرة', nameEn: 'Cairo' },
      },
    ]);
    expect(Object.keys(detail.branches[0]).sort()).toEqual(
      ['id', 'name', 'address', 'city'].sort(),
    );

    expect(detail.services).toEqual([
      { id: 'svc-1', name: 'Cleaning', price: 200 },
    ]);
    expect(Object.keys(detail.services[0]).sort()).toEqual(
      ['id', 'name', 'price'].sort(),
    );

    expect(detail.doctors).toEqual([
      { id: 'doc-1', name: 'Dr. Sara', title: 'Dentist' },
    ]);
    expect(Object.keys(detail.doctors[0]).sort()).toEqual(
      ['id', 'name', 'title'].sort(),
    );

    // Never the Marketplace-only fields (`marketplaceClinicDetail()`'s
    // per-branch prices[], phone/currency/timezone, explicit totals) — a
    // frozen method must never grow those under this same shape.
    expect(detail.clinic).not.toHaveProperty('phone');
    expect(detail.clinic).not.toHaveProperty('currency');
    expect(detail.clinic).not.toHaveProperty('timezone');
    expect(detail.services[0]).not.toHaveProperty('prices');
    expect(detail).not.toHaveProperty('specialties');
  });
});
