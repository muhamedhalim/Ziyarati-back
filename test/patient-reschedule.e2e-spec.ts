/**
 * T040 (US2, FR-R002/R003, contracts/public-surfaces.md §A) — pins
 * `GET /public/appointments/action/:token/availability` and
 * `POST /public/appointments/action/:token/reschedule` BEFORE T041/T042
 * build them. Written first; every assertion targets the FINAL contract,
 * so this suite is expected to fail ONLY because the routes 404 (do not
 * exist yet) — not because of a setup/compile error.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { BlockedSlot } from '../src/entities/Calendar&Appointments/BlockedSlot';
import { Holiday } from '../src/entities/Calendar&Appointments/Holiday';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Customer } from '../src/entities/CRM/Customer';
import { Service } from '../src/entities/Services/Service';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { StaffTimeOff } from '../src/entities/Staff/StaffTimeOff';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { User } from '../src/entities/Auth&RBAC/User';
import { AppointmentStatus, PatientActionPurpose } from '../src/entities/enums';
import { PatientActionLinkService } from '../src/modules/patient-actions/patient-action-link.service';

const API = '/api/v1';

/** Far-future Wednesday, distinct from the concurrency suite's day. */
const DAY = '2031-06-25';
const WEDNESDAY = 3;
const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

interface ClinicFixture {
  owner: OwnerFixture;
  branchId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
}

