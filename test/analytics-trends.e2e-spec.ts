/**
 * Spec 014 (Clinic Platform Completion) — T144 (US11, depends T022, research.md R13).
 *
 * The regression this phase exists to fix: for a MULTI-BRANCH clinic, the
 * existing product reads the "last 14 rows" of the per-branch `daily_reports`
 * table (`useDailyReports({ limit: 14 })`, reversed client-side) and presents
 * them as a 14-day trend. Two branches means those 14 rows are an arbitrary
 * MIX of branches, and "last 14 rows" is not "last 14 days" the moment a
 * branch has fewer rows than the limit or reports were generated out of
 * calendar order.
 *
 * Part A below PINS that defect against the real, UNCHANGED
 * `GET /analytics/reports/daily` endpoint (the one the frontend currently
 * calls) — this assertion is a permanent regression guard, not something
 * that flips red→green.
 *
 * Part B proves the FIX: the new `GET /analytics/trends/appointments`
 * endpoint returns one row per requested calendar day, correctly scoped to
 * one branch, never mixing in another branch's counts.
 *
 * Part C proves FR-A016: a caller holding only `analytics.reports.read`
 * (not the tenant-wide `analytics.dashboard.read`) — modelled here as a
 * custom role assigned to ONE branch via `branch_users`, mirroring the
 * FND-017 `branches.update_own` ABAC pattern this phase reuses — sees ONLY
 * their own branch's data and is refused a foreign branch id.
 *
 * Real Postgres, real HTTP — see `createE2eApp`/`createOwnerFixture`.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Branch } from '../src/entities/SaaS-Core/Branch';
import { BranchUser } from '../src/entities/Multi Branch/BranchUser';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Customer } from '../src/entities/CRM/Customer';
import { Service } from '../src/entities/Services/Service';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../src/entities/Auth&RBAC/RolePermission';
import { Permission } from '../src/entities/Auth&RBAC/Permission';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import {
  AppointmentPaymentStatus,
  AppointmentSource,
  AppointmentStatus,
} from '../src/entities/enums';

const API = '/api/v1';
const DAYS = [
  '2032-03-01',
  '2032-03-02',
  '2032-03-03',
  '2032-03-04',
  '2032-03-05',
];
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

describe('Advanced analytics trends — multi-branch regression (T144, spec 014, R13)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let branchAId: string;
  let branchBId: string;
  let staffId: string;
  let customerId: string;
  /** Branch-A appointment count per day — the known ground truth. */
  const branchAPerDay: Record<string, number> = {
    [DAYS[0]]: 2,
    [DAYS[1]]: 0,
    [DAYS[2]]: 3,
    [DAYS[3]]: 1,
    [DAYS[4]]: 2,
  };
  const branchBPerDay: Record<string, number> = {
    [DAYS[0]]: 1,
    [DAYS[1]]: 1,
    [DAYS[2]]: 1,
    [DAYS[3]]: 1,
    [DAYS[4]]: 1,
  };

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'trends');

    const branches = e2e.dataSource.getRepository(Branch);
    const branchA = await branches.save(
      branches.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Trends Branch A',
      }),
    );
    const branchB = await branches.save(
      branches.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Trends Branch B',
      }),
    );
    branchAId = branchA.id;
    branchBId = branchB.id;

    // A service catalog entry (unused by this suite's assertions, but every
    // fixture in this file family keeps a minimal, realistic clinic shape).
    const services = e2e.dataSource.getRepository(Service);
    await services.save(
      services.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Consult',
        duration_minutes: 30,
      }),
    );

    // TWO staff members — one per branch. `appointments_no_overlap` (the
    // AppointmentNoOverlap migration) excludes two overlapping appointments
    // for the SAME staff regardless of branch, so a shared staff member
    // across branches A and B on the same time slots would fail to insert.
    const users = e2e.dataSource.getRepository(User);
    const makeStaff = async (label: string) => {
      const user = await users.save(
        users.create({
          tenant: { id: owner.tenantId } as Tenant,
          email: `staff-${label}-${randomUUID().slice(0, 8)}@example.test`,
          full_name: `Trend Doctor ${label}`,
          is_active: true,
        }),
      );
      const staff = await e2e.dataSource.getRepository(StaffProfile).save(
        e2e.dataSource.getRepository(StaffProfile).create({
          user: { id: user.id } as User,
          tenant: { id: owner.tenantId } as Tenant,
        }),
      );
      return staff.id;
    };
    staffId = await makeStaff('a');
    const staffBId = await makeStaff('b');

    const customers = e2e.dataSource.getRepository(Customer);
    const customer = await customers.save(
      customers.create({
        tenant: { id: owner.tenantId } as Tenant,
        full_name: 'Trend Patient',
        phone: '+966511111111',
        email: `patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    customerId = customer.id;

    const appointments = e2e.dataSource.getRepository(Appointment);
    const makeAppts = async (
      branchId: string,
      staffProfileId: string,
      perDay: Record<string, number>,
    ) => {
      for (const day of DAYS) {
        const count = perDay[day];
        for (let i = 0; i < count; i++) {
          await appointments.save(
            appointments.create({
              tenant: { id: owner.tenantId } as Tenant,
              branch: { id: branchId } as Branch,
              customer: { id: customerId } as Customer,
              staff: { id: staffProfileId } as StaffProfile,
              start_at: new Date(
                at(day, `${String(9 + i).padStart(2, '0')}:00`),
              ),
              end_at: new Date(at(day, `${String(9 + i).padStart(2, '0')}:30`)),
              status: AppointmentStatus.COMPLETED,
              payment_status: AppointmentPaymentStatus.PAID,
              currency: 'USD',
              source: AppointmentSource.MANUAL,
            }),
          );
        }
      }
    };
    await makeAppts(branchAId, staffId, branchAPerDay);
    await makeAppts(branchBId, staffBId, branchBPerDay);

    // Precompute a DailyReport row for EVERY (day, branch) pair — this is
    // exactly what a real clinic's nightly aggregation job would have
    // produced, and exactly what `GET /analytics/reports/daily` reads.
    for (const day of DAYS) {
      await request(e2e.app.getHttpServer())
        .post(`${API}/analytics/reports/daily/generate`)
        .set(...authHeader(owner.token))
        .send({ date: day })
        .expect(200);
    }
  }, 60_000);

  afterAll(async () => {
    // `cleanupTenant` (shared helper) only reaches conversations/whatsapp/
    // customers/users/api_logs — none of the tenant FKs here are ON DELETE
    // CASCADE (confirmed: NO ACTION), so branches/appointments/staff/roles
    // etc. must be cleared FIRST, children before parents, or the tenant
    // DELETE inside `cleanupTenant` 409s.
    const q = (sql: string) => e2e.dataSource.query(sql, [owner.tenantId]);
    await q(`DELETE FROM payments WHERE "tenantId" = $1`);
    await q(`DELETE FROM customer_reviews WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointment_cancellations WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
    await q(`DELETE FROM daily_reports WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
    await q(`DELETE FROM branch_users WHERE "tenantId" = $1`);
    await q(
      `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
    );
    await q(`DELETE FROM roles WHERE "tenantId" = $1`);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
    await q(`DELETE FROM services WHERE "tenantId" = $1`);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`);

    await cleanupTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ─────────────────── Part A — pin the OLD endpoint's defect (R13) ─────────────────── //

  it('R13: the existing daily-report list mixes branches when read as "last N" without a branchId', async () => {
    // Simulates exactly what the current frontend does today:
    // `useDailyReports({ limit: 4, page: 1 })` — no branchId, "last N rows".
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/reports/daily?limit=4&page=1`)
      .set(...authHeader(owner.token))
      .expect(200);

    const rows: { date: string; branch: { id: string } }[] = res.body.data;
    expect(rows.length).toBe(4);

    // 2 branches x 5 days = 10 rows total; the "last 4 rows" therefore span
    // FEWER than 4 distinct calendar days — proving "last 4 rows" is NOT
    // "last 4 days". This is the defect research.md R13 documents.
    const distinctDates = new Set(rows.map((r) => r.date));
    expect(distinctDates.size).toBeLessThan(4);

    // And it mixes branches: at least one row from each branch appears among
    // the top 4 by `date DESC` (both branches were generated for every day).
    const distinctBranches = new Set(rows.map((r) => r.branch.id));
    expect(distinctBranches.size).toBe(2);
  });

  // ────────────────── Part B — the NEW endpoint fixes it (T145/T146) ────────────────── //

  it('trends/appointments is date-scoped (one row per requested day) and branch-scoped (never mixes branches)', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/trends/appointments?from=${DAYS[0]}&to=${DAYS[4]}&branchId=${branchAId}`,
      )
      .set(...authHeader(owner.token))
      .expect(200);

    expect(res.body.empty).toBe(false);
    expect(res.body.scope).toEqual({ branchId: branchAId });
    expect(res.body.range).toEqual({ from: DAYS[0], to: DAYS[4] });
    expect(res.body.data).toHaveLength(5); // exactly 5 days requested — never row-limited.

    for (const day of DAYS) {
      const row = res.body.data.find((d: { date: string }) => d.date === day);
      expect(row).toBeDefined();
      expect(row.total).toBe(branchAPerDay[day]); // branch A ONLY — branch B never leaks in.
    }

    // Cross-check against branch B: different totals, proving no mixing.
    const resB = await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/trends/appointments?from=${DAYS[0]}&to=${DAYS[4]}&branchId=${branchBId}`,
      )
      .set(...authHeader(owner.token))
      .expect(200);
    for (const day of DAYS) {
      const row = resB.body.data.find((d: { date: string }) => d.date === day);
      expect(row.total).toBe(branchBPerDay[day]);
    }
  });

  // ─────────────────── Part C — FR-A016 branch-restricted scoping ───────────────────── //

  it('a caller holding only analytics.reports.read is forced to their own branch and refused a foreign one', async () => {
    // A custom role — deliberately WITHOUT analytics.dashboard.read — assigned
    // to Branch B only, mirroring the FND-017 branches.update_own pattern.
    const permRepo = e2e.dataSource.getRepository(Permission);
    const reportsReadPerm = await permRepo.findOne({
      where: { slug: 'analytics.reports.read' },
    });
    expect(reportsReadPerm).toBeDefined();

    const roles = e2e.dataSource.getRepository(Role);
    const customRole = await roles.save(
      roles.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Branch B Analyst',
        slug: `branch-b-analyst-${randomUUID().slice(0, 8)}`,
        is_system: false,
      }),
    );
    await e2e.dataSource.getRepository(RolePermission).save(
      e2e.dataSource.getRepository(RolePermission).create({
        role: { id: customRole.id } as Role,
        permission: { id: reportsReadPerm!.id } as Permission,
      }),
    );

    const users = e2e.dataSource.getRepository(User);
    const restrictedUser = await users.save(
      users.create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `restricted-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'Branch B Analyst',
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
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branchBId } as Branch,
        user: { id: restrictedUser.id } as User,
      }),
    );

    const restrictedToken = await e2e.jwt.signAsync(
      { sub: restrictedUser.id, tenantId: owner.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );

    // No branchId given -> defaults to their OWN branch (Branch B), never ALL.
    const own = await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/trends/appointments?from=${DAYS[0]}&to=${DAYS[4]}`)
      .set(...authHeader(restrictedToken))
      .expect(200);
    expect(own.body.scope).toEqual({ branchId: branchBId });
    for (const day of DAYS) {
      const row = own.body.data.find((d: { date: string }) => d.date === day);
      expect(row.total).toBe(branchBPerDay[day]); // never Branch A's totals.
    }

    // Explicitly requesting their OWN branch is fine (idempotent).
    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/trends/appointments?from=${DAYS[0]}&to=${DAYS[4]}&branchId=${branchBId}`,
      )
      .set(...authHeader(restrictedToken))
      .expect(200);

    // Explicitly requesting the OTHER branch is refused — a request-supplied
    // branch id is NEVER trusted for a branch-restricted caller (FR-A016).
    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/trends/appointments?from=${DAYS[0]}&to=${DAYS[4]}&branchId=${branchAId}`,
      )
      .set(...authHeader(restrictedToken))
      .expect(403);

    // Same discipline on the LIST-shaped branch-performance route: only
    // their own branch's row is ever returned, never a clinic-wide list.
    const branchesPerf = await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/performance/branches?from=${DAYS[0]}&to=${DAYS[4]}`,
      )
      .set(...authHeader(restrictedToken))
      .expect(200);
    expect(branchesPerf.body.data).toHaveLength(1);
    expect(branchesPerf.body.data[0].branchId).toBe(branchBId);
  });
});
