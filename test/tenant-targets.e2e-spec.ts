/**
 * Dashboard target-tracking cards (Appointment Target / Revenue Target) —
 * authorization, progress calculation, and appointment/payment status
 * changes, against real Postgres.
 *
 * Covers the contract the frontend cards rely on:
 *  - GET  /tenants/me/targets  — analytics.reports.read (owner + manager)
 *  - PATCH /tenants/me/targets — owner ONLY (narrower than the general
 *    settings PATCH, which is owner-or-manager)
 *  - progress is computed for the CURRENT UTC calendar month only: a
 *    completed appointment / paid payment from a different month, a
 *    different tenant, or a non-eligible status must never be counted.
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
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { Customer } from '../src/entities/CRM/Customer';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { Payment } from '../src/entities/Payments/Payment';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { AppointmentStatus, PaymentStatus } from '../src/entities/enums';

const API = '/api/v1';
const SUITE = `tt-${randomUUID().slice(0, 8)}`;

/** A UTC instant on day `dayOfMonth` of the given month offset from "now". */
function utcDateInMonth(monthOffset: number, dayOfMonth: number, hour = 10): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, dayOfMonth, hour, 0, 0),
  );
}

async function mintRoleToken(
  e2e: E2eApp,
  tenantId: string,
  roleSlug: string,
  suffix: string,
): Promise<string> {
  const roles = e2e.dataSource.getRepository(Role);
  const users = e2e.dataSource.getRepository(User);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: roleSlug })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) {
    throw new Error(
      `Seeded system role "${roleSlug}" not found — run the RBAC seed against the test database first.`,
    );
  }

  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as Tenant,
      email: `${roleSlug}-${suffix}@example.test`,
      full_name: `${roleSlug} ${suffix}`,
      is_active: true,
    }),
  );
  await userRoles.save(
    userRoles.create({ user: { id: user.id } as User, role: { id: role.id } as Role }),
  );

  return e2e.jwt.signAsync(
    { sub: user.id, tenantId, type: 'access' },
    {
      secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: '15m',
    },
  );
}

