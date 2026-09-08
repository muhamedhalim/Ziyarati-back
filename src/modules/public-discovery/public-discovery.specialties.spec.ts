import { PublicDiscoveryService } from './public-discovery.service';
import { ErrorCode } from '../../common/errors';

/**
 * Contracts C3 (index) and C4 (detail). FR-081's five mandatory cases: happy
 * path, visibility predicate, soft-delete exclusion, pagination bounds,
 * rejection of malformed input.
 */

const SPECIALTY_ROW = {
  slug: 'dentistry',
  name_ar: 'طب الأسنان',
  name_en: 'Dentistry',
  clinic_count: 2,
};

function buildIndex(rows: Record<string, unknown>[] = [SPECIALTY_ROW]) {
  const query = jest.fn().mockResolvedValue(rows);
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

describe('PublicDiscoveryService.listSpecialties (C3)', () => {
  it('happy path: returns slug + bilingual names + clinicCount', async () => {
    const { service } = buildIndex();
    const result = await service.listSpecialties();
    expect(result).toEqual([
      {
        slug: 'dentistry',
        nameAr: 'طب الأسنان',
        nameEn: 'Dentistry',
        clinicCount: 2,
      },
    ]);
  });

  it('applies the eligibility predicate and HAVING > 0 clause in the query (visibility predicate)', async () => {
    const { service, query } = buildIndex([]);
    await service.listSpecialties();
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/t\.approval_status = 'APPROVED'/);
    expect(sql).toMatch(/t\.is_active = true/);
    expect(sql).toMatch(/COALESCE\(ts\.public_booking_enabled, false\) = true/);
    expect(sql).toMatch(/HAVING COUNT\(DISTINCT t\.id\) > 0/);
  });

  it('returns an empty array rather than throwing when nothing is eligible', async () => {
    const { service } = buildIndex([]);
    await expect(service.listSpecialties()).resolves.toEqual([]);
  });
});

function buildDetail(opts: {
  specialty?: Record<string, unknown>[];
  clinics?: Record<string, unknown>[];
  clinicTotal?: number;
  doctors?: Record<string, unknown>[];
  doctorTotal?: number;
}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM specialties WHERE slug'))
      return opts.specialty ?? [];
    if (sql.includes('COUNT(DISTINCT t.id)::int AS "clinicTotal"'))
      return [{ clinicTotal: opts.clinicTotal ?? 0 }];
    if (sql.includes('FROM tenants t') && sql.includes('tenant_specialties'))
      return opts.clinics ?? [];
    if (sql.includes('COUNT(DISTINCT sf.id)::int AS "doctorTotal"'))
      return [{ doctorTotal: opts.doctorTotal ?? 0 }];
    if (sql.includes('FROM staff_profiles sf')) return opts.doctors ?? [];
    return [];
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

const SPECIALTY = {
  id: 'spec-1',
  slug: 'dentistry',
  name_ar: 'طب الأسنان',
  name_en: 'Dentistry',
};
const CLINIC = {
  id: 'clinic-1',
  name: 'Noor',
  slug: 'noor',
  logo_url: null,
  branches: 1,
};
const DOCTOR = {
  id: 'doc-1',
  title: 'Dr.',
  tenant_id: 'clinic-1',
  tenant_name: 'Noor',
  tenant_slug: 'noor',
};

describe('PublicDiscoveryService.specialtyDetail (C4)', () => {
  it('happy path: returns specialty + paginated clinics/doctors with explicit totals', async () => {
    const { service } = buildDetail({
      specialty: [SPECIALTY],
      clinics: [CLINIC],
      clinicTotal: 1,
      doctors: [DOCTOR],
      doctorTotal: 1,
    });
    const result = await service.specialtyDetail('dentistry');
    expect(result.specialty).toEqual({
      slug: 'dentistry',
      nameAr: 'طب الأسنان',
      nameEn: 'Dentistry',
    });
    expect(result.clinics).toEqual({
      items: [
        {
          id: 'clinic-1',
          name: 'Noor',
          slug: 'noor',
          logoUrl: null,
          branchCount: 1,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 24,
    });
    expect(result.doctors.items).toEqual([
      {
        id: 'doc-1',
        title: 'Dr.',
        clinic: { id: 'clinic-1', name: 'Noor', slug: 'noor' },
      },
    ]);
  });

  it('404s for an unknown slug (a genuinely bad slug)', async () => {
    const { service } = buildDetail({ specialty: [] });
    await expect(
      service.specialtyDetail('not-a-real-specialty'),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('returns 200 with empty collections for a real specialty with zero eligible clinics (never 404 — indistinguishable from a bad slug)', async () => {
    const { service } = buildDetail({
      specialty: [SPECIALTY],
      clinics: [],
      clinicTotal: 0,
      doctors: [],
      doctorTotal: 0,
    });
    const result = await service.specialtyDetail('dentistry');
    expect(result.clinics.items).toEqual([]);
    expect(result.clinics.total).toBe(0);
    expect(result.doctors.items).toEqual([]);
  });

  it('applies the eligibility predicate and soft-delete exclusion in every query (visibility + soft-delete exclusion)', async () => {
    const { service, query } = buildDetail({ specialty: [SPECIALTY] });
    await service.specialtyDetail('dentistry');
    const statements = query.mock.calls.map(([s]) => s as string);
    const dataQueries = statements.filter(
      (s) =>
        s.includes('FROM tenants t') || s.includes('FROM staff_profiles sf'),
    );
    expect(dataQueries.length).toBeGreaterThan(0);
    expect(
      dataQueries.every((s) => /t\.approval_status = 'APPROVED'/.test(s)),
    ).toBe(true);
    expect(
      statements.some(
        (s) =>
          s.includes('FROM staff_profiles sf') &&
          /sf\.deleted_at IS NULL/.test(s),
      ),
    ).toBe(true);
  });

  it('clamps pagination bounds: pageSize is capped at 24, page floors at 1 (pagination bounds)', async () => {
    const { service } = buildDetail({ specialty: [SPECIALTY] });
    const result = await service.specialtyDetail('dentistry', {
      clinicsPage: 0,
      clinicsPageSize: 999,
      doctorsPage: -5,
      doctorsPageSize: 0,
    });
    expect(result.clinics.page).toBe(1);
    expect(result.clinics.pageSize).toBe(24);
    expect(result.doctors.page).toBe(1);
    expect(result.doctors.pageSize).toBe(1);
  });

  it('treats a blank slug as not found rather than throwing a raw error (rejection of malformed input)', async () => {
    const { service } = buildDetail({ specialty: [] });
    await expect(service.specialtyDetail('   ')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});
