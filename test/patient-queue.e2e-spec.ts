/**
 * T166 (US10, FR-Q004/FR-Q012) — pins the queue's single-write property
 * BEFORE T169/T170 exist: queue management does NOT replace the appointment
 * lifecycle. A completion or no-show recorded THROUGH the queue must drive
 * `AppointmentsService.changeStatus` exactly once — never a duplicated
 * status-log row, history row, or event — even though the queue action and
 * the appointment transition are two logically distinct steps.
 *
 * Written against the FINAL contract (`POST /queue/*`, contracts/
 * clinic-surfaces.md §F10) — red until T169/T170 exist, per this suite's own
 * task text.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { AppointmentStatusLog } from '../src/entities/Calendar&Appointments/AppointmentStatusLog';
import { AppointmentHistory } from '../src/entities/Calendar&Appointments/AppointmentHistory';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { User } from '../src/entities/Auth&RBAC/User';
import { AppointmentSource, AppointmentStatus } from '../src/entities/enums';
import { APPOINTMENT_EVENT } from '../src/events/appointment.events';

const API = '/api/v1';

/** Far-future Wednesday so nothing collides with other suites; UTC branch. */
const DAY = '2032-04-21';
const WEDNESDAY = 3;

describe('Patient queue — lifecycle integrity (T166, US10, FR-Q004/FR-Q012)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let tenantId: string;
  let branchId: string;
  let staffId: string;

  const newCustomer = async (label: string) => {
    const suffix = randomUUID().slice(0, 8);
    const customer = await e2e.dataSource.getRepository(Customer).save(
      e2e.dataSource.getRepository(Customer).create({
        tenant: { id: tenantId } as Tenant,
        full_name: `${label} ${suffix}`,
        phone: `+9665${suffix}`,
        email: `${label}-${suffix}@example.test`,
      }),
    );
    return customer.id;
  };

  const createAppointment = async (
    status: AppointmentStatus,
    startHhmm: string,
  ) => {
    const customerId = await newCustomer('queue-patient');
    const startAt = new Date(`${DAY}T${startHhmm}:00.000Z`);
    const endAt = new Date(startAt.getTime() + 3600_000);
    const appointment = await e2e.dataSource.getRepository(Appointment).save(
      e2e.dataSource.getRepository(Appointment).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        customer: { id: customerId } as Customer,
        staff: { id: staffId } as StaffProfile,
        start_at: startAt,
        end_at: endAt,
        status,
        source: AppointmentSource.MANUAL,
        currency: 'SAR',
      }),
    );
    return appointment.id;
  };

  const checkIn = (appointmentId: string) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/queue/check-in`)
      .set(...authHeader(owner.token))
      .send({ appointmentId });

  const call = (entryId: string) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/queue/${entryId}/call`)
      .set(...authHeader(owner.token))
      .send();

  const start = (entryId: string) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/queue/${entryId}/start`)
      .set(...authHeader(owner.token))
      .send();

  const complete = (entryId: string) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/queue/${entryId}/complete`)
      .set(...authHeader(owner.token))
      .send();

  const noShow = (entryId: string) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/queue/${entryId}/no-show`)
      .set(...authHeader(owner.token))
      .send();

  const countStatusLogs = (appointmentId: string) =>
    e2e.dataSource
      .getRepository(AppointmentStatusLog)
      .count({ where: { appointment: { id: appointmentId } } });

  const countHistory = (appointmentId: string) =>
    e2e.dataSource
      .getRepository(AppointmentHistory)
      .count({ where: { appointment: { id: appointmentId } } });

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'queue-integrity');
    tenantId = owner.tenantId;
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Queue Branch',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchId = branch.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `queue-doctor-${suffix}@example.test`,
        full_name: 'Dr Queue',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: 'Dr Queue',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    await ds.getRepository(WorkingHour).save(
      ds.getRepository(WorkingHour).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        day_of_week: WEDNESDAY,
        start_time: '08:00',
        end_time: '20:00',
        is_closed: false,
      }),
    );
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        staff: { id: staffId } as StaffProfile,
        day_of_week: WEDNESDAY,
        start_time: '08:00',
        end_time: '20:00',
        is_active: true,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await e2e.app.close();
  });

  it('completing an appointment through the queue produces exactly ONE status-log row, ONE history row, and ONE event', async () => {
    const appointmentId = await createAppointment(
      AppointmentStatus.CONFIRMED,
      '09:00',
    );
    const emitter = e2e.app.get(EventEmitter2);
    const emitSpy = jest.spyOn(emitter, 'emit');

    const checkInRes = await checkIn(appointmentId).expect(201);
    const entryId = checkInRes.body.id;

    await call(entryId).expect(200);
    const startRes = await start(entryId).expect(200);
    expect(startRes.body.state).toBe('IN_CONSULTATION');

    const completeRes = await complete(entryId).expect(200);
    expect(completeRes.body.state).toBe('COMPLETED');

    const appointment = await e2e.dataSource
      .getRepository(Appointment)
      .findOneOrFail({ where: { id: appointmentId } });
    expect(appointment.status).toBe(AppointmentStatus.COMPLETED);

    // Exactly two changeStatus calls happened (CONFIRMED→IN_PROGRESS,
    // IN_PROGRESS→COMPLETED) — never four from a duplicated queue-side write.
    expect(await countStatusLogs(appointmentId)).toBe(2);
    expect(await countHistory(appointmentId)).toBe(2);

    const inProgressEmits = emitSpy.mock.calls.filter(
      ([name, payload]: any[]) =>
        name === APPOINTMENT_EVENT.IN_PROGRESS &&
        payload?.appointmentId === appointmentId,
    );
    const completedEmits = emitSpy.mock.calls.filter(
      ([name, payload]: any[]) =>
        name === APPOINTMENT_EVENT.COMPLETED &&
        payload?.appointmentId === appointmentId,
    );
    expect(inProgressEmits).toHaveLength(1);
    expect(completedEmits).toHaveLength(1);

    emitSpy.mockRestore();
  });

  it('a no-show recorded through the queue closes the entry AND records the appointment outcome exactly once', async () => {
    const appointmentId = await createAppointment(
      AppointmentStatus.CONFIRMED,
      '10:00',
    );
    const emitter = e2e.app.get(EventEmitter2);
    const emitSpy = jest.spyOn(emitter, 'emit');

    const checkInRes = await checkIn(appointmentId).expect(201);
    const entryId = checkInRes.body.id;
    await call(entryId).expect(200);

    const noShowRes = await noShow(entryId).expect(200);
    expect(noShowRes.body.state).toBe('NO_SHOW');

    const appointment = await e2e.dataSource
      .getRepository(Appointment)
      .findOneOrFail({ where: { id: appointmentId } });
    expect(appointment.status).toBe(AppointmentStatus.NO_SHOW);

    expect(await countStatusLogs(appointmentId)).toBe(1);
    expect(await countHistory(appointmentId)).toBe(1);

    const noShowEmits = emitSpy.mock.calls.filter(
      ([name, payload]: any[]) =>
        name === APPOINTMENT_EVENT.NO_SHOW &&
        payload?.appointmentId === appointmentId,
    );
    expect(noShowEmits).toHaveLength(1);

    // A second no-show attempt on the now-terminal entry is refused, not a
    // second write.
    await noShow(entryId).expect(409);
    expect(await countStatusLogs(appointmentId)).toBe(1);

    emitSpy.mockRestore();
  });

  it('start refuses a WAITING (not yet CALLED) entry — never silently starts consultation', async () => {
    const appointmentId = await createAppointment(
      AppointmentStatus.CONFIRMED,
      '11:00',
    );
    const checkInRes = await checkIn(appointmentId).expect(201);
    const entryId = checkInRes.body.id;

    // Never called — still WAITING.
    await start(entryId).expect(409);

    const appointment = await e2e.dataSource
      .getRepository(Appointment)
      .findOneOrFail({ where: { id: appointmentId } });
    expect(appointment.status).toBe(AppointmentStatus.CONFIRMED);
    expect(await countStatusLogs(appointmentId)).toBe(0);
  });
});