describe('Dashboard targets — real Postgres', () => {
  let e2e: E2eApp;
  let ownerA: OwnerFixture;
  let ownerB: OwnerFixture;
  let managerToken: string;
  let receptionistToken: string;
  let branchId: string;
  let customerId: string;
  let staffId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    ownerA = await createOwnerFixture(e2e, `${SUITE}-a`);
    ownerB = await createOwnerFixture(e2e, `${SUITE}-b`);

    const ds = e2e.dataSource;

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        name: `${SUITE} Main`,
        is_active: true,
        timezone: 'UTC',
      }),
    );
    branchId = branch.id;

    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        full_name: `Patient ${SUITE}`,
        phone: '+10000000000',
        email: `patient-${SUITE}@example.test`,
      }),
    );
    customerId = customer.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        email: `doctor-${SUITE}@example.test`,
        full_name: `Dr ${SUITE}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        user: { id: staffUser.id } as User,
        title: 'Consultant',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    managerToken = await mintRoleToken(e2e, ownerA.tenantId, 'manager', `${SUITE}-mgr`);
    receptionistToken = await mintRoleToken(e2e, ownerA.tenantId, 'receptionist', `${SUITE}-rc`);
  }, 60_000);

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) =>
      e2e.dataSource.query(sql, p).catch(() => undefined);
    await q(`DELETE FROM payments WHERE "tenantId" = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [ownerB.tenantId]);
    await cleanupTenant(e2e, ownerA.tenantId);
    await cleanupTenant(e2e, ownerB.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ── Authorization ────────────────────────────────────────────────────── //

  describe('authorization', () => {
    it('owner can read progress', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerA.token))
        .expect(200);
    });

    it('manager can read progress (holds analytics.reports.read)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(managerToken))
        .expect(200);
    });

    it('receptionist cannot read progress (lacks analytics.reports.read)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(receptionistToken))
        .expect(403);
    });

    it('owner can set targets', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerA.token))
        .send({ appointmentTarget: 10 })
        .expect(200);
    });

    it('manager CANNOT set targets, even though manager can read them', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/targets`)
        .set(...authHeader(managerToken))
        .send({ appointmentTarget: 99 })
        .expect(403);
    });

    it('receptionist cannot set targets', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/targets`)
        .set(...authHeader(receptionistToken))
        .send({ appointmentTarget: 99 })
        .expect(403);
    });
  });

  // ── Undefined target ─────────────────────────────────────────────────── //

  describe('undefined target', () => {
    it("a fresh tenant with no target set shows null target/remaining/percentage, not completed", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerB.token))
        .expect(200);

      expect(res.body.appointments).toMatchObject({
        target: null,
        remaining: null,
        percentage: null,
        isCompleted: false,
      });
      expect(res.body.revenue).toMatchObject({
        target: null,
        remaining: null,
        percentage: null,
        isCompleted: false,
      });
      expect(res.body.currency).toBe('USD'); // TenantSetting default
    });
  });

  // ── Progress calculation ─────────────────────────────────────────────── //

  describe('progress calculation — only eligible, in-period data counts', () => {
    const appointments = () => e2e.dataSource.getRepository(Appointment);
    const payments = () => e2e.dataSource.getRepository(Payment);

    const baseAppointment = {
      tenant: { id: '' } as Tenant,
      branch: { id: '' } as Branch,
      customer: { id: '' } as Customer,
      staff: { id: '' } as StaffProfile,
    };

    beforeAll(async () => {
      baseAppointment.tenant = { id: ownerA.tenantId } as Tenant;
      baseAppointment.branch = { id: branchId } as Branch;
      baseAppointment.customer = { id: customerId } as Customer;
      baseAppointment.staff = { id: staffId } as StaffProfile;

      const mk = (start: Date, status: AppointmentStatus) =>
        appointments().save(
          appointments().create({
            ...baseAppointment,
            start_at: start,
            end_at: new Date(start.getTime() + 30 * 60_000),
            status,
          }),
        );

      // Eligible: COMPLETED, this month.
      await mk(utcDateInMonth(0, 3, 8), AppointmentStatus.COMPLETED);
      await mk(utcDateInMonth(0, 3, 9), AppointmentStatus.COMPLETED);
      // NOT eligible: CANCELLED, this month (wrong status).
      await mk(utcDateInMonth(0, 3, 10), AppointmentStatus.CANCELLED);
      // NOT eligible: COMPLETED, but LAST month (wrong period).
      await mk(utcDateInMonth(-1, 3, 8), AppointmentStatus.COMPLETED);

      const mkPayment = (amount: number, status: PaymentStatus, paidAt: Date | undefined) =>
        payments().save(
          payments().create({
            tenant: { id: ownerA.tenantId } as Tenant,
            amount,
            currency: 'USD',
            status,
            paid_at: paidAt,
          }),
        );

      // Eligible: PAID, this month.
      await mkPayment(300, PaymentStatus.PAID, utcDateInMonth(0, 5));
      await mkPayment(150, PaymentStatus.PAID, utcDateInMonth(0, 6));
      // NOT eligible: PENDING (never paid).
      await mkPayment(1000, PaymentStatus.PENDING, undefined);
      // NOT eligible: PAID, but LAST month.
      await mkPayment(1000, PaymentStatus.PAID, utcDateInMonth(-1, 5));

      // Targets that make the numbers land in interesting places: 2 exactly
      // meets the appointment target (isCompleted), 1000 leaves revenue
      // partway there.
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerA.token))
        .send({ appointmentTarget: 2, revenueTarget: 1000 })
        .expect(200);
    });

    it('counts only COMPLETED appointments within the current UTC month', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(res.body.appointments.current).toBe(2);
      expect(res.body.appointments.target).toBe(2);
      expect(res.body.appointments.remaining).toBe(0);
      expect(res.body.appointments.isCompleted).toBe(true);
    });

    it('counts only PAID payments within the current UTC month', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(Number(res.body.revenue.current)).toBe(450);
      expect(Number(res.body.revenue.target)).toBe(1000);
      expect(Number(res.body.revenue.remaining)).toBe(550);
      expect(res.body.revenue.percentage).toBe(45);
      expect(res.body.revenue.isCompleted).toBe(false);
    });

    it('target changed after progress: raising the target immediately changes remaining/percentage on the next read', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerA.token))
        .send({ appointmentTarget: 5 })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(res.body.appointments.current).toBe(2); // unchanged underlying data
      expect(res.body.appointments.target).toBe(5);
      expect(res.body.appointments.remaining).toBe(3);
      expect(res.body.appointments.isCompleted).toBe(false);
    });

    it("tenant isolation: tenant B's progress is unaffected by tenant A's appointments/payments", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/targets`)
        .set(...authHeader(ownerB.token))
        .expect(200);

      expect(res.body.appointments.current).toBe(0);
      expect(Number(res.body.revenue.current)).toBe(0);
    });
  });
});
