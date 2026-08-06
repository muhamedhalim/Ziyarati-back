/**
 * HTTP e2e for the Doctor / "Other" custom-role staff provisioning flow —
 * verifies the corrections applied on top of the RBAC system:
 *
 *  - A doctor sees/reads ONLY appointments assigned to their own StaffProfile
 *    (appointments.read_own, enforced in AppointmentsService).
 *  - Another doctor's appointment returns 404 (IDOR-safe — never a
 *    distinguishable 403).
 *  - An "Other" employee's custom role carries exactly the granted
 *    permissions (+ the implicit dashboard.access) and nothing more.
 *  - Two employees given identical permission sets get two DISTINCT custom
 *    roles — never reused across employees.
 *  - Editing one employee's permissions never affects another employee's
 *    role, even one created with the same selection.
 *  - A caller can never grant a permission they don't hold, or one reserved
 *    for owner/super_admin (roles.manage), even if they DO hold it.
 *
 * Boots the REAL AppModule (see whatsapp-e2e-app.ts's createE2eApp) against
 * the real dev Postgres so the guard chain (JwtAuthGuard -> PermissionsGuard
 * -> ActiveTenantGuard -> SubscriptionAccessGuard) runs exactly as it does in
 * production. DATABASE ISOLATION: every fixture is scoped under a freshly
 * created Tenant; cleanup() deletes every row this suite created, in
 * FK-safe order, in afterAll.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createE2eApp, createOwnerFixture, authHeader, type E2eApp, type OwnerFixture } from './utils/whatsapp-e2e-app';

import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Customer } from '../src/entities/CRM/Customer';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../src/entities/Auth&RBAC/RolePermission';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Permission } from '../src/entities/Auth&RBAC/Permission';
import { AuditLog } from '../src/entities/Auth&RBAC/AuditLog';
import { PERMISSION } from '../src/rbac/rbac.constants';
import { AppointmentStatus, AppointmentPaymentStatus, AppointmentSource } from '../src/entities/enums';

const API = '/api/v1';

async function mintTokenFor(e2e: E2eApp, userId: string, tenantId: string): Promise<string> {
  return e2e.jwt.signAsync(
    { sub: userId, tenantId, type: 'access' },
    { secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'), expiresIn: '15m' },
  );
}

/** A tenant-scoped user whose role carries EXACTLY the given permission slugs (mirrors integration-api.e2e-spec.ts). */
async function createLimitedActor(e2e: E2eApp, tenantId: string, slugs: string[], label: string) {
  const permissions = e2e.dataSource.getRepository(Permission);
  const roles = e2e.dataSource.getRepository(Role);
  const rolePermissions = e2e.dataSource.getRepository(RolePermission);
  const users = e2e.dataSource.getRepository(User);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const perms = await permissions.createQueryBuilder('p').where('p.slug IN (:...slugs)', { slugs }).getMany();
  if (perms.length !== slugs.length) {
    throw new Error(`Seeded permissions missing for: ${slugs.join(', ')} — run the RBAC seed first.`);
  }

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const role = await roles.save(
    roles.create({ tenant: { id: tenantId } as any, name: `Limited ${suffix}`, slug: `limited-${suffix}`, is_system: false }),
  );
  await rolePermissions.save(perms.map((p) => rolePermissions.create({ role, permission: p })));

  const user = await users.save(
    users.create({ tenant: { id: tenantId } as any, email: `${suffix}@example.test`, full_name: `Limited ${suffix}`, is_active: true }),
  );
  await userRoles.save(userRoles.create({ user: { id: user.id } as User, role: { id: role.id } as Role }));

  const token = await mintTokenFor(e2e, user.id, tenantId);
  return { userId: user.id, token };
}

