/**
 * Regression coverage for the `GET /scheduling/availability/windows` 500:
 * `Cannot read properties of null (reading 'id')` at
 * `StaffScheduleService.getAvailability`.
 *
 * Root cause (see `staff-schedule.service.ts`): that method's schedule query
 * used `.find({ relations: { staff: { user: true } } })`. TypeORM compiles
 * `relations` to a LEFT JOIN and, for a soft-deletable target
 * (`StaffProfile.deleted_at`), appends `staff.deleted_at IS NULL` to the JOIN
 * CONDITION rather than a WHERE clause — so a `StaffSchedule` row left behind
 * by a soft-deleted staff member (soft-delete does not cascade the way a real
 * `DELETE` does) survived the LEFT JOIN with `staff: null` instead of being
 * dropped. `slots.map((s) => s.staff.id)` then crashed the availability
 * lookup for EVERY staff member sharing that branch/day, not just the deleted
 * one.
 *
 * This suite reproduces the exact shape against real Postgres: a soft-deleted
 * staff member with a still-`is_active` schedule sharing a branch/day with a
 * live, bookable staff member, and proves:
 *  - the endpoint returns 200 with correct windows, not a 500;
 *  - the soft-deleted staff member never appears in the result;
 *  - booking an appointment for the live staff member in a returned window
 *    still works end-to-end.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Branch } from '../src/entities/SaaS-Core/Branch';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { User } from '../src/entities/Auth&RBAC/User';
import { Customer } from '../src/entities/CRM/Customer';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';

const API = '/api/v1';
const SUITE = `avail-null-${randomUUID().slice(0, 8)}`;

/** Weekday (0=Sun...6=Sat) of a 'YYYY-MM-DD' date — mirrors the service's own `weekdayOf`. */
function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** Next date (>= today+2 to dodge "today" edge cases) matching a given weekday. */
function nextDateOnWeekday(weekday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('Availability windows — soft-deleted staff schedule (real Postgres)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let branchId: string;
  let liveStaffId: string;
  let ghostStaffId: string;
  let customerId: string;
  const dateStr = nextDateOnWeekday(3); // any fixed weekday; Wednesday
  const dayOfWeek = weekdayOf(dateStr);

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, SUITE);
    const ds = e2e.dataSource;

    const branches = ds.getRepository(Branch);
    const workingHours = ds.getRepository(WorkingHour);
    const staffProfiles = ds.getRepository(StaffProfile);
    const schedules = ds.getRepository(StaffSchedule);
    const users = ds.getRepository(User);
    const customers = ds.getRepository(Customer);

    const branch = await branches.save(
      branches.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `${SUITE} Branch`,
        is_active: true,
        timezone: 'UTC',
      }),
    );
    branchId = branch.id;

    await workingHours.save(
      workingHours.create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        day_of_week: dayOfWeek,
        start_time: '09:00:00',
        end_time: '17:00:00',
        is_closed: false,
      }),
    );

    // Live, bookable staff member — the one the reported request asks about.
    const liveUser = await users.save(
      users.create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `${SUITE}-live@example.test`,
        full_name: 'Live Staff',
        is_active: true,
      }),
    );
    const liveStaff = await staffProfiles.save(
      staffProfiles.create({
        tenant: { id: owner.tenantId } as Tenant,
        user: { id: liveUser.id } as User,
        is_available_for_booking: true,
      }),
    );
    liveStaffId = liveStaff.id;
    await schedules.save(
      schedules.create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        staff: { id: liveStaffId } as StaffProfile,
        day_of_week: dayOfWeek,
        start_time: '09:00:00',
        end_time: '17:00:00',
        is_active: true,
      }),
    );

    // Ghost staff member — soft-deleted AFTER its schedule was created, the
    // same order a real `StaffService.remove()` produces: the FK's
    // `onDelete: 'CASCADE'` only fires on a hard DELETE, so the soft delete
    // (an UPDATE of `deleted_at`) leaves this `StaffSchedule` row behind,
    // still `is_active: true`, on the SAME branch/day as the live staff
    // member above.
    const ghostUser = await users.save(
      users.create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `${SUITE}-ghost@example.test`,
        full_name: 'Ghost Staff',
        is_active: true,
      }),
    );
    const ghostStaff = await staffProfiles.save(
      staffProfiles.create({
        tenant: { id: owner.tenantId } as Tenant,
        user: { id: ghostUser.id } as User,
        is_available_for_booking: true,
      }),
    );
    ghostStaffId = ghostStaff.id;
    await schedules.save(
      schedules.create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        staff: { id: ghostStaffId } as StaffProfile,
        day_of_week: dayOfWeek,
        start_time: '00:00:00',
        end_time: '23:59:00',
        is_active: true,
      }),
    );
    await staffProfiles.softRemove(ghostStaff);

    const customer = await customers.save(
      customers.create({
        tenant: { id: owner.tenantId } as Tenant,
        phone: '+10000000000',
        email: `${SUITE}-customer@example.test`,
        full_name: 'Test Customer',
      }),
    );
    customerId = customer.id;
  });

  afterAll(async () => {
    // Raw SQL, FK-safe order, hard deletes (both `Appointment` and
    // `StaffProfile` are soft-deletable — a repository `.delete()` would only
    // stamp `deleted_at`, not actually free the FK for the deletes below).
    // Children of `appointments` first, then `appointments` itself, then the
    // scheduling/staff/customer/branch fixtures this suite created, THEN the
    // shared tenant cleanup (`cleanupTenant`) for users/roles/tenant.
    const ds = e2e.dataSource;
    const q = (sql: string) => ds.query(sql, [owner.tenantId]);
    await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointment_notes WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
    await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`);
    await q(`DELETE FROM working_hours WHERE "tenantId" = $1`);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`);
    await cleanupTenant(e2e, owner.tenantId);
    await e2e.app.close();
  });

  it("returns 200 with the live staff member's windows, not a 500, despite the ghost schedule", async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/scheduling/availability/windows`)
      .query({ branchId, staffId: liveStaffId, date: dateStr, slotMinutes: 50 })
      .set(...authHeader(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.windows.length).toBeGreaterThan(0);
    // 09:00-17:00 chunked into 50-minute slots — sanity on the first slot.
    expect(res.body.windows[0].startTime).toBe(`${dateStr}T09:00:00.000Z`);
  });

  it('never surfaces the soft-deleted staff member through StaffScheduleService.getAvailability', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/scheduling/availability/windows`)
      .query({
        branchId,
        staffId: ghostStaffId,
        date: dateStr,
        slotMinutes: 50,
      })
      .set(...authHeader(owner.token));

    // Not found as a valid staff member — either explicitly not-available or
    // 404 on the ref lookup, but never a 500 and never treated as bookable.
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(200);
  });

  it('still allows booking the live staff member in a returned window (no regression to the booking path)', async () => {
    const windowsRes = await request(e2e.app.getHttpServer())
      .get(`${API}/scheduling/availability/windows`)
      .query({ branchId, staffId: liveStaffId, date: dateStr, slotMinutes: 50 })
      .set(...authHeader(owner.token));
    expect(windowsRes.status).toBe(200);
    const firstWindow = windowsRes.body.windows[0];

    const bookRes = await request(e2e.app.getHttpServer())
      .post(`${API}/appointments`)
      .set(...authHeader(owner.token))
      .send({
        branchId,
        customerId,
        staffId: liveStaffId,
        startAt: firstWindow.startTime,
        endAt: firstWindow.endTime,
      });

    expect(bookRes.status).toBe(201);
    expect(bookRes.body.id).toBeDefined();
  });
});
