/**
 * Staff-availability enforcement for booking — real Postgres, real HTTP.
 *
 * The rule under test: an appointment may only exist when the staff member is
 * genuinely free — working that day, not on time off, not on a holiday, not
 * inside a blocked period, and not already booked — no matter which surface
 * asks (reception, admin, the AI assistant, the integration API). Every one of
 * those funnels through `AppointmentsService.create`, so this suite drives the
 * REST surface and asserts the rule the whole system inherits from it.
 *
 * Why this must run against a migration-built database: the double-booking
 * guarantee is the `appointments_no_overlap` EXCLUSION constraint, which lives
 * only in migration SQL (TypeORM cannot express EXCLUDE in entity metadata). A
 * `TYPEORM_SYNCHRONIZE=true` database has the constraint MISSING while looking
 * otherwise complete, so the concurrency test below would pass vacuously —
 * both requests succeed and nothing notices. Provision with
 * `node test/setup-e2e-db.js` and run with `TYPEORM_SYNCHRONIZE=false`; the
 * first test in this file asserts the constraint is actually installed so a
 * misconfigured run fails loudly instead of proving nothing.
 *
 * Billing mode is left at its FREE default (see `subscription-e2e-fixtures`),
 * so quota metering is a no-op here and every rejection observed is the
 * availability engine's, never a usage limit's.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
  grantSystemRole,
} from './utils/whatsapp-e2e-app';

import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { OutboxJob } from '../src/entities/Campaigns/OutboxJob';
import { QUEUE, JOB } from '../src/queue/queue.constants';
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
import { AppointmentStatus, AppointmentSource } from '../src/entities/enums';
import { ErrorCode } from '../src/common/errors';
import { BookabilityReason } from '../src/modules/scheduling/scheduling.constants';

const API = '/api/v1';

/**
 * A Wednesday, deliberately far in the future so nothing here collides with
 * seeded data and `assertChronological`'s past-date rule never fires.
 * Branch timezone is forced to UTC in the fixture, so these wall-clock times
 * are also the stored instants — the timezone-specific behaviour is covered by
 * the branch-timezone test at the end rather than smeared through every case.
 */
const DAY = '2031-05-14';
const WEDNESDAY = 3;
const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

interface ClinicFixture {
  owner: OwnerFixture;
  branchId: string;
  customerId: string;
  staffId: string;
  /** 60-minute service — one service = one clean hour of appointment. */
  serviceId: string;
  /** 30-minute service, for windows that must differ in length. */
  shortServiceId: string;
}