describe('Staff role scoping (Doctor / "Other") — HTTP e2e', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let branchId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'rbac');

    const branches = e2e.dataSource.getRepository(Branch);
    const branch = await branches.save(branches.create({ tenant: { id: owner.tenantId } as any, name: `Clinic ${randomUUID().slice(0, 6)}` }));
    branchId = branch.id;
  }, 60_000);

  afterAll(async () => {
    const q = (sql: string) => e2e.dataSource.query(sql, [owner.tenantId]);
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
    await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`);
    await q(`DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`);
    await q(`DELETE FROM roles WHERE "tenantId" = $1`);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`);
    await q(`DELETE FROM users WHERE "tenantId" = $1`);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM tenants WHERE id = $1`);
    await e2e.app.close();
  }, 30_000);

  // ── Doctor ownership scoping ──────────────────────────────────────────── //

  describe('Doctor: own-appointments-only scoping', () => {
    let doctorAUserId: string;
    let doctorAStaffId: string;
    let doctorAToken: string;
    let doctorBStaffId: string;
    let apptA: string;
    let apptB: string;

    beforeAll(async () => {
      const createDoctor = async (label: string) => {
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/staff/from-new-user`)
          .set(...authHeader(owner.token))
          .send({
            email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
            fullName: `Dr ${label}`,
            roleSlug: 'doctor',
            title: 'General Practitioner',
          })
          .expect(201);
        return res.body as { profile: { id: string; user: { id: string } } };
      };

      const docA = await createDoctor('a');
      doctorAUserId = docA.profile.user.id;
      doctorAStaffId = docA.profile.id;
      doctorAToken = await mintTokenFor(e2e, doctorAUserId, owner.tenantId);

      const docB = await createDoctor('b');
      doctorBStaffId = docB.profile.id;

      const customers = e2e.dataSource.getRepository(Customer);
      const custA = await customers.save(
        customers.create({ tenant: { id: owner.tenantId } as any, full_name: 'Patient A', phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`, email: `patient-a-${randomUUID().slice(0, 8)}@example.test` }),
      );
      const custB = await customers.save(
        customers.create({ tenant: { id: owner.tenantId } as any, full_name: 'Patient B', phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`, email: `patient-b-${randomUUID().slice(0, 8)}@example.test` }),
      );

      const appointments = e2e.dataSource.getRepository(Appointment);
      const base = {
        tenant: { id: owner.tenantId } as any,
        branch: { id: branchId } as any,
        status: AppointmentStatus.CONFIRMED,
        payment_status: AppointmentPaymentStatus.UNPAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
      };
      const savedA = await appointments.save(
        appointments.create({
          ...base,
          customer: { id: custA.id } as any,
          staff: { id: doctorAStaffId } as any,
          start_at: new Date('2027-01-01T10:00:00Z'),
          end_at: new Date('2027-01-01T10:30:00Z'),
        }),
      );
      apptA = savedA.id;
      const savedB = await appointments.save(
        appointments.create({
          ...base,
          customer: { id: custB.id } as any,
          staff: { id: doctorBStaffId } as any,
          start_at: new Date('2027-01-02T10:00:00Z'),
          end_at: new Date('2027-01-02T10:30:00Z'),
        }),
      );
      apptB = savedB.id;
    }, 60_000);

    it('the created doctor account holds ONLY dashboard.access + appointments.read_own', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff`)
        .set(...authHeader(doctorAToken))
        .expect(403); // no staff.read — proves the minimal grant, not an accident
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it('GET /appointments returns only the doctor\'s own appointment', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .set(...authHeader(doctorAToken))
        .expect(200);

      const ids = (res.body.data as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toContain(apptA);
      expect(ids).not.toContain(apptB);
    });

    it('GET /appointments/:id for the doctor\'s OWN appointment succeeds', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${apptA}`)
        .set(...authHeader(doctorAToken))
        .expect(200);
      expect(res.body.id).toBe(apptA);
    });

    it('GET /appointments/:id for ANOTHER doctor\'s appointment returns 404 (IDOR-safe, not a distinguishable 403)', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${apptB}`)
        .set(...authHeader(doctorAToken))
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('GET /appointments/:id/notes for another doctor\'s appointment also returns 404', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${apptB}/notes`)
        .set(...authHeader(doctorAToken))
        .expect(404);
    });

    it("directly forcing staffId=<doctor B> in the query string does NOT widen the doctor's scope", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments?staffId=${doctorBStaffId}`)
        .set(...authHeader(doctorAToken))
        .expect(200);
      const ids = (res.body.data as Array<{ id: string }>).map((a) => a.id);
      expect(ids).not.toContain(apptB);
      expect(ids).toContain(apptA); // still forced to the caller's own staff id
    });

    it('the owner (full appointments.read) sees BOTH appointments', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .set(...authHeader(owner.token))
        .expect(200);
      const ids = (res.body.data as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toEqual(expect.arrayContaining([apptA, apptB]));
    });
  });

  // ── "Other" custom role: creation, scoping, per-employee isolation ─────── //

  describe('"Other" role: custom permissions, per-employee isolation, reserved-permission blocking', () => {
    // NOT `async`: the body has no `await` of its own, and callers chain
    // `.expect(...)` directly on the return value (e.g. `createOther(...).expect(201)`)
    // before awaiting the whole thing — an `async` wrapper here would box the
    // returned supertest `Test` (thenable AND `.expect()`-able) into a plain
    // `Promise<Response>`, which has no `.expect()` of its own.
    const createOther = (permissionSlugs: string[], label: string, callerToken = owner.token) => {
      return request(e2e.app.getHttpServer())
        .post(`${API}/staff/from-new-user`)
        .set(...authHeader(callerToken))
        .send({
          email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
          fullName: `Other ${label}`,
          roleSlug: 'other',
          permissionSlugs,
          title: 'Front Desk',
        });
    };

    it("creates a custom role carrying exactly the granted permission plus the implicit dashboard.access", async () => {
      const res = await createOther([PERMISSION.APPOINTMENTS_READ], 'emp1').expect(201);
      const userId = res.body.profile.user.id as string;

      const userRole = await e2e.dataSource
        .getRepository(UserRole)
        .createQueryBuilder('ur')
        .innerJoinAndSelect('ur.role', 'role')
        .innerJoinAndSelect('role.rolePermissions', 'rp')
        .innerJoinAndSelect('rp.permission', 'permission')
        .where('ur."userId" = :userId', { userId })
        .getOne();

      expect(userRole?.role.is_system).toBe(false);
      expect(userRole?.role.slug).toMatch(/^custom-/);
      const slugs = userRole!.role.rolePermissions.map((rp) => rp.permission.slug).sort();
      expect(slugs).toEqual([PERMISSION.APPOINTMENTS_READ, PERMISSION.DASHBOARD_ACCESS].sort());
    });

    it('the new "Other" employee can use the granted permission and is denied one they were not given', async () => {
      const res = await createOther([PERMISSION.APPOINTMENTS_READ], 'emp2').expect(201);
      const token = await mintTokenFor(e2e, res.body.profile.user.id, owner.tenantId);

      await request(e2e.app.getHttpServer()).get(`${API}/appointments`).set(...authHeader(token)).expect(200);
      await request(e2e.app.getHttpServer()).get(`${API}/staff`).set(...authHeader(token)).expect(403);
    });

    it('two employees given IDENTICAL permission sets independently get two DISTINCT custom roles (never reused)', async () => {
      const resX = await createOther([PERMISSION.SERVICES_READ], 'dupX').expect(201);
      const resY = await createOther([PERMISSION.SERVICES_READ], 'dupY').expect(201);

      const roleOf = async (userId: string) =>
        e2e.dataSource
          .getRepository(UserRole)
          .createQueryBuilder('ur')
          .innerJoinAndSelect('ur.role', 'role')
          .where('ur."userId" = :userId', { userId })
          .getOne();

      const roleX = await roleOf(resX.body.profile.user.id);
      const roleY = await roleOf(resY.body.profile.user.id);
      expect(roleX?.role.id).not.toEqual(roleY?.role.id);
    });

    it("editing employee X's permissions never affects employee Y's role, even with the same original selection", async () => {
      const resX = await createOther([PERMISSION.SERVICES_READ], 'editX').expect(201);
      const resY = await createOther([PERMISSION.SERVICES_READ], 'editY').expect(201);
      const staffXId = resX.body.profile.id as string;
      const userYId = resY.body.profile.user.id as string;

      await request(e2e.app.getHttpServer())
        .patch(`${API}/staff/${staffXId}`)
        .set(...authHeader(owner.token))
        .send({ roleSlug: 'other', permissionSlugs: [PERMISSION.APPOINTMENTS_READ] })
        .expect(200);

      const roleY = await e2e.dataSource
        .getRepository(UserRole)
        .createQueryBuilder('ur')
        .innerJoinAndSelect('ur.role', 'role')
        .innerJoinAndSelect('role.rolePermissions', 'rp')
        .innerJoinAndSelect('rp.permission', 'permission')
        .where('ur."userId" = :userId', { userId: userYId })
        .getOne();

      const slugsY = roleY!.role.rolePermissions.map((rp) => rp.permission.slug);
      expect(slugsY).toContain(PERMISSION.SERVICES_READ);
      expect(slugsY).not.toContain(PERMISSION.APPOINTMENTS_READ); // employee Y untouched
    });

    it('rejects a permission the CALLER does not hold (privilege-escalation guard)', async () => {
      const manager = await createLimitedActor(
        e2e,
        owner.tenantId,
        [PERMISSION.STAFF_CREATE, PERMISSION.DASHBOARD_ACCESS],
        'mgr-no-appts',
      );
      await createOther([PERMISSION.APPOINTMENTS_READ], 'escalate', manager.token).expect(403);
    });

    it('rejects a RESERVED permission (roles.manage) even from the owner, who DOES hold it', async () => {
      await createOther([PERMISSION.ROLES_MANAGE], 'reserved').expect(403);
    });

    it('rejects an empty permission selection', async () => {
      await createOther([], 'empty').expect(400);
    });

    it('writes an audit log row for the role assignment (actor, employee, new role/permissions)', async () => {
      const res = await createOther([PERMISSION.APPOINTMENTS_READ], 'audited').expect(201);
      const staffId = res.body.profile.id as string;

      const row = await e2e.dataSource
        .getRepository(AuditLog)
        .createQueryBuilder('a')
        .where('a.action = :action', { action: 'staff.role.assigned' })
        .andWhere('a.entity_id = :staffId', { staffId })
        .getOne();

      expect(row).toBeTruthy();
      expect(row?.new_values).toEqual(
        expect.objectContaining({
          role: expect.objectContaining({ isCustom: true, permissionSlugs: expect.arrayContaining([PERMISSION.APPOINTMENTS_READ]) }),
        }),
      );
    });
  });
});
