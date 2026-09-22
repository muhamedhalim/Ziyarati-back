import { PublicDiscoveryService } from './public-discovery.service';
import { ErrorCode } from '../../common/errors';

/**
 * `branchInfo` and `doctorSchedule` — the two reads that let the assistant
 * answer "where are you / when are you open?" and "when does Dr. X work?"
 * from the DATABASE instead of from a Knowledge document the clinic may never
 * have written.
 *
 * Both are reachable ANONYMOUSLY, so the tests that matter most are the ones
 * about what they refuse. The SQL is asserted directly, because the eligibility
 * predicate and the tenant scoping ARE the security boundary — a passing
 * result shape proves nothing if the WHERE clause was wrong.
 */

const BRANCH = 'branch-1';
const TENANT = 'clinic-a';
const DOCTOR = 'doctor-1';

const BRANCH_ROW = {
  id: BRANCH,
  name: 'Main Branch',
  address: 'شارع التحلية، جدة',
  phone: '+966500000000',
  whatsapp_phone: null,
  timezone: 'Asia/Riyadh',
  tenant_id: TENANT,
  clinic_name: 'noor',
  city: 'جدة',
};

function build(rows: {
  branch?: Record<string, unknown>[];
  hours?: Record<string, unknown>[];
  pairing?: Record<string, unknown>[];
  profile?: Record<string, unknown>[];
  schedule?: Record<string, unknown>[];
}) {
  // Order matters: the roster query LEFT JOINs `working_hours`, so it has to
  // be matched on its own FROM clause before the branch-hours check.
  const query = jest.fn().mockImplementation(async (sql: string) => {
    // `assertDoctorAtBranch` — the branch⇄doctor pairing check.
    if (sql.includes('JOIN staff_schedules ss') && sql.includes('SELECT 1')) {
      return rows.pairing ?? [];
    }
    if (sql.includes('FROM staff_schedules ss')) return rows.schedule ?? [];
    if (sql.includes('FROM working_hours')) return rows.hours ?? [];
    if (sql.includes('FROM branches b')) return rows.branch ?? [];
    if (sql.includes('FROM staff_profiles sp')) return rows.profile ?? [];
    return [];
  });
  const service = new PublicDiscoveryService(
    { query } as never,
    {} as never, // availability — untouched by these reads
  );
  return { service, query };
}

