/**
 * Real-Postgres, end-to-end DATA-MOVEMENT proof for Patient Journey: seeded
 * rows -> the real SQL -> `PatientJourneyService.summary/breakdown` -> the
 * JSON the frontend receives.
 *
 * Every expected value comes from an INDEPENDENT ORACLE: each seeded
 * appointment is recorded in `seeded` (service, staff, branch, day, local
 * hour, exact consultation minutes) and the expectations are computed from
 * that array by a hand-written percentile — never read back from the code
 * under test. Creates its own throwaway tenants (year 2031) and deletes them
 * in `afterAll`. Requires the dev Postgres (`SeedDataSource`).
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { SeedDataSource } from '../../../seed/data-source';
import { AdvancedAnalyticsService } from '../advanced-analytics.service';
import { JourneyAggregationService } from './journey-aggregation.service';
import { PatientJourneyService } from './patient-journey.service';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { ErrorCode } from '../../../common/errors';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { Branch } from '../../../entities/SaaS-Core/Branch';
import { User } from '../../../entities/Auth&RBAC/User';
import { StaffProfile } from '../../../entities/Staff/StaffProfile';
import { Customer } from '../../../entities/CRM/Customer';
import { Service } from '../../../entities/Services/Service';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../../entities/Calendar&Appointments/AppointmentService';
import { QueueEntry } from '../../../entities/Calendar&Appointments/QueueEntry';
import {
  AppointmentPaymentStatus,
  AppointmentSource,
  AppointmentStatus,
  QueueState,
  TenantApprovalStatus,
} from '../../../entities/enums';

/** PostgreSQL `percentile_cont`: linear interpolation at rank p*(n-1) over the sorted values. */
function percentile(values: number[], p: number): number {
  const v = [...values].sort((a, b) => a - b);
  const rank = p * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo] + (rank - lo) * (v[hi] - v[lo]);
}
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Seeded {
  service: 'A' | 'B' | 'C';
  staff: 'S1' | 'S2';
  branch: 'BR1' | 'BR2';
  /** Day-of-March-2031 the appointment starts (Mon = 3 ... Sun = 9). */
  day: number;
  /** Local (Asia/Riyadh, UTC+3) start hour. */
  hour: number;
  minutes: number;
}

