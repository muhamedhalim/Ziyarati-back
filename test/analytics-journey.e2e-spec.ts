/**
 * Patient Journey plan (approved 2026-09-16) — real Postgres, real HTTP.
 * Mirrors `test/analytics-trends.e2e-spec.ts`'s structure and helpers
 * (`createE2eApp`/`createOwnerFixture`/`authHeader`/`cleanupTenant`).
 *
 * NOT executed in the implementation session (no Postgres/Redis available
 * in that sandbox — see the memory this session left). Typechecked only.
 * Run with `npm run build && npm run test:e2e -- analytics-journey` in an
 * environment with the dev database before relying on it.
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
const FROM = '2032-04-01';
const TO = '2032-04-05';

describe('Patient Journey — authorization, tenant isolation, validation', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let otherOwner: OwnerFixture;
  let branchId: string;
  let staffId: string;
  let customerId: string;
  let customerPhone: string;
  let customerName: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'journey');
    otherOwner = await createOwnerFixture(e2e, 'journey-other');

    const branches = e2e.dataSource.getRepository(Branch);
    const branch = await branches.save(
      branches.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Main',
      }),
    );
    branchId = branch.id;

    const users = e2e.dataSource.getRepository(User);
    const staffUser = await users.save(
      users.create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `staff-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'Dr. E2E',
        is_active: true,
      }),
    );
    const staff = await e2e.dataSource.getRepository(StaffProfile).save(
      e2e.dataSource.getRepository(StaffProfile).create({
        user: { id: staffUser.id } as User,
        tenant: { id: owner.tenantId } as Tenant,
      }),
    );
    staffId = staff.id;

    customerName = 'Extremely Identifiable Patient Name';
    customerPhone = '+966500001234';
    const customer = await e2e.dataSource.getRepository(Customer).save(
      e2e.dataSource.getRepository(Customer).create({
        tenant: { id: owner.tenantId } as Tenant,
        full_name: customerName,
        phone: customerPhone,
      }),
    );
    customerId = customer.id;

    const appointments = e2e.dataSource.getRepository(Appointment);
    await appointments.save(
      appointments.create({
        tenant: { id: owner.tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        customer: { id: customerId } as Customer,
        staff: { id: staffId } as StaffProfile,
        start_at: new Date(`${FROM}T09:00:00.000Z`),
        end_at: new Date(`${FROM}T09:30:00.000Z`),
        status: AppointmentStatus.COMPLETED,
        payment_status: AppointmentPaymentStatus.PAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
      }),
    );
  });

  afterAll(async () => {
    await cleanupTenant(e2e, owner.tenantId);
    await cleanupTenant(e2e, otherOwner.tenantId);
    await e2e.app.close();
  });

  it('401s without a token', async () => {
    await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/journey/summary?from=${FROM}&to=${TO}`)
      .expect(401);
  });

  it('403s a role with no analytics permission at all', async () => {
    const roles = e2e.dataSource.getRepository(Role);
    const noPermsRole = await roles.save(
      roles.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'No Analytics',
        slug: `no-analytics-${randomUUID().slice(0, 8)}`,
        is_system: false,
      }),
    );
    const users = e2e.dataSource.getRepository(User);
    const plainUser = await users.save(
      users.create({
        tenant: { id: owner.tenantId } as Tenant,
        email: `noperm-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'No Perms',
        is_active: true,
      }),
    );
    await e2e.dataSource.getRepository(UserRole).save(
      e2e.dataSource.getRepository(UserRole).create({
        user: { id: plainUser.id } as User,
        role: { id: noPermsRole.id } as Role,
      }),
    );
    const token = await e2e.jwt.signAsync(
      { sub: plainUser.id, tenantId: owner.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );

    await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/journey/summary?from=${FROM}&to=${TO}`)
      .set(...authHeader(token))
      .expect(403);
  });

  it('pins a branch-restricted caller to their own branch and refuses a foreign one', async () => {
    const permRepo = e2e.dataSource.getRepository(Permission);
    const reportsReadPerm = await permRepo.findOne({
      where: { slug: 'analytics.reports.read' },
    });
    expect(reportsReadPerm).toBeDefined();

    const roles = e2e.dataSource.getRepository(Role);
    const customRole = await roles.save(
      roles.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: 'Branch Analyst',
        slug: `branch-analyst-${randomUUID().slice(0, 8)}`,
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
        full_name: 'Branch Analyst',
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
        branch: { id: branchId } as Branch,
        user: { id: restrictedUser.id } as User,
      }),
    );
    const token = await e2e.jwt.signAsync(
      { sub: restrictedUser.id, tenantId: owner.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );

    const own = await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/journey/summary?from=${FROM}&to=${TO}`)
      .set(...authHeader(token))
      .expect(200);
    expect(own.body.scope).toEqual({ branchId });

    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/journey/summary?from=${FROM}&to=${TO}&branchId=${randomUUID()}`,
      )
      .set(...authHeader(token))
      .expect(403);
  });

  it('404s a branchId that belongs to another tenant', async () => {
    const branches = e2e.dataSource.getRepository(Branch);
    const otherBranch = await branches.save(
      branches.create({
        tenant: { id: otherOwner.tenantId } as Tenant,
        name: 'Other Tenant Branch',
      }),
    );

    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/journey/summary?from=${FROM}&to=${TO}&branchId=${otherBranch.id}`,
      )
      .set(...authHeader(owner.token))
      .expect(404);
  });

  it('reports empty for a tenant that has no data, even though another tenant does', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/journey/summary?from=${FROM}&to=${TO}`)
      .set(...authHeader(otherOwner.token))
      .expect(200);
    expect(res.body.empty).toBe(true);
    expect(res.body.counts.booked).toBe(0);
  });

  it('sees its own data as non-empty', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/journey/summary?from=${FROM}&to=${TO}`)
      .set(...authHeader(owner.token))
      .expect(200);
    expect(res.body.empty).toBe(false);
    expect(res.body.counts.booked).toBe(1);
  });

  it('400s an unknown breakdown dimension', async () => {
    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/journey/breakdown?from=${FROM}&to=${TO}&dimension=doctor`,
      )
      .set(...authHeader(owner.token))
      .expect(400);
  });

  it('400s an unknown sort key', async () => {
    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/journey/breakdown?from=${FROM}&to=${TO}&dimension=branch&sort=notarealsort`,
      )
      .set(...authHeader(owner.token))
      .expect(400);
  });

  it('400s a limit over 100', async () => {
    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/journey/breakdown?from=${FROM}&to=${TO}&dimension=branch&limit=101`,
      )
      .set(...authHeader(owner.token))
      .expect(400);
  });

  it('400s a range wider than the shared 731-day bound', async () => {
    await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/journey/summary?from=2020-01-01&to=2026-01-01`)
      .set(...authHeader(owner.token))
      .expect(400);
  });

  it('400s an unknown query parameter (forbidNonWhitelisted)', async () => {
    await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/journey/summary?from=${FROM}&to=${TO}&somethingElse=1`,
      )
      .set(...authHeader(owner.token))
      .expect(400);
  });

  it("never includes the patient's name or phone number anywhere in the response", async () => {
    const summary = await request(e2e.app.getHttpServer())
      .get(`${API}/analytics/journey/summary?from=${FROM}&to=${TO}`)
      .set(...authHeader(owner.token))
      .expect(200);
    const summaryText = JSON.stringify(summary.body);
    expect(summaryText).not.toContain(customerName);
    expect(summaryText).not.toContain(customerPhone);
    expect(summaryText).not.toContain(customerId);

    const breakdown = await request(e2e.app.getHttpServer())
      .get(
        `${API}/analytics/journey/breakdown?from=${FROM}&to=${TO}&dimension=branch`,
      )
      .set(...authHeader(owner.token))
      .expect(200);
    const breakdownText = JSON.stringify(breakdown.body);
    expect(breakdownText).not.toContain(customerName);
    expect(breakdownText).not.toContain(customerPhone);
    expect(breakdownText).not.toContain(customerId);
  });
});
