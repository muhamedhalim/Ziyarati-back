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
 * Doctor role permission refinement (2026-09-10) added four more blocks:
 *  - A doctor's `GET /queue` returns ONLY their own entry (`staffId` in the
 *    query is silently overridden, never honored); every queue MUTATION
 *    route still 403s for them (read-only queue by design); a caller
 *    holding `appointments.read_own` with no StaffProfile sees an empty
 *    queue; owner/receptionist behaviour is unchanged.
 *  - `GET /staff/me`, `/staff/me/schedules`, `/staff/me/time-off`
 *    (`staff.read_own`) return only the caller's own data — a doctor still
 *    cannot reach `GET /staff` or `GET /staff/:id`.
 *  - `GET /dashboard/summary`'s new `myPatients` count is scoped identically
 *    to `appointments` for a doctor, and present (tenant-wide) for the owner.
 *  - `GET /appointments?order=ASC` reverses the default DESC ordering.
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
    await q(`DELETE FROM queue_entries WHERE "tenantId" = $1`);
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

  // ── Doctor: queue read access, widened by the permission refinement ────── //

  describe('Doctor: queue read access (own-scope)', () => {
    let docAUserId: string;
    let docAStaffId: string;
    let docAToken: string;
    let docBStaffId: string;
    let apptA: string;
    let apptB: string;
    let receptionistToken: string;

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

      const docA = await createDoctor('queue-a');
      docAUserId = docA.profile.user.id;
      docAStaffId = docA.profile.id;
      docAToken = await mintTokenFor(e2e, docAUserId, owner.tenantId);

      const docB = await createDoctor('queue-b');
      docBStaffId = docB.profile.id;

      const customers = e2e.dataSource.getRepository(Customer);
      const custA = await customers.save(
        customers.create({
          tenant: { id: owner.tenantId } as any,
          full_name: 'Queue Patient A',
          phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
          email: `queue-patient-a-${randomUUID().slice(0, 8)}@example.test`,
        }),
      );
      const custB = await customers.save(
        customers.create({
          tenant: { id: owner.tenantId } as any,
          full_name: 'Queue Patient B',
          phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
          email: `queue-patient-b-${randomUUID().slice(0, 8)}@example.test`,
        }),
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
          staff: { id: docAStaffId } as any,
          start_at: new Date('2027-02-01T10:00:00Z'),
          end_at: new Date('2027-02-01T10:30:00Z'),
        }),
      );
      apptA = savedA.id;
      const savedB = await appointments.save(
        appointments.create({
          ...base,
          customer: { id: custB.id } as any,
          staff: { id: docBStaffId } as any,
          start_at: new Date('2027-02-01T11:00:00Z'),
          end_at: new Date('2027-02-01T11:30:00Z'),
        }),
      );
      apptB = savedB.id;

      // Check both into TODAY's queue as the OWNER — the real front-desk
      // flow. `business_date` is stamped from the real clock, not the
      // appointment's own (far-future) `start_at` — see
      // `PatientQueueService.checkIn`.
      await request(e2e.app.getHttpServer())
        .post(`${API}/queue/check-in`)
        .set(...authHeader(owner.token))
        .send({ appointmentId: apptA })
        .expect(201);
      await request(e2e.app.getHttpServer())
        .post(`${API}/queue/check-in`)
        .set(...authHeader(owner.token))
        .send({ appointmentId: apptB })
        .expect(201);

      const receptionist = await createLimitedActor(
        e2e,
        owner.tenantId,
        [PERMISSION.DASHBOARD_ACCESS, PERMISSION.APPOINTMENTS_READ, PERMISSION.APPOINTMENTS_UPDATE],
        'queue-reception',
      );
      receptionistToken = receptionist.token;
    }, 60_000);

    it("a doctor's GET /queue returns only their own entry, with scope.staff === 'OWN'", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId })
        .set(...authHeader(docAToken))
        .expect(200);

      const ids = (res.body.data as Array<{ appointment: { id: string } }>).map(
        (e) => e.appointment.id,
      );
      expect(ids).toContain(apptA);
      expect(ids).not.toContain(apptB);
      expect(res.body.scope).toEqual({ staff: 'OWN' });
    });

    it("forcing staffId=<doctor B> in the query string does NOT widen the doctor's scope", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId, staffId: docBStaffId })
        .set(...authHeader(docAToken))
        .expect(200);

      const ids = (res.body.data as Array<{ appointment: { id: string } }>).map(
        (e) => e.appointment.id,
      );
      expect(ids).not.toContain(apptB);
      expect(ids).toContain(apptA); // still forced to the caller's own staff id
    });

    it('GET /queue/branches works for a doctor', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/queue/branches`)
        .set(...authHeader(docAToken))
        .expect(200);
    });

    it('every queue MUTATION route still 403s for a doctor — the queue is read-only for them by design', async () => {
      const entryRes = await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId })
        .set(...authHeader(docAToken))
        .expect(200);
      const ownEntry = (
        entryRes.body.data as Array<{ id: string; appointment: { id: string } }>
      ).find((e) => e.appointment.id === apptA)!;

      const checkIn = await request(e2e.app.getHttpServer())
        .post(`${API}/queue/check-in`)
        .set(...authHeader(docAToken))
        .send({ appointmentId: apptA })
        .expect(403);
      expect(checkIn.body.code).toBe('PERMISSION_DENIED');

      for (const action of ['call', 'start', 'complete', 'skip', 'recall', 'no-show']) {
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/queue/${ownEntry.id}/${action}`)
          .set(...authHeader(docAToken))
          .expect(403);
        expect(res.body.code).toBe('PERMISSION_DENIED');
      }
    });

    it('a nonexistent (or cross-tenant) branchId 404s for a doctor rather than leaking existence', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId: randomUUID() })
        .set(...authHeader(docAToken))
        .expect(404);
    });

    it('a caller holding appointments.read_own but NO StaffProfile sees an empty queue, never the full one', async () => {
      const noProfile = await createLimitedActor(
        e2e,
        owner.tenantId,
        [PERMISSION.DASHBOARD_ACCESS, PERMISSION.APPOINTMENTS_READ_OWN],
        'no-profile-doc',
      );
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId })
        .set(...authHeader(noProfile.token))
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.scope).toEqual({ staff: 'OWN' });
    });

    it("the owner (tenant-wide appointments.read) still sees BOTH entries, scope 'ALL'", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId })
        .set(...authHeader(owner.token))
        .expect(200);

      const ids = (res.body.data as Array<{ appointment: { id: string } }>).map(
        (e) => e.appointment.id,
      );
      expect(ids).toEqual(expect.arrayContaining([apptA, apptB]));
      expect(res.body.scope).toEqual({ staff: 'ALL' });
    });

    it('a receptionist (tenant-wide) is unaffected: reads and mutates the queue exactly as before', async () => {
      const listRes = await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId })
        .set(...authHeader(receptionistToken))
        .expect(200);
      expect(listRes.body.scope).toEqual({ staff: 'ALL' });

      // A self-contained appointment/check-in, so this mutation cannot
      // disturb apptA/apptB's state, which earlier tests in this block
      // still depend on.
      const customers = e2e.dataSource.getRepository(Customer);
      const cust = await customers.save(
        customers.create({
          tenant: { id: owner.tenantId } as any,
          full_name: 'Reception Mutation Patient',
          phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
          email: `reception-mut-${randomUUID().slice(0, 8)}@example.test`,
        }),
      );
      const appointments = e2e.dataSource.getRepository(Appointment);
      const appt = await appointments.save(
        appointments.create({
          tenant: { id: owner.tenantId } as any,
          branch: { id: branchId } as any,
          customer: { id: cust.id } as any,
          staff: { id: docAStaffId } as any,
          status: AppointmentStatus.CONFIRMED,
          payment_status: AppointmentPaymentStatus.UNPAID,
          currency: 'SAR',
          source: AppointmentSource.MANUAL,
          start_at: new Date('2027-02-01T12:00:00Z'),
          end_at: new Date('2027-02-01T12:30:00Z'),
        }),
      );

      const checkInRes = await request(e2e.app.getHttpServer())
        .post(`${API}/queue/check-in`)
        .set(...authHeader(receptionistToken))
        .send({ appointmentId: appt.id })
        .expect(201);

      await request(e2e.app.getHttpServer())
        .post(`${API}/queue/${checkInRes.body.id}/call`)
        .set(...authHeader(receptionistToken))
        .expect(200);
    });
  });

  // ── Doctor: own staff profile / schedule / time-off (staff.read_own) ───── //

  describe('Doctor: own-schedule read (staff.read_own)', () => {
    let docToken: string;
    let docBToken: string;
    let docStaffId: string;

    beforeAll(async () => {
      // Assigned to `branchId` here (unlike the other doctor fixtures in this
      // file) — `StaffScheduleService.createSchedule` requires the staff
      // member to actually be assigned to the branch a slot names.
      const createDoctor = async (label: string) => {
        const res = await request(e2e.app.getHttpServer())
          .post(`${API}/staff/from-new-user`)
          .set(...authHeader(owner.token))
          .send({
            email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
            fullName: `Dr ${label}`,
            roleSlug: 'doctor',
            title: 'General Practitioner',
            branchIds: [branchId],
            primaryBranchId: branchId,
          })
          .expect(201);
        return res.body as { profile: { id: string; user: { id: string } } };
      };

      const doc = await createDoctor('schedule-a');
      docStaffId = doc.profile.id;
      docToken = await mintTokenFor(e2e, doc.profile.user.id, owner.tenantId);

      const docB = await createDoctor('schedule-b');
      docBToken = await mintTokenFor(e2e, docB.profile.user.id, owner.tenantId);

      // A weekly schedule slot for doctor A only, so `/staff/me/schedules`
      // for doctor B can be asserted empty (never doctor A's rows).
      await request(e2e.app.getHttpServer())
        .post(`${API}/staff/${docStaffId}/schedules`)
        .set(...authHeader(owner.token))
        .send({ branchId, dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isActive: true })
        .expect(201);
    }, 60_000);

    it('GET /staff/me returns the caller\'s own profile', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/me`)
        .set(...authHeader(docToken))
        .expect(200);
      expect(res.body.id).toBe(docStaffId);
    });

    it('GET /staff/me/schedules returns only the caller\'s own schedule rows', async () => {
      const mine = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/me/schedules`)
        .set(...authHeader(docToken))
        .expect(200);
      expect(mine.body.length).toBeGreaterThan(0);

      const other = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/me/schedules`)
        .set(...authHeader(docBToken))
        .expect(200);
      expect(other.body).toEqual([]);
    });

    it('GET /staff/me/time-off returns the caller\'s own (empty) time-off list', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/me/time-off`)
        .set(...authHeader(docToken))
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('a doctor still cannot reach GET /staff or GET /staff/:id (no staff.read)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/staff`)
        .set(...authHeader(docToken))
        .expect(403);
      await request(e2e.app.getHttpServer())
        .get(`${API}/staff/${docStaffId}`)
        .set(...authHeader(docToken))
        .expect(403);
    });

    it('the owner (staff.read) is unaffected: GET /staff/:id for the doctor still works', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/staff/${docStaffId}`)
        .set(...authHeader(owner.token))
        .expect(200);
    });
  });

  // ── Dashboard summary (myPatients) + appointment ordering ───────────────── //

  describe('Doctor dashboard summary (myPatients) and GET /appointments?order', () => {
    let docToken: string;
    let apptEarly: string;
    let apptLate: string;
    /** A SECOND branch, with one more of the SAME doctor's appointments — proves
     *  `?branchId=` narrows a doctor to "own appointments AND this branch",
     *  never "every doctor at this branch". */
    let otherBranchId: string;

    beforeAll(async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/staff/from-new-user`)
        .set(...authHeader(owner.token))
        .send({
          email: `summary-doc-${randomUUID().slice(0, 8)}@example.test`,
          fullName: 'Dr Summary',
          roleSlug: 'doctor',
          title: 'General Practitioner',
        })
        .expect(201);
      const { profile } = res.body as { profile: { id: string; user: { id: string } } };
      docToken = await mintTokenFor(e2e, profile.user.id, owner.tenantId);

      const branches = e2e.dataSource.getRepository(Branch);
      const otherBranch = await branches.save(
        branches.create({ tenant: { id: owner.tenantId } as any, name: `Clinic ${randomUUID().slice(0, 6)}` }),
      );
      otherBranchId = otherBranch.id;

      const customers = e2e.dataSource.getRepository(Customer);
      const custEarly = await customers.save(
        customers.create({
          tenant: { id: owner.tenantId } as any,
          full_name: 'Summary Patient Early',
          phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
          email: `summary-patient-early-${randomUUID().slice(0, 8)}@example.test`,
        }),
      );
      const custLate = await customers.save(
        customers.create({
          tenant: { id: owner.tenantId } as any,
          full_name: 'Summary Patient Late',
          phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
          email: `summary-patient-late-${randomUUID().slice(0, 8)}@example.test`,
        }),
      );
      const custOtherBranch = await customers.save(
        customers.create({
          tenant: { id: owner.tenantId } as any,
          full_name: 'Summary Patient Other Branch',
          phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
          email: `summary-patient-other-${randomUUID().slice(0, 8)}@example.test`,
        }),
      );

      const appointments = e2e.dataSource.getRepository(Appointment);
      const base = {
        tenant: { id: owner.tenantId } as any,
        branch: { id: branchId } as any,
        staff: { id: profile.id } as any,
        status: AppointmentStatus.CONFIRMED,
        payment_status: AppointmentPaymentStatus.UNPAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
      };
      const early = await appointments.save(
        appointments.create({
          ...base,
          customer: { id: custEarly.id } as any,
          start_at: new Date('2027-03-01T09:00:00Z'),
          end_at: new Date('2027-03-01T09:30:00Z'),
        }),
      );
      apptEarly = early.id;
      const late = await appointments.save(
        appointments.create({
          ...base,
          customer: { id: custLate.id } as any,
          start_at: new Date('2027-03-02T09:00:00Z'),
          end_at: new Date('2027-03-02T09:30:00Z'),
        }),
      );
      apptLate = late.id;
      // Same doctor, but at `otherBranchId` — so a branch filter can be
      // proven to narrow WITHIN this doctor's own appointments, not widen to
      // every doctor at that branch.
      await appointments.save(
        appointments.create({
          ...base,
          branch: { id: otherBranchId } as any,
          customer: { id: custOtherBranch.id } as any,
          start_at: new Date('2027-03-03T09:00:00Z'),
          end_at: new Date('2027-03-03T09:30:00Z'),
        }),
      );
    }, 60_000);

    it('a doctor\'s dashboard summary, filtered to their original branch, reports scope OWN, myPatients over their 2 distinct patients there, and null for staff/handovers', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/dashboard/summary`)
        .query({ branchId })
        .set(...authHeader(docToken))
        .expect(200);

      expect(res.body.scope.appointments).toBe('OWN');
      expect(res.body.myPatients).toBe(2);
      expect(res.body.staff).toBeNull();
      expect(res.body.pendingHandovers).toBeNull();
    });

    it('"All branches" (no filter) reflects the doctor’s OWN appointments across every branch — 3, not just the 2 at their original branch', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/dashboard/summary`)
        .set(...authHeader(docToken))
        .expect(200);

      expect(res.body.scope.appointments).toBe('OWN');
      expect(res.body.scope.branchIds).toBeNull();
      expect(res.body.myPatients).toBe(3);
    });

    it("the owner's dashboard summary reports scope ALL and a present (tenant-wide) myPatients", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/dashboard/summary`)
        .set(...authHeader(owner.token))
        .expect(200);

      expect(res.body.scope.appointments).toBe('ALL');
      expect(typeof res.body.myPatients).toBe('number');
      expect(res.body.myPatients).toBeGreaterThanOrEqual(2);
    });

    it('a doctor filtering to the OTHER branch sees ONLY their own appointment there — never every doctor at that branch', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/dashboard/summary`)
        .query({ branchId: otherBranchId })
        .set(...authHeader(docToken))
        .expect(200);

      expect(res.body.scope.appointments).toBe('OWN');
      expect(res.body.scope.branchIds).toEqual([otherBranchId]);
      expect(res.body.appointments).toBe(1);
      expect(res.body.myPatients).toBe(1);
    });

    it('a nonexistent (or cross-tenant) branchId 404s for a doctor’s dashboard summary too', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/dashboard/summary`)
        .query({ branchId: randomUUID() })
        .set(...authHeader(docToken))
        .expect(404);
    });

    it('GET /appointments defaults to DESC (most recent first); order=ASC reverses it', async () => {
      const desc = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .query({ page: 1, limit: 50 })
        .set(...authHeader(docToken))
        .expect(200);
      const descIds = (desc.body.data as Array<{ id: string }>).map((a) => a.id);
      expect(descIds.indexOf(apptLate)).toBeLessThan(descIds.indexOf(apptEarly));

      const asc = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .query({ order: 'ASC', page: 1, limit: 50 })
        .set(...authHeader(docToken))
        .expect(200);
      const ascIds = (asc.body.data as Array<{ id: string }>).map((a) => a.id);
      expect(ascIds.indexOf(apptEarly)).toBeLessThan(ascIds.indexOf(apptLate));
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
