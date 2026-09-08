import { PublicDiscoveryService } from './public-discovery.service';
import { ErrorCode } from '../../common/errors';

/**
 * Contracts C7 (search) and C8 (detail), Marketplace BE-4 (T066). Accept: the
 * branch-scoped pricing rule (D1) holds in both directions — a service with
 * active `service_prices` rows appears only at those branches/prices; a
 * service with none appears at every active branch of its clinic, at
 * `base_price`. Mirrors `public-doctors.spec.ts`'s (C5/C6) test shape.
 */

const OFFERING_ROW = {
  id: 'svc-1',
  public_slug: 'teeth-cleaning',
  name: 'Teeth Cleaning',
  description: 'A basic cleaning.',
  duration_minutes: 30,
  price: '150.00',
  currency: 'SAR',
  clinic_name: 'Noor',
  clinic_slug: 'noor',
  branch_id: 'branch-1',
  branch_name: 'Downtown',
};

function buildSearch(rows: Record<string, unknown>[], total = rows.length) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (/SELECT COUNT\(\*\)::int AS total/.test(sql)) return [{ total }];
    return rows;
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

describe('PublicDiscoveryService.searchServices (C7)', () => {
  it('happy path: shape matches the contract exactly', async () => {
    const { service } = buildSearch([OFFERING_ROW]);
    const result = await service.searchServices({});
    expect(result.items).toEqual([
      {
        id: 'svc-1',
        slug: 'teeth-cleaning',
        name: 'Teeth Cleaning',
        description: 'A basic cleaning.',
        durationMinutes: 30,
        price: 150,
        currency: 'SAR',
        clinic: { name: 'Noor', slug: 'noor' },
        branch: { id: 'branch-1', name: 'Downtown' },
      },
    ]);
  });

  it('the query applies the eligibility predicate, the active/not-deleted predicate, and the branch-offers-service rule', async () => {
    const { service, query } = buildSearch([]);
    await service.searchServices({});
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/s\.is_active = true/);
    expect(sql).toMatch(/s\.deleted_at IS NULL/);
    expect(sql).toMatch(/t\.approval_status = 'APPROVED'/);
    expect(sql).toMatch(/COALESCE\(ts\.public_booking_enabled, false\) = true/);
    expect(sql).toMatch(/sp\.id IS NOT NULL/);
    expect(sql).toMatch(/NOT EXISTS/);
  });

  it('clamps pagination bounds (pageSize capped at 24, page floors at 1)', async () => {
    const { service } = buildSearch([]);
    const result = await service.searchServices({ page: 0, pageSize: 999 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(24);
  });

  it('description is null, not the string "null", when absent', async () => {
    const { service } = buildSearch([{ ...OFFERING_ROW, description: null }]);
    const result = await service.searchServices({});
    expect(result.items[0].description).toBeNull();
  });
});

function buildDetail(opts: {
  service?: Record<string, unknown>[];
  prices?: Record<string, unknown>[];
  branches?: Record<string, unknown>[];
  doctors?: Record<string, unknown>[];
}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM services s') && sql.includes('s.public_slug = $1')) {
      return opts.service ?? [];
    }
    if (sql.includes('FROM service_prices sp')) return opts.prices ?? [];
    if (sql.includes('FROM branches b')) return opts.branches ?? [];
    if (sql.includes('FROM staff_services ss6')) return opts.doctors ?? [];
    return [];
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

const SERVICE_ROW = {
  id: 'svc-1',
  public_slug: 'teeth-cleaning',
  name: 'Teeth Cleaning',
  description: 'A basic cleaning.',
  duration_minutes: 30,
  base_price: '150.00',
  specialty_slug: null,
  specialty_name_ar: null,
  specialty_name_en: null,
  tenant_id: 'clinic-1',
  tenant_name: 'Noor',
  tenant_slug: 'noor',
  currency: 'SAR',
};

const BRANCH_A = {
  id: 'branch-1',
  name: 'Downtown',
  city_ar: null,
  city_en: 'Riyadh',
};
const BRANCH_B = {
  id: 'branch-2',
  name: 'Uptown',
  city_ar: null,
  city_en: 'Riyadh',
};

describe('PublicDiscoveryService.serviceDetail (C8)', () => {
  it('happy path: returns exactly the contract shape, nothing more', async () => {
    const { service } = buildDetail({
      service: [SERVICE_ROW],
      branches: [BRANCH_A],
    });
    const result = await service.serviceDetail('noor', 'teeth-cleaning');
    expect(Object.keys(result).sort()).toEqual(
      ['service', 'clinic', 'offerings', 'doctors'].sort(),
    );
    expect(Object.keys(result.service).sort()).toEqual(
      [
        'id',
        'slug',
        'name',
        'description',
        'durationMinutes',
        'specialty',
      ].sort(),
    );
  });

  it('404s for an unknown clinic/service slug pair', async () => {
    const { service } = buildDetail({ service: [] });
    await expect(service.serviceDetail('noor', 'nobody')).rejects.toMatchObject(
      { code: ErrorCode.NOT_FOUND },
    );
  });

  it('a branch-scoped service offers only its configured branches, at their prices — not base_price', async () => {
    const { service } = buildDetail({
      service: [SERVICE_ROW],
      prices: [{ branch_id: 'branch-1', price: '200.00' }],
      branches: [BRANCH_A, BRANCH_B],
    });
    const result = await service.serviceDetail('noor', 'teeth-cleaning');
    expect(result.offerings).toEqual([
      {
        branch: {
          id: 'branch-1',
          name: 'Downtown',
          city: { nameAr: null, nameEn: 'Riyadh' },
        },
        price: 200,
        currency: 'SAR',
      },
    ]);
  });

  it('an unconfigured service offers every active branch of its clinic, at base_price', async () => {
    const { service } = buildDetail({
      service: [SERVICE_ROW],
      prices: [],
      branches: [BRANCH_A, BRANCH_B],
    });
    const result = await service.serviceDetail('noor', 'teeth-cleaning');
    expect(result.offerings).toEqual([
      {
        branch: {
          id: 'branch-1',
          name: 'Downtown',
          city: { nameAr: null, nameEn: 'Riyadh' },
        },
        price: 150,
        currency: 'SAR',
      },
      {
        branch: {
          id: 'branch-2',
          name: 'Uptown',
          city: { nameAr: null, nameEn: 'Riyadh' },
        },
        price: 150,
        currency: 'SAR',
      },
    ]);
  });

  it('a price row referencing a branch that is no longer active/eligible is silently excluded, not shown detached', async () => {
    const { service } = buildDetail({
      service: [SERVICE_ROW],
      prices: [
        { branch_id: 'branch-1', price: '200.00' },
        { branch_id: 'deactivated-branch', price: '999.00' },
      ],
      branches: [BRANCH_A], // deactivated-branch is not in the eligible set
    });
    const result = await service.serviceDetail('noor', 'teeth-cleaning');
    expect(result.offerings).toHaveLength(1);
    expect(result.offerings[0].branch.id).toBe('branch-1');
  });

  it('doctors come from staff_services, mapped to the public shape', async () => {
    const { service } = buildDetail({
      service: [SERVICE_ROW],
      branches: [BRANCH_A],
      doctors: [
        {
          id: 'staff-1',
          public_slug: 'dr-sara-ahmed',
          title: 'Dentist',
          full_name: 'Dr. Sara Ahmed',
        },
      ],
    });
    const result = await service.serviceDetail('noor', 'teeth-cleaning');
    expect(result.doctors).toEqual([
      {
        id: 'staff-1',
        slug: 'dr-sara-ahmed',
        name: 'Dr. Sara Ahmed',
        title: 'Dentist',
      },
    ]);
  });

  it('a specialty is included as {slug, nameAr, nameEn} when the service has one, null otherwise', async () => {
    const { service } = buildDetail({
      service: [
        {
          ...SERVICE_ROW,
          specialty_slug: 'dentistry',
          specialty_name_ar: 'طب الأسنان',
          specialty_name_en: 'Dentistry',
        },
      ],
      branches: [BRANCH_A],
    });
    const result = await service.serviceDetail('noor', 'teeth-cleaning');
    expect(result.service.specialty).toEqual({
      slug: 'dentistry',
      nameAr: 'طب الأسنان',
      nameEn: 'Dentistry',
    });
  });

  it('never returns a presigned or any other https:// URL anywhere in the payload', async () => {
    const { service } = buildDetail({
      service: [SERVICE_ROW],
      branches: [BRANCH_A],
    });
    const result = await service.serviceDetail('noor', 'teeth-cleaning');
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });
});