describe('Patient Journey — data moves from the database to the API response', () => {
  let ds: DataSource;
  let svc: PatientJourneyService;

  let tenantId: string;
  let otherTenantId: string;
  const id = {} as Record<string, string>;
  const seeded: Seeded[] = [];

  const NOW = new Date('2031-03-15T00:00:00.000Z');
  const RANGE = { from: '2031-03-01', to: '2031-03-14' };
  const USER = {
    id: 'owner',
    tenantId: '',
    roles: [],
    permissions: [PERMISSION.ANALYTICS_DASHBOARD_READ],
  } as unknown as AuthenticatedUser;

  /** Riyadh is UTC+3 with no DST, so local hour h starts at (h-3):00Z. */
  const startAt = (day: number, hour: number) =>
    new Date(Date.UTC(2031, 2, day, hour - 3, 0, 0));

  /** Per (staff, day, hour) slot counter: one 15-min window each, so no staff member's intervals overlap. */
  const slots = new Map<string, number>();
  const nextStart = (staff: string, day: number, hour: number) => {
    const key = `${staff}|${day}|${hour}`;
    const n = slots.get(key) ?? 0;
    slots.set(key, n + 1);
    if (n > 3) throw new Error(`fixture overflow: more than 4 slots for ${key}`);
    return new Date(startAt(day, hour).getTime() + n * 15 * 60_000);
  };

  interface AppointmentSpec {
    service: 'A' | 'B' | 'C';
    staff: 'S1' | 'S2';
    branch: 'BR1' | 'BR2';
    day: number;
    hour: number;
    status?: AppointmentStatus;
    /** Consultation length in seconds on the queue row; omit for "no queue entry at all". */
    consultSeconds?: number;
  }

  async function seedAppointment(t: string, s: AppointmentSpec) {
    const start = nextStart(s.staff, s.day, s.hour);
    const end = new Date(start.getTime() + 15 * 60_000);
    const status = s.status ?? AppointmentStatus.COMPLETED;
    const appt = await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: t } as Tenant,
        branch: { id: id[s.branch] } as Branch,
        customer: { id: id.customer } as Customer,
        staff: { id: id[s.staff] } as StaffProfile,
        start_at: start,
        end_at: end,
        status,
        payment_status: AppointmentPaymentStatus.PAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
      }),
    );
    await ds.getRepository(AppointmentServiceEntity).save(
      ds.getRepository(AppointmentServiceEntity).create({
        tenant: { id: t } as Tenant,
        appointment: { id: appt.id } as Appointment,
        service: { id: id[s.service] } as Service,
        price: 100,
        duration_minutes: 30,
      }),
    );
    if (s.consultSeconds !== undefined) {
      const started = start;
      await ds.getRepository(QueueEntry).save(
        ds.getRepository(QueueEntry).create({
          tenant: { id: t } as Tenant,
          branch: { id: id[s.branch] } as Branch,
          customer: { id: id.customer } as Customer,
          staff: { id: id[s.staff] } as StaffProfile,
          appointment: { id: appt.id } as Appointment,
          business_date: start.toISOString().slice(0, 10),
          state: QueueState.COMPLETED,
          arrived_at: new Date(start.getTime() - 5 * 60_000),
          called_at: new Date(start.getTime() - 2 * 60_000),
          started_at: started,
          ended_at: new Date(started.getTime() + s.consultSeconds * 1000),
        }),
      );
    }
    return appt;
  }

  /** A completed, properly-timed consultation — also recorded in the oracle. */
  async function seedConsultation(s: Omit<AppointmentSpec, 'consultSeconds' | 'status'> & { minutes: number }) {
    await seedAppointment(tenantId, { ...s, consultSeconds: s.minutes * 60 });
    seeded.push({ service: s.service, staff: s.staff, branch: s.branch, day: s.day, hour: s.hour, minutes: s.minutes });
  }

  beforeAll(async () => {
    ds = await SeedDataSource.initialize();
    const suffix = randomUUID().slice(0, 8);

    const mkTenant = async (tag: string) =>
      (
        await ds.getRepository(Tenant).save(
          ds.getRepository(Tenant).create({
            name: `Journey RealData ${tag} ${suffix}`,
            slug: `journey-rd-${tag}-${suffix}`,
            contact_email: `journey-rd-${tag}-${suffix}@example.test`,
            approval_status: TenantApprovalStatus.APPROVED,
            is_active: true,
          }),
        )
      ).id;
    tenantId = await mkTenant('main');
    otherTenantId = await mkTenant('other');
    (USER as { tenantId: string }).tenantId = tenantId;

    const mkBranch = async (t: string, name: string) =>
      (
        await ds.getRepository(Branch).save(
          ds.getRepository(Branch).create({ tenant: { id: t } as Tenant, name, timezone: 'Asia/Riyadh' }),
        )
      ).id;
    id.BR1 = await mkBranch(tenantId, 'Branch One');
    id.BR2 = await mkBranch(tenantId, 'Branch Two');

    const mkStaff = async (t: string, tag: string) => {
      const user = await ds.getRepository(User).save(
        ds.getRepository(User).create({
          tenant: { id: t } as Tenant,
          // users.email is CHECK-constrained to lowercase (ck_user_email_lowercase); `tag` is mixed-case
          email: `rd-${tag}-${suffix}@example.test`.toLowerCase(),
          full_name: `Dr. ${tag}`,
          is_active: true,
        }),
      );
      return (
        await ds.getRepository(StaffProfile).save(
          ds.getRepository(StaffProfile).create({
            user: { id: user.id } as User,
            tenant: { id: t } as Tenant,
            public_slug: `rd-${tag}-${suffix}`,
          }),
        )
      ).id;
    };
    id.S1 = await mkStaff(tenantId, 'S1');
    id.S2 = await mkStaff(tenantId, 'S2');
    id.otherStaff = await mkStaff(otherTenantId, 'OT');

    const mkService = async (t: string, slug: string, name: string, minutes: number) =>
      (
        await ds.getRepository(Service).save(
          ds.getRepository(Service).create({
            tenant: { id: t } as Tenant,
            name,
            public_slug: slug,
            duration_minutes: minutes,
          }),
        )
      ).id;
    id.A = await mkService(tenantId, 'consultation', 'Consultation', 30);
    id.B = await mkService(tenantId, 'cleaning', 'Cleaning', 45);
    id.C = await mkService(tenantId, 'x-ray', 'X-Ray', 20);
    id.D = await mkService(tenantId, 'unused', 'Unused', 60); // active, never booked
    id.otherService = await mkService(otherTenantId, 'other-svc', 'Other Tenant Service', 25);

    const mkCustomer = async (t: string, tag: string) =>
      (
        await ds.getRepository(Customer).save(
          ds.getRepository(Customer).create({
            tenant: { id: t } as Tenant,
            full_name: `Patient ${tag}`,
            phone: `+96650${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
            email: `rd-patient-${tag}-${suffix}@example.test`,
          }),
        )
      ).id;
    id.customer = await mkCustomer(tenantId, 'main');
    id.otherCustomer = await mkCustomer(otherTenantId, 'other');

    // Service A (configured 30): 21 timed consultations = [25..55 step 5] x 3. S1 takes the first 14, S2 the last 7.
    const A_MIN = [25, 30, 35, 40, 45, 50, 55];
    for (let i = 0; i < 21; i++) {
      await seedConsultation({ service: 'A', staff: i < 14 ? 'S1' : 'S2', branch: 'BR1', day: 3 + (i % 7), hour: 9, minutes: A_MIN[i % 7] });
    }
    // Service B (configured 45): 20 consultations [43..47] x 4 — close to the configured length.
    const B_MIN = [43, 44, 45, 46, 47];
    for (let j = 0; j < 20; j++) {
      await seedConsultation({ service: 'B', staff: 'S1', branch: 'BR2', day: 3 + (j % 7), hour: 17, minutes: B_MIN[j % 5] });
    }
    // Service C (configured 20): only 12 consultations of 15 min — short of the 20 needed.
    for (let k = 0; k < 12; k++) {
      await seedConsultation({ service: 'C', staff: 'S2', branch: 'BR1', day: 3 + (k % 7), hour: 9, minutes: 15 });
    }

    // Negative cases, all on service A / BR1 / S1 / 09:00 local.
    const base = { service: 'A', staff: 'S1', branch: 'BR1', hour: 9 } as const;
    await seedAppointment(tenantId, { ...base, day: 3, consultSeconds: 30 }); // COMPLETED, 30-second consultation
    await seedAppointment(tenantId, { ...base, day: 4 }); // COMPLETED, no queue entry, no status log
    await seedAppointment(tenantId, { ...base, day: 5, status: AppointmentStatus.CANCELLED });
    await seedAppointment(tenantId, { ...base, day: 6, status: AppointmentStatus.NO_SHOW });

    // Another tenant: one completed 10-minute consultation of its own service, same days.
    const ot = await ds.getRepository(Appointment).save(
      ds.getRepository(Appointment).create({
        tenant: { id: otherTenantId } as Tenant,
        branch: { id: await mkBranch(otherTenantId, 'Other Branch') } as Branch,
        customer: { id: id.otherCustomer } as Customer,
        staff: { id: id.otherStaff } as StaffProfile,
        start_at: startAt(3, 9),
        end_at: new Date(startAt(3, 9).getTime() + 15 * 60_000),
        status: AppointmentStatus.COMPLETED,
        payment_status: AppointmentPaymentStatus.PAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
      }),
    );
    await ds.getRepository(AppointmentServiceEntity).save(
      ds.getRepository(AppointmentServiceEntity).create({
        tenant: { id: otherTenantId } as Tenant,
        appointment: { id: ot.id } as Appointment,
        service: { id: id.otherService } as Service,
        price: 100,
        duration_minutes: 25,
      }),
    );

    const noSettings = { findOne: async () => ({ currency: 'SAR', reminders_enabled: false, reminder_lead_minutes: [] }) };
    const advanced = new AdvancedAnalyticsService(
      { assertBranch: async () => undefined } as never,
      { getMembershipBranchIds: async () => [] } as never,
      noSettings as never,
      {
        // Only the reporting-timezone lookup goes through it; fixtures are UTC days.
        wrap: (_t: string, _n: string, key: string) =>
          key === 'reporting-timezone'
            ? Promise.resolve('UTC')
            : Promise.reject(new Error('advanced cache is not used by journey')),
      } as never,
    );
    svc = new PatientJourneyService(
      new JourneyAggregationService(ds.getRepository(Appointment)),
      advanced,
      { wrap: (_t: string, _n: string, _k: string, producer: () => Promise<unknown>) => producer() } as never,
      noSettings as never,
    );
  }, 120_000);

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      if (!tid) continue;
      for (const table of ['scheduled_notifications', 'queue_entries', 'appointment_status_logs', 'appointment_services', 'appointments', 'services', 'customers', 'staff_profiles', 'users', 'branches']) {
        await ds.query(`DELETE FROM ${table} WHERE "tenantId" = $1`, [tid]);
      }
      await ds.query(`DELETE FROM tenant_settings WHERE "tenant_id" = $1`, [tid]);
      await ds.query(`DELETE FROM tenants WHERE id = $1`, [tid]);
    }
    await ds.destroy();
  });

  const minutesOf = (rows: Seeded[]) => rows.map((r) => r.minutes);
  const only = (f: (s: Seeded) => boolean) => minutesOf(seeded.filter(f));
  const candidate = (out: Awaited<ReturnType<PatientJourneyService['summary']>>, name: string) =>
    out.durationSuggestionCandidates.find((c) => c.name === name);

  it('sanity: the oracle holds the dataset the requirement describes', () => {
    expect(only((s) => s.service === 'A')).toHaveLength(21);
    expect(percentile(only((s) => s.service === 'A'), 0.5)).toBe(40);
    expect(percentile(only((s) => s.service === 'A'), 0.75)).toBe(50);
  });

  it('service A (configured 30): actual p50/p75 and the suggestion come from the seeded consultations', async () => {
    const out = await svc.summary(tenantId, USER, RANGE, NOW);
    const a = candidate(out, 'Consultation');
    const aMinutes = only((s) => s.service === 'A');

    expect(a?.status).toBe('OK');
    expect(a?.configuredMinutes).toBe(30); // from services.duration_minutes, not from any appointment
    expect(a?.consultation.n).toBe(21); // the 30-second row is NOT counted
    expect(a?.consultation.p50).toBe(round1(percentile(aMinutes, 0.5)));
    expect(a?.consultation.p75).toBe(round1(percentile(aMinutes, 0.75)));
    expect([a?.consultation.p50, a?.consultation.p75]).toEqual([40, 50]); // hand-computed
    expect(a?.suggestedMinutes).toBe(50);
    expect(a?.direction).toBe('LONGER');
    expect(out.durationSuggestions.map((s) => s.name)).toEqual(['Consultation']);
  });

  it('service B is close to its configured length: reported as aligned, with real percentiles', async () => {
    const out = await svc.summary(tenantId, USER, RANGE, NOW);
    const b = candidate(out, 'Cleaning');
    const bMinutes = only((s) => s.service === 'B');

    expect(b?.status).toBe('ALREADY_ALIGNED');
    expect(b?.configuredMinutes).toBe(45);
    expect(b?.consultation.n).toBe(20);
    expect(b?.consultation.p75).toBe(round1(percentile(bMinutes, 0.75)));
    expect(b?.direction).toBeNull();
  });

  it('service C has only 12 timed consultations: insufficient sample, no percentiles exposed', async () => {
    const out = await svc.summary(tenantId, USER, RANGE, NOW);
    const c = candidate(out, 'X-Ray');

    expect(c?.status).toBe('INSUFFICIENT_SAMPLE');
    expect(c?.consultation.n).toBe(12);
    expect(c?.consultation.p50).toBeNull();
    expect(c?.consultation.p75).toBeNull();
    expect(out.thresholds.minDurationSample).toBe(20);
  });

  it('a service that was never booked does not appear, and the panel state stays null', async () => {
    const out = await svc.summary(tenantId, USER, RANGE, NOW);
    expect(candidate(out, 'Unused')).toBeUndefined();
    expect(out.durationSuggestionsState).toBeNull();
  });

  it('negative cases: sub-minute, unstarted, cancelled and no-show rows are excluded from duration and reported', async () => {
    const out = await svc.summary(tenantId, USER, RANGE, NOW);

    expect(out.counts.booked).toBe(57); // 21 + 20 + 12 + 4 negatives
    expect(out.counts.completed).toBe(55); // 53 timed + 30-second + unstarted
    expect(out.counts.cancelled).toBe(1);
    expect(out.counts.noShow).toBe(1);
    expect(out.counts.noShowRate).toBe(Math.round((1 / 57) * 1000) / 1000);
    expect(out.dataQuality.consultationTooShort).toBe(1);
    expect(out.dataQuality.completedWithoutStart).toBe(1);
    expect(out.kpis.consultation.n).toBe(53);
  });

  it('the clinic-wide consultation KPI equals the oracle over every timed consultation', async () => {
    const out = await svc.summary(tenantId, USER, RANGE, NOW);
    const all = minutesOf(seeded);

    expect(out.kpis.consultation.suppressed).toBeNull();
    expect(out.kpis.consultation.p50).toBe(round1(percentile(all, 0.5)));
    expect(out.kpis.consultation.p75).toBe(round1(percentile(all, 0.75)));
    expect(out.kpis.consultation.p90).toBe(round1(percentile(all, 0.9)));
  });

  it('SERVICE filter changes the result', async () => {
    const b = await svc.summary(tenantId, USER, { ...RANGE, serviceId: id.B }, NOW);
    const bMinutes = only((s) => s.service === 'B');

    expect(b.counts.booked).toBe(20);
    expect(b.kpis.consultation.n).toBe(20);
    expect(b.kpis.consultation.p50).toBe(round1(percentile(bMinutes, 0.5)));
    expect(b.kpis.consultation.p50).not.toBe(40); // A's median — proves the filter is applied
  });

  it('STAFF filter changes the result', async () => {
    const s1 = await svc.summary(tenantId, USER, { ...RANGE, staffId: id.S1 }, NOW);
    const s2 = await svc.summary(tenantId, USER, { ...RANGE, staffId: id.S2 }, NOW);

    expect(candidate(s1, 'Consultation')?.consultation.n).toBe(only((s) => s.service === 'A' && s.staff === 'S1').length);
    expect(candidate(s1, 'Consultation')?.status).toBe('INSUFFICIENT_SAMPLE'); // 14 < 20 once narrowed to one doctor
    expect(candidate(s2, 'Consultation')?.consultation.n).toBe(7);
    expect(candidate(s2, 'X-Ray')?.consultation.n).toBe(12);
    expect(candidate(s2, 'Cleaning')).toBeUndefined(); // S2 never did service B
  });

  it('DATE filter changes the result', async () => {
    const monToWed = await svc.summary(tenantId, USER, { from: '2031-03-03', to: '2031-03-05' }, NOW);
    const expected = only((s) => s.service === 'A' && s.day <= 5).length;

    expect(expected).toBe(9);
    expect(candidate(monToWed, 'Consultation')?.consultation.n).toBe(expected);
    expect(candidate(monToWed, 'Consultation')?.status).toBe('INSUFFICIENT_SAMPLE');
  });

  it('BRANCH filter changes the result', async () => {
    const br2 = await svc.summary(tenantId, USER, { ...RANGE, branchId: id.BR2 }, NOW);

    expect(br2.durationSuggestionCandidates.map((c) => c.name)).toEqual(['Cleaning']);
    expect(br2.counts.booked).toBe(20);
  });

  const breakdown = (dimension: 'hour' | 'weekday' | 'staff' | 'service', extra: object = {}) =>
    svc.breakdown(tenantId, USER, { ...RANGE, dimension, sort: 'appointments', page: 1, limit: 100, ...extra } as never, NOW);

  // Every booked appointment (timed + the 4 negatives, which sit on days 3-6, service A, S1, 09:00).
  const NEGATIVE_DAYS = [3, 4, 5, 6];

  it('HOUR breakdown uses the appointment-local hour (Riyadh, UTC+3), not the UTC hour', async () => {
    const out = await breakdown('hour');
    const byKey = Object.fromEntries(out.data.map((r) => [r.key, r]));

    // seeded 06:00Z -> 09:00 local and 14:00Z -> 17:00 local; a UTC bucketing would say 6 and 14.
    expect(byKey['9'].appointments).toBe(only((s) => s.hour === 9).length + NEGATIVE_DAYS.length); // 33 + 4
    expect(byKey['17'].appointments).toBe(only((s) => s.hour === 17).length); // 20
    expect(byKey['6']?.appointments ?? 0).toBe(0);
    expect(byKey['14']?.appointments ?? 0).toBe(0);
    expect(byKey['9'].consultation.p50).toBe(round1(percentile(only((s) => s.hour === 9), 0.5)));
    expect(byKey['17'].consultation.p50).toBe(round1(percentile(only((s) => s.hour === 17), 0.5)));
  });

  it('WEEKDAY breakdown maps 2031-03-03 to Monday (ISO 1) ... 2031-03-09 to Sunday (7)', async () => {
    const out = await breakdown('weekday');
    const byKey = Object.fromEntries(out.data.map((r) => [r.key, r]));

    for (let dow = 1; dow <= 7; dow++) {
      const day = dow + 2; // 3 -> Monday
      const expected = seeded.filter((s) => s.day === day).length + NEGATIVE_DAYS.filter((d) => d === day).length;
      expect(byKey[String(dow)].appointments).toBe(expected);
    }
    // ~7-8 timed consultations per weekday is under the per-row minimum, so each value is suppressed, never shown as a false number
    expect(byKey['1'].consultation.p50).toBeNull();
    expect(byKey['1'].consultation.suppressed).toBe('INSUFFICIENT_SAMPLE');
  });

  it('STAFF and SERVICE breakdowns equal the oracle', async () => {
    const staff = await breakdown('staff');
    const perStaff = Object.fromEntries(staff.data.map((r) => [r.key, r.appointments]));
    expect(perStaff[id.S1]).toBe(seeded.filter((s) => s.staff === 'S1').length + NEGATIVE_DAYS.length);
    expect(perStaff[id.S2]).toBe(seeded.filter((s) => s.staff === 'S2').length);

    const service = await breakdown('service');
    const perService = Object.fromEntries(service.data.map((r) => [r.key, r]));
    expect(perService[id.A].appointments).toBe(21 + NEGATIVE_DAYS.length);
    expect(perService[id.B].consultation.p50).toBe(round1(percentile(only((s) => s.service === 'B'), 0.5)));
    expect(perService[id.D]).toBeUndefined(); // never booked
  });

  it('drilling into a service narrows the breakdown', async () => {
    const out = await breakdown('hour', { serviceId: id.B });
    const rows = out.data.filter((r) => r.appointments > 0);
    expect(rows.map((r) => r.key)).toEqual(['17']);
    expect(rows[0].appointments).toBe(20);
  });

  it('TENANT ISOLATION: another tenant\'s service and appointment never appear', async () => {
    const out = await svc.summary(tenantId, USER, RANGE, NOW);
    expect(out.durationSuggestionCandidates.map((c) => c.name)).not.toContain('Other Tenant Service');
    expect(out.counts.booked).toBe(57); // not 58

    const otherUser = { ...USER, tenantId: otherTenantId } as AuthenticatedUser;
    const theirs = await svc.summary(otherTenantId, otherUser, RANGE, NOW);
    expect(theirs.counts.booked).toBe(1);
    expect(theirs.durationSuggestionCandidates.map((c) => c.name)).toEqual(['Other Tenant Service']);
  });

  it('TENANT ISOLATION: a foreign staff or service id is rejected, not silently treated as empty', async () => {
    await expect(svc.summary(tenantId, USER, { ...RANGE, serviceId: id.otherService }, NOW)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await expect(svc.summary(tenantId, USER, { ...RANGE, staffId: id.otherStaff }, NOW)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await expect(breakdown('hour', { serviceId: id.otherService })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('a range with no appointments is empty, and says so', async () => {
    const out = await svc.summary(tenantId, USER, { from: '2031-04-01', to: '2031-04-10' }, NOW);
    expect(out.empty).toBe(true);
    expect(out.counts.booked).toBe(0);
    expect(out.durationSuggestionCandidates).toEqual([]);
    expect(out.durationSuggestionsState).toBe('NO_SERVICE_APPOINTMENTS'); // services exist; none booked in range
  });
});