describe('Appointment staff-availability enforcement (container-backed) — real Postgres', () => {
  let e2e: E2eApp;
  /** Primary clinic. A second one is created per-test where isolation is the subject. */
  let clinic: ClinicFixture;

  // ───────────────────────────── Fixtures ──────────────────────────────── //

  /**
   * A clinic that is fully configured for booking: an open branch (09:00–17:00
   * on the test weekday), a doctor scheduled at that branch for those hours, a
   * patient, and two services of different lengths.
   */
  async function createClinic(label: string): Promise<ClinicFixture> {
    const owner = await createOwnerFixture(e2e, label);
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `Branch ${suffix}`,
        // UTC keeps wall-clock == stored instant for every case but the
        // dedicated timezone test below.
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

    // A StaffProfile is 1:1 with a User, so the doctor needs their own account.
    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `doctor-${suffix}@example.test`,
        full_name: `Dr ${suffix}`,
        is_active: true,
      }),
    );
    // A staff member is only bookable when the account holds a doctor/nurse/branch-manager role.
    await grantSystemRole(e2e, staffUser.id, 'doctor');
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: owner.tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: `Dr ${suffix}`,
        is_available_for_booking: true,
      }),
    );

    // Branch open hours + the doctor's own schedule. The engine books only
    // inside the INTERSECTION of the two.
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
    const shortService = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: owner.tenantId } as Tenant,
        name: `Follow-up ${suffix}`,
        duration_minutes: 30,
        base_price: 100,
        is_active: true,
      }),
    );

    return {
      owner,
      branchId: branch.id,
      customerId: customer.id,
      staffId: staff.id,
      serviceId: service.id,
      shortServiceId: shortService.id,
    };
  }

  /** POST /appointments as the clinic's owner. */
  const book = (
    c: ClinicFixture,
    startAt: string,
    overrides: Record<string, unknown> = {},
  ) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/appointments`)
      .set(...authHeader(c.owner.token))
      .send({
        branchId: c.branchId,
        customerId: c.customerId,
        staffId: c.staffId,
        startAt,
        serviceIds: [c.serviceId],
        ...overrides,
      });

  /** Seeds an appointment directly, bypassing HTTP — the "already booked" setup. */
  async function seedAppointment(
    c: ClinicFixture,
    startHhmm: string,
    endHhmm: string,
    status: AppointmentStatus = AppointmentStatus.CONFIRMED,
    source: AppointmentSource = AppointmentSource.MANUAL,
  ): Promise<Appointment> {
    const repo = e2e.dataSource.getRepository(Appointment);
    return repo.save(
      repo.create({
        tenant: { id: c.owner.tenantId } as Tenant,
        branch: { id: c.branchId } as Branch,
        customer: { id: c.customerId } as Customer,
        staff: { id: c.staffId } as StaffProfile,
        start_at: new Date(at(startHhmm)),
        end_at: new Date(at(endHhmm)),
        status,
        source,
        currency: 'SAR',
      }),
    );
  }

  const setEnforceWorkingHours = async (
    tenantId: string,
    on: boolean,
  ): Promise<void> => {
    const repo = e2e.dataSource.getRepository(TenantSetting);
    const existing = await repo.findOne({ where: { tenant: { id: tenantId } } });
    await repo.save(
      existing
        ? { ...existing, enforce_staff_working_hours: on }
        : repo.create({
            tenant: { id: tenantId } as Tenant,
            enforce_staff_working_hours: on,
          }),
    );
  };

  beforeAll(async () => {
    e2e = await createE2eApp();
    clinic = await createClinic('availability');
  }, 120_000);

  afterEach(async () => {
    // Each test owns the whole day for its clinic — wipe every booking so the
    // next one starts from a clear calendar. Cheaper and far less brittle than
    // per-test tenants, and it keeps the exclusion constraint honest.
    await e2e.dataSource.query(
      `DELETE FROM appointments WHERE "tenantId" = $1`,
      [clinic.owner.tenantId],
    );
    await e2e.dataSource.query(
      `DELETE FROM blocked_slots WHERE "tenantId" = $1`,
      [clinic.owner.tenantId],
    );
    await e2e.dataSource.query(`DELETE FROM holidays WHERE "tenantId" = $1`, [
      clinic.owner.tenantId,
    ]);
    await e2e.dataSource.query(
      `DELETE FROM staff_time_off WHERE "tenantId" = $1`,
      [clinic.owner.tenantId],
    );
    await setEnforceWorkingHours(clinic.owner.tenantId, false);
  });

  afterAll(async () => {
    await e2e.app.close();
  }, 30_000);

  // ─────────────────── The guarantee this suite depends on ─────────────── //

  it('the appointments_no_overlap EXCLUSION constraint is installed', async () => {
    // Without this, every concurrency assertion below is vacuous — see the
    // module docstring. Fail here rather than silently proving nothing.
    const rows = await e2e.dataSource.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'appointments_no_overlap'`,
    );
    expect(rows).toHaveLength(1);
  });

  // ────────────────────────── The happy path ───────────────────────────── //

  it('books an available staff member inside their working hours', async () => {
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(201);
    expect(res.body.data?.start_at ?? res.body.start_at).toBeDefined();
  });

  // P1.5 (MS-007) — real Postgres, real HTTP: the durability fix itself is
  // that this row exists the instant the booking transaction commits, not
  // that a listener eventually gets around to reading it back. Mirrors the
  // established outbox-row check in `webhooks.e2e-spec.ts` for the sibling
  // `appointment.created` → webhook path.
  it('[P1.5] a successful booking writes a reminders.schedule outbox row in the same commit', async () => {
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(201);
    const appointmentId = res.body.data?.id ?? res.body.id;

    const outboxRow = await e2e.dataSource.getRepository(OutboxJob).findOne({
      where: { job_name: JOB.REMINDERS_SCHEDULE, queue: QUEUE.NOTIFICATIONS },
      order: { created_at: 'DESC' },
    });

    expect(outboxRow).toBeTruthy();
    expect(outboxRow!.dedupe_key).toBe(`reminders-schedule-${appointmentId}`);
    expect(outboxRow!.payload).toMatchObject({
      tenantId: clinic.owner.tenantId,
      appointmentId,
    });
  });

  // ─────────────────────── Working-hours enforcement ───────────────────── //

  it('rejects a window outside the configured working hours', async () => {
    // 03:00 is outside the 09:00–17:00 schedule that IS configured, so this is
    // refused regardless of the per-clinic strictness flag.
    const res = await book(clinic, at('03:00'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
    expect(res.body.context.reasonCodes).toContain(
      BookabilityReason.OUTSIDE_WORKING_HOURS,
    );
  });

  /**
   * A bookable doctor with NO recurring schedule at all. The clinic's own doctor has a Wednesday
   * schedule, and a staff member with ANY schedule is restricted to it regardless of the clinic-wide
   * toggle (availability.service.ts: rule (b)) — so "a day nothing configures" can only be exercised
   * with someone nothing configures.
   */
  async function createUnscheduledDoctor(c: ClinicFixture): Promise<string> {
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: c.owner.tenantId } as Tenant,
        email: `unscheduled-${suffix}@example.test`,
        full_name: `Dr Unscheduled ${suffix}`,
        is_active: true,
      }),
    );
    await grantSystemRole(e2e, user.id, 'doctor');
    const profile = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: c.owner.tenantId } as Tenant,
        user: { id: user.id } as User,
        title: `Dr Unscheduled ${suffix}`,
        is_available_for_booking: true,
      }),
    );
    return profile.id;
  }

  it('allows any hour for a staff member with NO schedule configured while the clinic has not opted in', async () => {
    // Thursday, and a doctor with no StaffSchedule at all. Default behaviour is permissive so clinics
    // that never maintain schedules are not locked out of their own calendar.
    await setEnforceWorkingHours(clinic.owner.tenantId, false);
    const staffId = await createUnscheduledDoctor(clinic);
    const res = await book(clinic, '2031-05-15T03:00:00.000Z', { staffId });
    expect(res.status).toBe(201);
  });

  it('a staff member WITH a working-days schedule is restricted to it even when the clinic has not opted in', async () => {
    // The per-employee rule is enforced from the moment a schedule exists, independent of the toggle.
    await setEnforceWorkingHours(clinic.owner.tenantId, false);
    const res = await book(clinic, '2031-05-15T03:00:00.000Z');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
    expect(res.body.context.reasonCodes).toContain(
      BookabilityReason.OUTSIDE_WORKING_HOURS,
    );
  });

  it('rejects the same unconfigured day once the clinic opts into strict working hours', async () => {
    await setEnforceWorkingHours(clinic.owner.tenantId, true);
    const res = await book(clinic, '2031-05-15T03:00:00.000Z');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
    expect(res.body.context.reasonCodes).toContain(
      BookabilityReason.OUTSIDE_WORKING_HOURS,
    );
  });

  // ───────────────────────── Overlap semantics ─────────────────────────── //

  it('rejects an identical window for a staff member who is already booked', async () => {
    await seedAppointment(clinic, '10:00', '11:00');
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
    expect(res.body.context.reasonCodes).toContain(BookabilityReason.OCCUPIED);
  });

  it('rejects a partially overlapping window (10:30–11:30 against 10:00–11:00)', async () => {
    await seedAppointment(clinic, '10:00', '11:00');
    const res = await book(clinic, at('10:30'));
    expect(res.status).toBe(409);
    expect(res.body.context.reasonCodes).toContain(BookabilityReason.OCCUPIED);
  });

  // The half-open `[)` rule, at BOTH layers (the engine and the exclusion
  // constraint). Back-to-back bookings are legal and must stay legal — pinned
  // here so a future "add a buffer" change cannot land silently.
  it('ALLOWS an adjacent window (11:00–12:00 straight after 10:00–11:00)', async () => {
    await seedAppointment(clinic, '10:00', '11:00');
    const res = await book(clinic, at('11:00'));
    expect(res.status).toBe(201);
  });

  it('does not block on a CANCELLED appointment — cancelling frees the slot immediately', async () => {
    await seedAppointment(clinic, '10:00', '11:00', AppointmentStatus.CANCELLED);
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(201);
  });

  it('does not block on a NO_SHOW appointment', async () => {
    await seedAppointment(clinic, '10:00', '11:00', AppointmentStatus.NO_SHOW);
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(201);
  });

  it('DOES block on a PENDING_PAYMENT appointment — an unpaid booking still holds its slot', async () => {
    await seedAppointment(
      clinic,
      '10:00',
      '11:00',
      AppointmentStatus.PENDING_PAYMENT,
    );
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(409);
    expect(res.body.context.reasonCodes).toContain(BookabilityReason.OCCUPIED);
  });

  // ──────────────────── The other exclusion reasons ────────────────────── //

  it('rejects when the staff member is on time off', async () => {
    const repo = e2e.dataSource.getRepository(StaffTimeOff);
    await repo.save(
      repo.create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        staff: { id: clinic.staffId } as StaffProfile,
        start_date: DAY,
        end_date: DAY,
        reason: 'Annual leave',
      }),
    );
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(409);
    expect(res.body.context.reasonCodes).toContain(BookabilityReason.TIME_OFF);
  });

  it('rejects on a clinic holiday', async () => {
    const repo = e2e.dataSource.getRepository(Holiday);
    await repo.save(
      repo.create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        branch: { id: clinic.branchId } as Branch,
        name: 'Founders Day',
        date: DAY,
        is_recurring: false,
      }),
    );
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(409);
    expect(res.body.context.reasonCodes).toContain(BookabilityReason.HOLIDAY);
  });

  it('rejects a window overlapping a blocked period', async () => {
    const repo = e2e.dataSource.getRepository(BlockedSlot);
    await repo.save(
      repo.create({
        tenant: { id: clinic.owner.tenantId } as Tenant,
        branch: { id: clinic.branchId } as Branch,
        staff: { id: clinic.staffId } as StaffProfile,
        start_time: new Date(at('10:30')),
        end_time: new Date(at('11:30')),
        reason: 'Equipment maintenance',
      }),
    );
    const res = await book(clinic, at('10:00'));
    expect(res.status).toBe(409);
    expect(res.body.context.reasonCodes).toContain(BookabilityReason.BLOCKED);
  });

  it('rejects a staff member flagged as not bookable', async () => {
    await e2e.dataSource
      .getRepository(StaffProfile)
      .update({ id: clinic.staffId }, { is_available_for_booking: false });
    try {
      const res = await book(clinic, at('10:00'));
      expect(res.status).toBe(409);
      expect(res.body.context.reasonCodes).toContain(
        BookabilityReason.STAFF_INACTIVE,
      );
    } finally {
      await e2e.dataSource
        .getRepository(StaffProfile)
        .update({ id: clinic.staffId }, { is_available_for_booking: true });
    }
  });

  // ───────────────── Cross-source: AI, reception, either order ─────────── //

  it('AI books first, then reception is rejected for the same slot', async () => {
    // The AI assistant's own source value, through the same seam its tool
    // dispatcher calls — so this is the real cross-surface interaction, not a
    // reception-vs-reception duplicate wearing an AI label.
    const first = await book(clinic, at('10:00'), {
      source: AppointmentSource.WHATSAPP_BOT,
    });
    expect(first.status).toBe(201);

    const second = await book(clinic, at('10:00'));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
    expect(second.body.context.reasonCodes).toContain(BookabilityReason.OCCUPIED);
  });

  it('reception books first, then the AI is rejected for the same slot', async () => {
    const first = await book(clinic, at('10:00'));
    expect(first.status).toBe(201);

    const second = await book(clinic, at('10:00'), {
      source: AppointmentSource.WHATSAPP_BOT,
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
  });

  // ─────────────────────────── The real race ───────────────────────────── //

  it('two simultaneous bookings for the same staff and window admit exactly one', async () => {
    // The whole point: an availability check followed by an INSERT cannot be
    // race-safe under READ COMMITTED — both requests legitimately see a free
    // slot. Only `appointments_no_overlap` decides the winner, and the loser's
    // ENTIRE transaction (appointment, services, status log, history, quota
    // increment) rolls back.
    const [a, b] = await Promise.all([
      book(clinic, at('10:00'), { source: AppointmentSource.WHATSAPP_BOT }),
      book(clinic, at('10:00')),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = a.status === 409 ? a : b;
    // Either code is a correct answer to "you cannot have this slot": which one
    // depends purely on whether the loser's pre-check ran before or after the
    // winner committed. Both are 409 and both tell the client to re-pick.
    expect([
      ErrorCode.SLOT_ALREADY_BOOKED,
      ErrorCode.STAFF_NOT_AVAILABLE,
    ]).toContain(loser.body.code);

    const rows = await e2e.dataSource.getRepository(Appointment).find({
      where: { tenant: { id: clinic.owner.tenantId } },
    });
    expect(rows).toHaveLength(1);
  });

  // P2 (Phase 6): threading the already-validated branch/staff rows through
  // to AvailabilityService (instead of it re-fetching them) touches nothing
  // about the race itself — same predicate, same rows, same transaction
  // boundary — but this is the concrete proof, not just that reasoning: 20
  // requests for the exact same slot, fired together, must still admit
  // exactly one winner with zero 5xx and only clean 409s for the rest.
  it('[P2] 20 concurrent bookings for the same staff/window: exactly one winner, zero 5xx, only clean 409s', async () => {
    const CONCURRENCY = 20;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => book(clinic, at('10:00'))),
    );

    const serverErrors = results.filter((r) => r.status >= 500);
    expect(serverErrors).toEqual([]);

    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status !== 201);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(CONCURRENCY - 1);
    for (const loser of losers) {
      expect(loser.status).toBe(409);
      expect([
        ErrorCode.SLOT_ALREADY_BOOKED,
        ErrorCode.STAFF_NOT_AVAILABLE,
      ]).toContain(loser.body.code);
    }

    const rows = await e2e.dataSource.getRepository(Appointment).find({
      where: { tenant: { id: clinic.owner.tenantId } },
    });
    expect(rows).toHaveLength(1);
  });

  it('two simultaneous bookings for DIFFERENT staff at the same time both succeed', async () => {
    const other = await createClinic('availability-other-staff');
    // Same wall-clock window, different people — nothing to arbitrate.
    const [a, b] = await Promise.all([
      book(clinic, at('10:00')),
      book(other, at('10:00')),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    await e2e.dataSource.query(
      `DELETE FROM appointments WHERE "tenantId" = $1`,
      [other.owner.tenantId],
    );
  });

  // ───────────────────────── Tenant isolation ──────────────────────────── //

  it('two clinics book the same wall-clock hour without interfering', async () => {
    const other = await createClinic('availability-tenant-b');
    expect((await book(clinic, at('10:00'))).status).toBe(201);
    expect((await book(other, at('10:00'))).status).toBe(201);

    await e2e.dataSource.query(
      `DELETE FROM appointments WHERE "tenantId" = $1`,
      [other.owner.tenantId],
    );
  });

  it("another clinic's staff member does not exist — 404, never a conflict", async () => {
    const other = await createClinic('availability-cross-tenant');
    const res = await book(clinic, at('10:00'), { staffId: other.staffId });
    // A cross-tenant reference must read as "no such staff member", not as a
    // scheduling outcome — otherwise the response confirms the id is real.
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
  });

  // ─────────────────── Reschedule and duration changes ─────────────────── //

  it('rejects a reschedule into an occupied window', async () => {
    const mine = await book(clinic, at('09:00'));
    expect(mine.status).toBe(201);
    const id = mine.body.data?.id ?? mine.body.id;
    await seedAppointment(clinic, '14:00', '15:00');

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/appointments/${id}/reschedule`)
      .set(...authHeader(clinic.owner.token))
      .send({ newStartAt: at('14:00') });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
    expect(res.body.context.reasonCodes).toContain(BookabilityReason.OCCUPIED);
  });

  it('allows a reschedule into a free window (an appointment never blocks itself)', async () => {
    const mine = await book(clinic, at('09:00'));
    const id = mine.body.data?.id ?? mine.body.id;

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/appointments/${id}/reschedule`)
      .set(...authHeader(clinic.owner.token))
      .send({ newStartAt: at('13:00') });

    expect(res.status).toBe(200);
  });

  it('rejects a service change that would extend an appointment into the next booking', async () => {
    // 09:30–10:00 with the 30-minute service, then 10:00–11:00 is taken.
    // Swapping in the 60-minute service pushes the end to 10:30 — straight
    // through the neighbour. This path used to skip validation entirely.
    const mine = await book(clinic, at('09:30'), {
      serviceIds: [clinic.shortServiceId],
    });
    expect(mine.status).toBe(201);
    const id = mine.body.data?.id ?? mine.body.id;
    await seedAppointment(clinic, '10:00', '11:00');

    const res = await request(e2e.app.getHttpServer())
      .put(`${API}/appointments/${id}/services`)
      .set(...authHeader(clinic.owner.token))
      .send({ serviceIds: [clinic.serviceId] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.STAFF_NOT_AVAILABLE);
  });

  // ───────────────────────────── Timezone ──────────────────────────────── //

  it('evaluates working hours in the BRANCH timezone, not UTC', async () => {
    const other = await createClinic('availability-riyadh');
    await e2e.dataSource
      .getRepository(Branch)
      .update({ id: other.branchId }, { timezone: 'Asia/Riyadh' });

    // The branch works 09:00–17:00 LOCAL = 06:00–14:00 UTC.
    // 07:00Z is 10:00 local → inside. 15:00Z is 18:00 local → outside.
    const inside = await book(other, at('07:00'));
    expect(inside.status).toBe(201);

    const outside = await book(other, at('15:00'));
    expect(outside.status).toBe(409);
    expect(outside.body.context.reasonCodes).toContain(
      BookabilityReason.OUTSIDE_WORKING_HOURS,
    );

    await e2e.dataSource.query(
      `DELETE FROM appointments WHERE "tenantId" = $1`,
      [other.owner.tenantId],
    );
  });
});
