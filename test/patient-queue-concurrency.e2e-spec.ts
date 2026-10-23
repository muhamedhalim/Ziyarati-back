/**
 * T167 (US10, FR-Q005–FR-Q009/FR-Q007a) — pins the queue's concurrency and
 * eligibility rules BEFORE T170 exists:
 *
 *  1. Simultaneous call-next races to exactly one winner (FR-Q009).
 *  2. Simultaneous double check-in for the same appointment creates exactly
 *     one entry (FR-Q005) — a DATABASE constraint, not an app pre-check.
 *  3. A wrong-branch check-in is refused (FR-Q006).
 *  4. A terminal appointment's check-in is refused (FR-Q007).
 *  5. A PENDING_PAYMENT appointment IS accepted and returned `blocked`
 *     (FR-Q007a) — never turned away at the desk.
 *  6. `start` refuses that same entry with `AWAITING_CONFIRMATION` until the
 *     appointment is confirmed through the EXISTING
 *     `POST /appointments/:id/status` route (FR-Q007a/FR-Q007c) — the queue
 *     never confirms an appointment implicitly.
 *
 * Written against the FINAL contract (`POST /queue/*`) — red until T170
 * exists, per this suite's own task text.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { RolePermission } from '../src/entities/Auth&RBAC/RolePermission';
import { Permission } from '../src/entities/Auth&RBAC/Permission';
import { BranchUser } from '../src/entities/Multi Branch/BranchUser';
import { AppointmentSource, AppointmentStatus } from '../src/entities/enums';

const API = '/api/v1';
const DAY = '2032-04-28';
const WEDNESDAY = 3;
const CONCURRENCY = 5;

describe('Patient queue — concurrency and eligibility (T167, US10, FR-Q005-Q009/FR-Q007a)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let tenantId: string;
  let branchAId: string;
  let branchBId: string;
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
    branchId: string = branchAId,
  ) => {
    const customerId = await newCustomer('queue-concurrency-patient');
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

  const checkIn = (appointmentId: string, token = owner.token) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/queue/check-in`)
      .set(...authHeader(token))
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

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'queue-concurrency');
    tenantId = owner.tenantId;
    const ds = e2e.dataSource;
    const suffix = randomUUID().slice(0, 8);

    const branchA = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Queue Branch A',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchAId = branchA.id;

    const branchB = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Queue Branch B',
        timezone: 'UTC',
        is_active: true,
      }),
    );
    branchBId = branchB.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `queue-concurrency-doctor-${suffix}@example.test`,
        full_name: 'Dr Queue Concurrency',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: 'Dr Queue Concurrency',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    for (const branchId of [branchAId, branchBId]) {
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
    }
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
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

  it('1. simultaneous call-next races to exactly one winner', async () => {
    const appointmentId = await createAppointment(
      AppointmentStatus.CONFIRMED,
      '09:00',
    );
    const checkInRes = await checkIn(appointmentId).expect(201);
    const entryId = checkInRes.body.id;

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => call(entryId)),
    );
    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(CONCURRENCY - 1);
  });

  it('2. simultaneous double check-in for the same appointment creates exactly one entry', async () => {
    const appointmentId = await createAppointment(
      AppointmentStatus.CONFIRMED,
      '10:00',
    );

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => checkIn(appointmentId)),
    );
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENCY - 1);
  });

  it('3. a wrong-branch check-in is refused', async () => {
    // A custom role holding appointments.read/appointments.update, assigned
    // to Branch A ONLY — mirrors the FND-017 branches.update_own pattern
    // used by the analytics-trends e2e suite for the same shape of fixture.
    const permRepo = e2e.dataSource.getRepository(Permission);
    const readPerm = await permRepo.findOne({
      where: { slug: 'appointments.read' },
    });
    const updatePerm = await permRepo.findOne({
      where: { slug: 'appointments.update' },
    });
    expect(readPerm).toBeDefined();
    expect(updatePerm).toBeDefined();

    const roles = e2e.dataSource.getRepository(Role);
    const customRole = await roles.save(
      roles.create({
        tenant: { id: tenantId } as Tenant,
        name: 'Branch A Receptionist',
        slug: `branch-a-receptionist-${randomUUID().slice(0, 8)}`,
        is_system: false,
      }),
    );
    await e2e.dataSource.getRepository(RolePermission).save([
      e2e.dataSource.getRepository(RolePermission).create({
        role: { id: customRole.id } as Role,
        permission: { id: readPerm!.id } as Permission,
      }),
      e2e.dataSource.getRepository(RolePermission).create({
        role: { id: customRole.id } as Role,
        permission: { id: updatePerm!.id } as Permission,
      }),
    ]);

    const users = e2e.dataSource.getRepository(User);
    const restrictedUser = await users.save(
      users.create({
        tenant: { id: tenantId } as Tenant,
        email: `branch-a-reception-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'Branch A Receptionist',
        is_active: true,
      }),
    );
    await e2e.dataSource.getRepository(UserRole).save(
      e2e.dataSource.getRepository(UserRole).create({
        user: { id: restrictedUser.id } as User,
        role: { id: customRole.id } as Role,
      }),
    );
    await e2e.dataSource.getRepository(BranchUser).save(
      e2e.dataSource.getRepository(BranchUser).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
        user: { id: restrictedUser.id } as User,
      }),
    );

    const restrictedToken = await e2e.jwt.signAsync(
      { sub: restrictedUser.id, tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );

    // Appointment at Branch B — the restricted user is assigned to Branch A only.
    const appointmentId = await createAppointment(
      AppointmentStatus.CONFIRMED,
      '11:00',
      branchBId,
    );

    const res = await checkIn(appointmentId, restrictedToken);
    expect(res.status).toBe(409);
    expect(res.body.context?.reason).toBe('WRONG_BRANCH');
  });

  it('4. a terminal appointment refuses check-in', async () => {
    const cancelledId = await createAppointment(
      AppointmentStatus.CANCELLED,
      '12:00',
    );
    await checkIn(cancelledId).expect(409);

    const completedId = await createAppointment(
      AppointmentStatus.COMPLETED,
      '12:30',
    );
    await checkIn(completedId).expect(409);

    const noShowId = await createAppointment(
      AppointmentStatus.NO_SHOW,
      '13:00',
    );
    await checkIn(noShowId).expect(409);
  });

  it('5. a PENDING_PAYMENT appointment IS accepted and returned blocked; 6. start refuses with AWAITING_CONFIRMATION until confirmed', async () => {
    const appointmentId = await createAppointment(
      AppointmentStatus.PENDING_PAYMENT,
      '14:00',
    );

    const checkInRes = await checkIn(appointmentId).expect(201);
    expect(checkInRes.body.blocked).toEqual({
      reason: 'AWAITING_CONFIRMATION',
      requires: 'CONFIRM_APPOINTMENT',
    });
    const entryId = checkInRes.body.id;

    await call(entryId).expect(200);

    // `start` refuses — the entry is left untouched (still CALLED), and the
    // appointment is NOT confirmed as a side effect.
    const startRes = await start(entryId);
    expect(startRes.status).toBe(409);
    expect(startRes.body.context?.requires).toBe('CONFIRM_APPOINTMENT');

    const stillPending = await e2e.dataSource
      .getRepository(Appointment)
      .findOneOrFail({ where: { id: appointmentId } });
    expect(stillPending.status).toBe(AppointmentStatus.PENDING_PAYMENT);

    // Confirm through the EXISTING, separate route — never implicitly by the queue.
    await request(e2e.app.getHttpServer())
      .post(`${API}/appointments/${appointmentId}/status`)
      .set(...authHeader(owner.token))
      .send({ status: AppointmentStatus.CONFIRMED })
      .expect(200);

    // Now start succeeds.
    const startAfterConfirm = await start(entryId);
    expect(startAfterConfirm.status).toBe(200);
    expect(startAfterConfirm.body.state).toBe('IN_CONSULTATION');
  });
});
