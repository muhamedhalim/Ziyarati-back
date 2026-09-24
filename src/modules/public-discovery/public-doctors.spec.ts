import { PublicDiscoveryService } from './public-discovery.service';
import { ErrorCode } from '../../common/errors';

/**
 * Contracts C5 (search) and C6 (detail). Accept: a test asserts each
 * forbidden field is absent from the response — user email/phone, schedules,
 * booking_buffer_minutes, commissions, internal ratings, any presigned
 * storage URL. The DTO is an allow-list: these fields are never SELECTed in
 * the first place, not merely stripped after the fact.
 */

const DOCTOR_ROW = {
  id: 'staff-1',
  public_slug: 'dr-sara-ahmed',
  title: 'Dentist',
  avatar_storage_key: 'clinic-1/staff-avatar/a.jpg',
  full_name: 'Dr. Sara Ahmed',
  tenant_name: 'Noor',
  tenant_slug: 'noor',
};

function buildSearch(rows: Record<string, unknown>[], total = rows.length) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (/SELECT COUNT\(\*\)::int AS total/.test(sql)) return [{ total }];
    if (
      /staff_specialties ss\s*$/m.test(sql) ||
      sql.includes('ss."staffId" = ANY')
    )
      return [];
    return rows;
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

describe('PublicDiscoveryService.searchDoctors (C5)', () => {
  it('happy path: shape matches the contract exactly, avatarUrl is the C12 proxy path', async () => {
    const { service } = buildSearch([DOCTOR_ROW]);
    const result = await service.searchDoctors({});
    expect(result.items).toEqual([
      {
        id: 'staff-1',
        slug: 'dr-sara-ahmed',
        name: 'Dr. Sara Ahmed',
        title: 'Dentist',
        avatarUrl: '/api/v1/public/discovery/doctors/dr-sara-ahmed/avatar',
        clinic: { name: 'Noor', slug: 'noor' },
        specialties: [],
      },
    ]);
  });

  it('avatarUrl is null (never a storage URL of any kind) when there is no stored avatar', async () => {
    const { service } = buildSearch([
      { ...DOCTOR_ROW, avatar_storage_key: null },
    ]);
    const result = await service.searchDoctors({});
    expect(result.items[0].avatarUrl).toBeNull();
  });

  it('never returns a presigned or any other https:// URL anywhere in the payload (P2/FR-086)', async () => {
    const { service } = buildSearch([DOCTOR_ROW]);
    const result = await service.searchDoctors({});
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });

  it('the query applies the eligibility predicate and excludes soft-deleted/unavailable staff', async () => {
    const { service, query } = buildSearch([]);
    await service.searchDoctors({});
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/sp\.deleted_at IS NULL/);
    expect(sql).toMatch(/sp\.is_available_for_booking = true/);
    expect(sql).toMatch(/t\.approval_status = 'APPROVED'/);
    expect(sql).toMatch(/COALESCE\(ts\.public_booking_enabled, false\) = true/);
  });

  it('clamps pagination bounds (pageSize capped at 24, page floors at 1)', async () => {
    const { service } = buildSearch([]);
    const result = await service.searchDoctors({ page: 0, pageSize: 999 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(24);
  });

  it('rejects malformed/absent filters gracefully rather than throwing', async () => {
    const { service } = buildSearch([]);
    await expect(
      service.searchDoctors({ q: '   ', cityId: '' }),
    ).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 24,
    });
  });
});