describe('PublicDiscoveryService.branchInfo', () => {
  it('returns the location and the published weekly hours', async () => {
    const { service } = build({
      branch: [BRANCH_ROW],
      hours: [
        {
          day_of_week: 0,
          start_time: '10:00:00',
          end_time: '20:00:00',
          is_closed: false,
        },
        {
          day_of_week: 5,
          start_time: '00:00:00',
          end_time: '00:00:00',
          is_closed: true,
        },
      ],
    });

    const info = await service.branchInfo(BRANCH);

    expect(info.branch.address).toBe('شارع التحلية، جدة');
    expect(info.branch.city).toBe('جدة');
    expect(info.branch.timezone).toBe('Asia/Riyadh');
    expect(info.clinic.name).toBe('noor');
    expect(info.workingHoursConfigured).toBe(true);

    // Seconds are stripped — nobody says "we open at ten oh oh oh oh".
    expect(info.workingHours[0]).toMatchObject({
      day: 'Sunday',
      status: 'OPEN',
      hours: [{ start: '10:00', end: '20:00' }],
    });
    // An explicit is_closed row is a CLOSURE the clinic set...
    expect(info.workingHours[5]).toMatchObject({
      day: 'Friday',
      status: 'CLOSED',
    });
    // ...while a day with no row at all was simply never published. Collapsing
    // the two would have the assistant announce a closure nobody declared.
    expect(info.workingHours[6]).toMatchObject({
      day: 'Saturday',
      status: 'NOT_PUBLISHED',
    });
  });

  it('reports "not configured" rather than inventing hours', async () => {
    const { service } = build({ branch: [BRANCH_ROW], hours: [] });

    const info = await service.branchInfo(BRANCH);

    expect(info.workingHoursConfigured).toBe(false);
    expect(info.workingHours.every((d) => d.status === 'NOT_PUBLISHED')).toBe(
      true,
    );
  });

  it('applies the PUBLIC eligibility predicate for an anonymous caller', async () => {
    const { service, query } = build({ branch: [BRANCH_ROW], hours: [] });

    await service.branchInfo(BRANCH);

    const sql = query.mock.calls[0][0] as string;
    // A clinic that is unapproved, inactive, soft-deleted, or has not opted in
    // to public booking must be invisible here — same predicate every other
    // public read uses.
    expect(sql).toContain("t.approval_status = 'APPROVED'");
    expect(sql).toContain('COALESCE(ts.public_booking_enabled, false) = true');
    expect(query.mock.calls[0][1]).toEqual([BRANCH]);
  });

  it("scopes to the caller's own tenant for an authenticated clinic", async () => {
    const { service, query } = build({ branch: [BRANCH_ROW], hours: [] });

    await service.branchInfo(BRANCH, { tenantId: TENANT });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('b."tenantId" = $2::uuid');
    expect(params).toEqual([BRANCH, TENANT]);
  });

  it('refuses a branch that does not resolve, without saying why', async () => {
    const { service } = build({ branch: [] });

    await expect(service.branchInfo(BRANCH)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it("reads working hours under the branch's OWN tenant, never a caller-supplied one", async () => {
    const { service, query } = build({ branch: [BRANCH_ROW], hours: [] });

    await service.branchInfo(BRANCH);

    const hoursCall = query.mock.calls.find((c) =>
      (c[0] as string).includes('FROM working_hours'),
    )!;
    // The tenant comes from the row the database returned, not from anything
    // the caller passed — so a cross-tenant branch id cannot leak another
    // clinic's schedule even if the first query were ever loosened.
    expect(hoursCall[1]).toEqual([BRANCH, TENANT]);
  });
});

describe('PublicDiscoveryService.doctorSchedule', () => {
  const pairingOk = [{ '?column?': 1 }];

  it('returns the recurring weekly roster, intersected with branch hours', async () => {
    const { service } = build({
      pairing: pairingOk,
      profile: [{ id: DOCTOR, name: 'د. خالد العتيبي', title: null }],
      schedule: [
        { day_of_week: 1, start_time: '10:00:00', end_time: '20:00:00' },
        { day_of_week: 3, start_time: '14:00:00', end_time: '18:00:00' },
      ],
    });

    const res = await service.doctorSchedule(TENANT, BRANCH, DOCTOR);

    expect(res.doctor.name).toBe('د. خالد العتيبي');
    expect(res.weekly).toEqual([
      {
        dayOfWeek: 1,
        day: 'Monday',
        hours: [{ start: '10:00', end: '20:00' }],
      },
      {
        dayOfWeek: 3,
        day: 'Wednesday',
        hours: [{ start: '14:00', end: '18:00' }],
      },
    ]);
    // States, in the payload itself, that this is not free time — the single
    // distinction that stops a rostered-but-full day being offered.
    expect(res.note).toContain('not free time');
  });

  it('drops a day where the roster and the branch hours do not overlap', async () => {
    const { service } = build({
      pairing: pairingOk,
      profile: [{ id: DOCTOR, name: 'Dr X', title: null }],
      // GREATEST/LEAST already collapsed this to an empty interval.
      schedule: [
        { day_of_week: 2, start_time: '18:00:00', end_time: '18:00:00' },
      ],
    });

    const res = await service.doctorSchedule(TENANT, BRANCH, DOCTOR);

    expect(res.weekly).toEqual([]);
  });

  it('refuses a doctor who does not work at that branch', async () => {
    const { service } = build({ pairing: [] });

    await expect(
      service.doctorSchedule(TENANT, BRANCH, DOCTOR),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('binds every query to the caller-resolved tenant (cross-tenant attempt)', async () => {
    const { service, query } = build({
      pairing: pairingOk,
      profile: [{ id: DOCTOR, name: 'Dr X', title: null }],
      schedule: [],
    });

    await service.doctorSchedule(TENANT, BRANCH, DOCTOR);

    // Every parameterised read against a TENANT-COLUMN-CARRYING staff table
    // (staff_profiles/staff_schedules) binds the tenant. A doctor id belonging
    // to another clinic therefore matches nothing rather than returning a
    // roster. F-09's `specialtiesForStaff` lookup is deliberately excluded: it
    // filters by staffId only (no tenant column on `staff_specialties`), which
    // is safe because every staffId it receives — here and at every other call
    // site (the Marketplace's cross-tenant doctor search included) — was
    // already resolved through a tenant-scoped query first.
    for (const [sql, params] of query.mock.calls) {
      if (
        typeof sql === 'string' &&
        sql.includes('staff') &&
        !sql.includes('staff_specialties')
      ) {
        expect(params).toContain(TENANT);
      }
    }
  });
});