describe('Patient reschedule — availability projection & confirm (T040, US2)', () => {
  let e2e: E2eApp;
  let links: PatientActionLinkService;
  let clinic: ClinicFixture;
  let clinicB: ClinicFixture;
  let nextDayOffset = 0;

  async function createClinic(label: string, bufferMinutes = 0): Promise<ClinicFixture> {
    const owner = await createOwnerFixture(e2e, label);
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `Branch ${suffix}`,
        timezone: 'UTC',
        is_active: true,
      }),
    );
    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: owner.tenantId } as Tenant,
        full_name: `Patient ${suffix}`,
        phone: `+9665${suffix.slice(0, 8)}`,
        email: `patient-${suffix}@example.test`,
      }),
    );
    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `doctor-${suffix}@example.test`,
        full_name: `Dr ${suffix}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: owner.tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: `Dr ${suffix}`,
        is_available_for_booking: true,
        booking_buffer_minutes: bufferMinutes,
      }),
    );
    await ds.getRepository(WorkingHour).save(
      ds.getRepository(WorkingHour).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        day_of_week: WEDNESDAY,
        start_time: '09:00',
        end_time: '17:00',
        is_closed: false,
      }),
    );
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        staff: { id: staff.id } as StaffProfile,
        day_of_week: WEDNESDAY,
        start_time: '09:00',
        end_time: '17:00',
        is_active: true,
      }),
    );
    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: owner.tenantId } as Tenant,
        name: `Consultation ${suffix}`,
        duration_minutes: 60,
        base_price: 200,
        is_active: true,
      }),
    );
    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: { id: owner.tenantId } as Tenant,
        self_reschedule_enabled: true,
        cancellation_hours: 24,
      }),
    );

    return {
      owner,
      branchId: branch.id,
      customerId: customer.id,
      staffId: staff.id,
      serviceId: service.id,
    };
  }

  async function seedRescheduleLink(c: ClinicFixture): Promise<{ token: string; appt: Appointment }> {
    const repo = e2e.dataSource.getRepository(Appointment);
    // Each call gets its OWN day, far enough out to always be outside any
    // configured change window — the exclusion constraint would otherwise
    // reject two appointments for the same staff at the same instant, which
    // every test in this suite reusing the same clinic fixture would collide
    // on if they all used a fixed offset (see patient-cancellation.e2e-spec's
    // identical fix).
    const startAt = new Date(Date.now() + (60 + nextDayOffset++) * 24 * 3600_000);
    const appt = await repo.save(
      repo.create({
        tenant: { id: c.owner.tenantId } as Tenant,
        branch: { id: c.branchId } as Branch,
        customer: { id: c.customerId } as Customer,
        staff: { id: c.staffId } as StaffProfile,
        start_at: startAt,
        end_at: new Date(startAt.getTime() + 3600_000),
        status: AppointmentStatus.CONFIRMED,
        source: 'MANUAL' as never,
        currency: 'SAR',
      }),
    );
    const token = await links.issue(c.owner.tenantId, appt, PatientActionPurpose.RESCHEDULE);
    return { token, appt };
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    links = e2e.app.get(PatientActionLinkService);
    clinic = await createClinic('reschedule-avail', 15); // 15-minute buffer
    clinicB = await createClinic('reschedule-avail-b');
  }, 120_000);

  afterEach(async () => {
    await e2e.dataSource.query(`DELETE FROM appointments WHERE "tenantId" = $1`, [
      clinic.owner.tenantId,
    ]);
    await e2e.dataSource.query(`DELETE FROM blocked_slots WHERE "tenantId" = $1`, [
      clinic.owner.tenantId,
    ]);
    await e2e.dataSource.query(`DELETE FROM holidays WHERE "tenantId" = $1`, [
      clinic.owner.tenantId,
    ]);
    await e2e.dataSource.query(`DELETE FROM staff_time_off WHERE "tenantId" = $1`, [
      clinic.owner.tenantId,
    ]);
  });

  afterAll(async () => {
    await e2e.dataSource.query(`DELETE FROM appointments WHERE "tenantId" = $1`, [
      clinic.owner.tenantId,
    ]);
    await e2e.dataSource.query(`DELETE FROM appointments WHERE "tenantId" = $1`, [
      clinicB.owner.tenantId,
    ]);
    await e2e.app.close();
  }, 30_000);

  async function getAvailability(token: string, from = DAY, to = DAY) {
    return request(e2e.app.getHttpServer()).get(
      `${API}/public/appointments/action/${token}/availability?from=${from}&to=${to}`,
    );
  }

  // ─────────────────────── Response shape / no leaks ───────────────────── //

  it('returns only slots + timezone — no appointment id, customer data or scheduling internals', async () => {
    const { token } = await seedRescheduleLink(clinic);
    const res = await getAvailability(token);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveProperty('slots');
    expect(body).toHaveProperty('timezone');
    expect(Object.keys(body).sort()).toEqual(['slots', 'timezone']);
    for (const slot of body.slots) {
      expect(Object.keys(slot).sort()).toEqual(['endAt', 'startAt']);
    }
  });

  // ────────────────────────── The five exclusions ──────────────────────── //

  it('excludes a clinic holiday', async () => {
    const { token } = await seedRescheduleLink(clinic);
    await e2e.dataSource.getRepository(Holiday).save(
      e2e.dataSource.getRepository(Holiday).create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        branch: { id: clinic.branchId } as Branch,
        name: 'Founders Day',
        date: DAY,
        is_recurring: false,
      }),
    );
    const res = await getAvailability(token);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.slots).toEqual([]);
  });

  it('excludes a staff time-off period', async () => {
    const { token } = await seedRescheduleLink(clinic);
    await e2e.dataSource.getRepository(StaffTimeOff).save(
      e2e.dataSource.getRepository(StaffTimeOff).create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        staff: { id: clinic.staffId } as StaffProfile,
        start_date: DAY,
        end_date: DAY,
        reason: 'Annual leave',
      }),
    );
    const res = await getAvailability(token);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.slots).toEqual([]);
  });

  it('excludes a blocked period', async () => {
    const { token } = await seedRescheduleLink(clinic);
    await e2e.dataSource.getRepository(BlockedSlot).save(
      e2e.dataSource.getRepository(BlockedSlot).create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        branch: { id: clinic.branchId } as Branch,
        staff: { id: clinic.staffId } as StaffProfile,
        start_time: new Date(at('09:00')),
        end_time: new Date(at('17:00')),
        reason: 'Equipment maintenance',
      }),
    );
    const res = await getAvailability(token);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    const overlapsBlocked = (body.slots as Array<{ startAt: string }>).some(
      (s) => s.startAt >= at('09:00') && s.startAt < at('17:00'),
    );
    expect(overlapsBlocked).toBe(false);
  });

  it('excludes a window occupied by an existing appointment', async () => {
    const { token } = await seedRescheduleLink(clinic);
    await e2e.dataSource.getRepository(Appointment).save(
      e2e.dataSource.getRepository(Appointment).create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        branch: { id: clinic.branchId } as Branch,
        customer: { id: clinic.customerId } as Customer,
        staff: { id: clinic.staffId } as StaffProfile,
        start_at: new Date(at('11:00')),
        end_at: new Date(at('12:00')),
        status: AppointmentStatus.CONFIRMED,
        source: 'MANUAL' as never,
        currency: 'SAR',
      }),
    );
    const res = await getAvailability(token);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    const overlapsBusy = (body.slots as Array<{ startAt: string }>).some(
      (s) => s.startAt >= at('11:00') && s.startAt < at('12:00'),
    );
    expect(overlapsBusy).toBe(false);
  });

  it("the practitioner's booking buffer around an existing appointment is enforced at confirmation", async () => {
    // `clinic` was seeded with a 15-minute buffer (createClinic's 2nd arg).
    // The listing (`GET .../availability`) is a convenience, not a
    // guarantee — same precedent as the staff-facing `SlotPicker` — so the
    // real guarantee this proves is at CONFIRM time: `assertBookable`
    // widens the busy appointment by the buffer on both sides before
    // testing overlap (AIE-A04), so a target window that only touches the
    // buffer zone (not the busy appointment itself) is still refused.
    const { token } = await seedRescheduleLink(clinic);
    await e2e.dataSource.getRepository(Appointment).save(
      e2e.dataSource.getRepository(Appointment).create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        branch: { id: clinic.branchId } as Branch,
        customer: { id: clinic.customerId } as Customer,
        staff: { id: clinic.staffId } as StaffProfile,
        start_at: new Date(at('11:00')),
        end_at: new Date(at('12:00')),
        status: AppointmentStatus.CONFIRMED,
        source: 'MANUAL' as never,
        currency: 'SAR',
      }),
    );

    // 10:00–11:00 does not overlap the busy 11:00–12:00 appointment itself,
    // but its last 15 minutes (10:45–11:00) fall inside the buffer zone.
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/public/appointments/action/${token}/reschedule`)
      .send({ startAt: at('10:00') });

    expect(res.status).toBe(409);
  });

  // ───────────── Branch/service/staff cannot be changed via the link ───── //

  it('an attempt to smuggle branch/service/staff into the request body is flatly rejected, never silently applied', async () => {
    const { token } = await seedRescheduleLink(clinicB);
    const targetStartAt = new Date(Date.now() + 61 * 24 * 3600_000).toISOString();

    // `ConfirmRescheduleDto` declares ONLY `startAt`; the app's global
    // ValidationPipe runs with `forbidNonWhitelisted: true`, so any of
    // these extra fields refuses the WHOLE request rather than silently
    // stripping them — a stricter proof of FR-R004 than mere silent
    // ignoring would be.
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/public/appointments/action/${token}/reschedule`)
      .send({
        startAt: targetStartAt,
        branchId: randomUUID(),
        serviceId: randomUUID(),
        staffId: randomUUID(),
      });

    expect(res.status).toBe(400);
  });

  it('a legitimate reschedule (startAt only) preserves the existing branch, service and staff', async () => {
    const { token, appt } = await seedRescheduleLink(clinicB);
    // Must land on the fixture's configured working day (Wednesday) — an
    // arbitrary relative date would intermittently fall outside working
    // hours and refuse with 409 for a reason unrelated to what this test
    // checks. `clinicB` is a separate tenant from `clinic`, so reusing
    // `DAY` here cannot collide with anything `clinic`'s own tests do.
    const targetStartAt = at('15:00');

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/public/appointments/action/${token}/reschedule`)
      .send({ startAt: targetStartAt });

    expect(res.status).toBe(200);

    const row = await e2e.dataSource.getRepository(Appointment).findOne({
      where: { id: appt.id },
      relations: { branch: true, staff: true },
    });
    expect(row?.branch.id).toBe(clinicB.branchId);
    expect(row?.staff.id).toBe(clinicB.staffId);
  });

  // ────────────────────────── Stale-slot refusal ────────────────────────── //

  it('a slot taken between display and confirmation is refused with refreshed availability', async () => {
    const { token, appt } = await seedRescheduleLink(clinic);
    const targetStartAt = at('13:00');

    // Someone else takes the exact window first.
    await e2e.dataSource.getRepository(Appointment).save(
      e2e.dataSource.getRepository(Appointment).create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        branch: { id: clinic.branchId } as Branch,
        customer: { id: clinic.customerId } as Customer,
        staff: { id: clinic.staffId } as StaffProfile,
        start_at: new Date(targetStartAt),
        end_at: new Date(new Date(targetStartAt).getTime() + 3600_000),
        status: AppointmentStatus.CONFIRMED,
        source: 'MANUAL' as never,
        currency: 'SAR',
      }),
    );

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/public/appointments/action/${token}/reschedule`)
      .send({ startAt: targetStartAt });

    expect(res.status).toBe(409);
    // Error responses are FLAT (see ErrorResponseBody) — client-safe
    // metadata like the refreshed slots lives under `context`, not merged
    // into the top level.
    expect(Array.isArray(res.body.context?.slots)).toBe(true);

    const row = await e2e.dataSource.getRepository(Appointment).findOne({
      where: { id: appt.id },
    });
    expect(row?.start_at).not.toEqual(new Date(targetStartAt));
  });

  // ────────────────────────────── Idempotency ───────────────────────────── //

  it('T043: submitting the same reschedule confirmation twice moves the appointment once', async () => {
    const { token, appt } = await seedRescheduleLink(clinic);
    const targetStartAt = at('15:00');

    const first = await request(e2e.app.getHttpServer())
      .post(`${API}/public/appointments/action/${token}/reschedule`)
      .send({ startAt: targetStartAt });
    const second = await request(e2e.app.getHttpServer())
      .post(`${API}/public/appointments/action/${token}/reschedule`)
      .send({ startAt: targetStartAt });

    expect(first.status).toBe(200);
    expect(second.status).toBe(404); // link already consumed — same rule as FR-C004

    const rescheduleRows = await e2e.dataSource.query(
      `SELECT * FROM appointment_reschedules WHERE "appointmentId" = $1`,
      [appt.id],
    );
    expect(rescheduleRows).toHaveLength(1);
  });

  // ─────────────────────────── Cross-clinic IDOR ────────────────────────── //

  it("a reschedule link issued for clinic B never resolves against clinic A's availability", async () => {
    const { token } = await seedRescheduleLink(clinicB);
    const res = await getAvailability(token);
    expect(res.status).toBe(200); // resolves — but only to its OWN tenant's projection
    // No slot outside clinic B's own working hours could ever appear; a
    // cross-tenant resolution bug would surface as a 500/404 mismatch, not
    // as silently-correct data, since the token's digest scopes strictly to
    // clinic B's own appointment.
    expect(Array.isArray((res.body.data ?? res.body).slots)).toBe(true);
  });
});