function buildDetail(opts: {
  doctor?: Record<string, unknown>[];
  branches?: Record<string, unknown>[];
  specialtyRows?: Record<string, unknown>[];
  services?: Record<string, unknown>[];
}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (
      sql.includes('FROM staff_profiles sp') &&
      sql.includes('sp.public_slug = $1')
    ) {
      return opts.doctor ?? [];
    }
    if (sql.includes('FROM staff_schedules')) return opts.branches ?? [];
    if (sql.includes('FROM staff_specialties ss'))
      return opts.specialtyRows ?? [];
    if (sql.includes('FROM staff_services')) return opts.services ?? [];
    return [];
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

const DETAIL_ROW = {
  id: 'staff-1',
  public_slug: 'dr-sara-ahmed',
  title: 'Dentist',
  bio: 'Loves teeth.',
  avatar_storage_key: null,
  full_name: 'Dr. Sara Ahmed',
  tenant_id: 'clinic-1',
  tenant_name: 'Noor',
  tenant_slug: 'noor',
};

describe('PublicDiscoveryService.doctorDetail (C6)', () => {
  it('happy path: returns exactly the contract shape, nothing more', async () => {
    const { service } = buildDetail({ doctor: [DETAIL_ROW] });
    const result = await service.doctorDetail('dr-sara-ahmed');
    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'slug',
        'name',
        'title',
        'bio',
        'avatarUrl',
        'clinic',
        'branches',
        'specialties',
        'services',
      ].sort(),
    );
  });

  it('404s for an unknown slug', async () => {
    const { service } = buildDetail({ doctor: [] });
    await expect(service.doctorDetail('nobody')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('forbidden fields are absent: no email, phone, schedules payload, booking_buffer_minutes, commissions, or internal ratings', async () => {
    const { service } = buildDetail({ doctor: [DETAIL_ROW] });
    const result = await service.doctorDetail('dr-sara-ahmed');
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'email',
      'phone',
      'booking_buffer_minutes',
      'bookingBufferMinutes',
      'commission',
      'rating',
      'schedule',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('never returns a presigned or any other https:// URL anywhere in the payload', async () => {
    const { service } = buildDetail({
      doctor: [
        { ...DETAIL_ROW, avatar_storage_key: 'clinic-1/staff-avatar/a.jpg' },
      ],
    });
    const result = await service.doctorDetail('dr-sara-ahmed');
    expect(result.avatarUrl).toBe(
      '/api/v1/public/discovery/doctors/dr-sara-ahmed/avatar',
    );
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });

  it('services carry their public_slug, so the frontend can link clinic.slug + slug to the service page', async () => {
    const { service } = buildDetail({
      doctor: [DETAIL_ROW],
      services: [
        {
          id: 'svc-1',
          public_slug: 'teeth-cleaning',
          name: 'Cleaning',
          duration_minutes: 30,
          base_price: '200.00',
        },
      ],
    });
    const result = await service.doctorDetail('dr-sara-ahmed');
    expect(result.services).toEqual([
      {
        id: 'svc-1',
        slug: 'teeth-cleaning',
        name: 'Cleaning',
        durationMinutes: 30,
        price: 200,
      },
    ]);
  });

  it('a service with no public_slug (pre-backfill) stays an honest null, never an invented value', async () => {
    const { service } = buildDetail({
      doctor: [DETAIL_ROW],
      services: [
        {
          id: 'svc-2',
          public_slug: null,
          name: 'Legacy',
          duration_minutes: 15,
          base_price: null,
        },
      ],
    });
    const result = await service.doctorDetail('dr-sara-ahmed');
    expect(result.services[0].slug).toBeNull();
  });

  it('selects the slug in the SQL itself (the projection, not just the mapping)', async () => {
    const { service, query } = buildDetail({ doctor: [DETAIL_ROW] });
    await service.doctorDetail('dr-sara-ahmed');
    const sql = (query.mock.calls as [string][])
      .map(([q]) => q)
      .find((q) => q.includes('FROM staff_services'));
    expect(sql).toMatch(/s.public_slug/);
  });

  it('branches reflects staff_schedules — the frontend uses its length for FR-083 context-depth', async () => {
    const { service } = buildDetail({
      doctor: [DETAIL_ROW],
      branches: [
        {
          id: 'b1',
          name: 'Main',
          address: 'St 1',
          city_ar: 'جدة',
          city_en: 'Jeddah',
        },
      ],
    });
    const result = await service.doctorDetail('dr-sara-ahmed');
    expect(result.branches).toEqual([
      {
        id: 'b1',
        name: 'Main',
        address: 'St 1',
        city: { nameAr: 'جدة', nameEn: 'Jeddah' },
      },
    ]);
  });

  it('the eligibility query re-checks clinic AND staff eligibility, never trusting a cached slug→doctor mapping', async () => {
    const { service, query } = buildDetail({ doctor: [] });
    await service.doctorDetail('anyone').catch(() => undefined);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/sp\.deleted_at IS NULL/);
    expect(sql).toMatch(/sp\.is_available_for_booking = true/);
    expect(sql).toMatch(/t\.approval_status = 'APPROVED'/);
  });
});
