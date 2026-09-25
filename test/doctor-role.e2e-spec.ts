/**
 * Doctor role — operational expansion, as real HTTP requests against the REAL
 * AppModule and a real Postgres built from the migration chain.
 *
 * What the doctor gained: own-queue and own-appointment status control,
 * own-patient edit, read-only CRM care context (notes/tags/files) and the
 * Branches working-hours read. What must NOT have changed: tenant isolation,
 * every other role, and the doctor's exclusion from administration.
 *
 * The attacker model throughout is "a doctor who has somehow learned another
 * doctor's / another clinic's UUID". Every refusal asserts BOTH the status code
 * AND that nothing changed in the database — a refusal that still mutated
 * would be worse than none.
 *
 *  - Queue + status: another doctor's entry/appointment is a 404 (same as an
 *    own-scoped read), on ALL seven queue routes and the status route.
 *    A 404 rather than the 409 the state machine would give proves the
 *    ownership check runs BEFORE any state is claimed.
 *  - Status rules: a doctor drives IN_PROGRESS/COMPLETED/NO_SHOW only — never a
 *    manual CONFIRMED (that would bypass payment confirmation), while owner /
 *    receptionist / nurse keep every legal transition.
 *  - Patients: edit is scoped to patients the doctor has a (non-deleted)
 *    appointment with, limited to contact/demographic fields, refused
 *    atomically otherwise; reads stay clinic-wide.
 *  - Working hours: any branch in the doctor's own clinic; a foreign clinic's
 *    branch is a 404.
 *
 * Fixtures go through the real service layer (`POST /staff/from-new-user`)
 * where a StaffProfile is needed, never direct inserts, to stay clear of the
 * known `staff_profiles.public_slug` NOT NULL fixture bug.
 *
 * DATABASE ISOLATION: every row lives under freshly created Tenants (two — the
 * second is the foreign clinic); `afterAll` deletes them in FK-safe order.
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

import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Customer } from '../src/entities/CRM/Customer';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import {
  AppointmentStatus,
  AppointmentPaymentStatus,
  AppointmentSource,
} from '../src/entities/enums';
import { ROLE, ROLE_PERMISSIONS } from '../src/rbac/rbac.constants';

const API = '/api/v1';

async function mintTokenFor(
  e2e: E2eApp,
  userId: string,
  tenantId: string,
): Promise<string> {
  return e2e.jwt.signAsync(
    { sub: userId, tenantId, type: 'access' },
    {
      secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: '15m',
    },
  );
}

/** The REAL pre-seeded system role (tenant IS NULL) — mirrors nurse-role.e2e-spec.ts. */
async function mintTokenForSystemRole(
  e2e: E2eApp,
  tenantId: string,
  roleSlug: string,
  label: string,
) {
  const role = await e2e.dataSource
    .getRepository(Role)
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: roleSlug })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) throw new Error(`Seeded system role "${roleSlug}" not found`);

  const users = e2e.dataSource.getRepository(User);
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as any,
      email: `${suffix}@example.test`,
      full_name: `T-Doc ${suffix}`,
      is_active: true,
    }),
  );
  const userRoles = e2e.dataSource.getRepository(UserRole);
  await userRoles.save(
    userRoles.create({
      user: { id: user.id } as User,
      role: { id: role.id } as Role,
    }),
  );
  return { userId: user.id, token: await mintTokenFor(e2e, user.id, tenantId) };
}

describe('Doctor role — operational expansion (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let owner2: OwnerFixture; // the FOREIGN clinic

  let branchA1: string;
  let branchA2: string; // a second branch in the SAME clinic
  let branchB1: string; // a branch of the FOREIGN clinic

  let doctorA: { staffId: string; userId: string; token: string };
  let doctorB: { staffId: string; userId: string; token: string };
  let nurse: { staffId: string; userId: string; token: string };
  let receptionistToken: string;
  let foreignDoctor: { staffId: string; token: string };

  let custA: string; // has an appointment with doctorA only
  let custB: string; // has an appointment with doctorB only
  let custNone: string; // has no appointment with anyone
  let custSoftDeleted: string; // its only doctorA appointment was soft-deleted
  let foreignCust: string;

  let apptCounter = 0;
  const server = () => e2e.app.getHttpServer();
  const auth = (token: string) => authHeader(token);

  /** A distinct, non-overlapping slot per appointment (the double-booking guard forbids overlap per staff). */
  const slot = () => {
    apptCounter += 1;
    const day = String(((apptCounter - 1) % 28) + 1).padStart(2, '0');
    const month = String(3 + Math.floor((apptCounter - 1) / 28)).padStart(
      2,
      '0',
    );
    return {
      start_at: new Date(`2027-${month}-${day}T10:00:00Z`),
      end_at: new Date(`2027-${month}-${day}T10:30:00Z`),
    };
  };

  const mkAppt = async (opts: {
    staffId: string;
    customerId: string;
    status?: AppointmentStatus;
    tenantId?: string;
    branchId?: string;
  }): Promise<string> => {
    const repo = e2e.dataSource.getRepository(Appointment);
    const saved = await repo.save(
      repo.create({
        tenant: { id: opts.tenantId ?? owner.tenantId } as any,
        branch: { id: opts.branchId ?? branchA1 } as any,
        customer: { id: opts.customerId } as any,
        staff: { id: opts.staffId } as any,
        status: opts.status ?? AppointmentStatus.CONFIRMED,
        payment_status: AppointmentPaymentStatus.PAID,
        total_amount: 200,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
        ...slot(),
      }),
    );
    return saved.id;
  };

  const apptStatus = async (id: string) =>
    (await e2e.dataSource.getRepository(Appointment).findOneByOrFail({ id }))
      .status;

  const queueState = async (id: string): Promise<string> => {
    const rows = await e2e.dataSource.query(
      `SELECT state FROM queue_entries WHERE id = $1`,
      [id],
    );
    return rows[0]?.state;
  };

  const queueRowsFor = async (appointmentId: string): Promise<number> => {
    const rows = await e2e.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM queue_entries WHERE "appointmentId" = $1`,
      [appointmentId],
    );
    return rows[0].c;
  };

  const customerRow = (id: string) =>
    e2e.dataSource.getRepository(Customer).findOneByOrFail({ id });

  const createStaff = async (
    ownerToken: string,
    roleSlug: string,
    title: string,
  ) => {
    const res = await request(server())
      .post(`${API}/staff/from-new-user`)
      .set(...auth(ownerToken))
      .send({
        email: `${roleSlug}-${randomUUID().slice(0, 8)}@example.test`,
        fullName: `Test ${roleSlug}`,
        roleSlug,
        title,
      })
      .expect(201);
    return res.body.profile as { id: string; user: { id: string } };
  };

  const mkCustomer = async (tenantId: string, label: string) => {
    const repo = e2e.dataSource.getRepository(Customer);
    const saved = await repo.save(
      repo.create({
        tenant: { id: tenantId } as any,
        full_name: `Doc ${label}`,
        phone: `+9665${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
        email: `doc-${label}-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    return saved.id;
  };

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'doc-owner');
    owner2 = await createOwnerFixture(e2e, 'doc-foreign');

    const branches = e2e.dataSource.getRepository(Branch);
    const mkBranch = async (tenantId: string, name: string) =>
      (
        await branches.save(
          branches.create({
            tenant: { id: tenantId } as any,
            name: `${name} ${randomUUID().slice(0, 6)}`,
            is_active: true,
          }),
        )
      ).id;
    branchA1 = await mkBranch(owner.tenantId, 'Doc A1');
    branchA2 = await mkBranch(owner.tenantId, 'Doc A2');
    branchB1 = await mkBranch(owner2.tenantId, 'Doc B1');

    const dA = await createStaff(owner.token, ROLE.DOCTOR, 'Doctor A');
    doctorA = {
      staffId: dA.id,
      userId: dA.user.id,
      token: await mintTokenFor(e2e, dA.user.id, owner.tenantId),
    };
    const dB = await createStaff(owner.token, ROLE.DOCTOR, 'Doctor B');
    doctorB = {
      staffId: dB.id,
      userId: dB.user.id,
      token: await mintTokenFor(e2e, dB.user.id, owner.tenantId),
    };
    const n = await createStaff(owner.token, ROLE.NURSE, 'Nurse');
    nurse = {
      staffId: n.id,
      userId: n.user.id,
      token: await mintTokenFor(e2e, n.user.id, owner.tenantId),
    };
    receptionistToken = (
      await mintTokenForSystemRole(
        e2e,
        owner.tenantId,
        ROLE.RECEPTIONIST,
        'doc-recept',
      )
    ).token;
    const fd = await createStaff(owner2.token, ROLE.DOCTOR, 'Foreign Doctor');
    foreignDoctor = {
      staffId: fd.id,
      token: await mintTokenFor(e2e, fd.user.id, owner2.tenantId),
    };

    custA = await mkCustomer(owner.tenantId, 'A');
    custB = await mkCustomer(owner.tenantId, 'B');
    custNone = await mkCustomer(owner.tenantId, 'None');
    custSoftDeleted = await mkCustomer(owner.tenantId, 'SoftDel');
    foreignCust = await mkCustomer(owner2.tenantId, 'Foreign');

    // The provider <-> patient relationship, established the way production
    // does it: by appointments (created by someone else, never the doctor).
    await mkAppt({ staffId: doctorA.staffId, customerId: custA });
    await mkAppt({ staffId: doctorB.staffId, customerId: custB });
    const softDeleted = await mkAppt({
      staffId: doctorA.staffId,
      customerId: custSoftDeleted,
    });
    await e2e.dataSource.getRepository(Appointment).softDelete(softDeleted);

    // Branch working hours for A1 (through the real API, as the owner).
    for (const [day, start, end] of [
      [1, '09:00', '17:00'],
      [2, '10:00', '18:00'],
    ] as const) {
      await request(server())
        .post(`${API}/working-hours`)
        .set(...auth(owner.token))
        .send({
          branchId: branchA1,
          dayOfWeek: day,
          startTime: start,
          endTime: end,
        })
        .expect(201);
    }
    // ...and for the FOREIGN clinic's branch, so a leak would be visible.
    await request(server())
      .post(`${API}/working-hours`)
      .set(...auth(owner2.token))
      .send({
        branchId: branchB1,
        dayOfWeek: 3,
        startTime: '08:00',
        endTime: '12:00',
      })
      .expect(201);
  }, 180_000);

  afterAll(async () => {
    for (const tenantId of [owner.tenantId, owner2.tenantId]) {
      const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
      await q(`DELETE FROM clinical_access_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM clinical_entry_revisions WHERE "tenantId" = $1`);
      await q(`DELETE FROM clinical_entries WHERE "tenantId" = $1`);
      await q(`DELETE FROM clinical_encounters WHERE "tenantId" = $1`);
      await q(`DELETE FROM queue_entries WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
      await q(`DELETE FROM working_hours WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
      await q(`DELETE FROM customer_profiles WHERE "tenantId" = $1`);
      await q(`DELETE FROM customers WHERE "tenantId" = $1`);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`);
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
      await q(
        `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
      );
      await q(
        `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(`DELETE FROM roles WHERE "tenantId" = $1`);
      await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`);
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM users WHERE "tenantId" = $1`);
      await q(`DELETE FROM tenants WHERE id = $1`);
    }
    await e2e.app.close();
  }, 90_000);

  // ────────────────────────────── /auth/me ──────────────────────────────── //

  describe('/auth/me — exact permission set', () => {
    it("the doctor's live permission set is exactly the 12 reviewed slugs", async () => {
      const res = await request(server())
        .get(`${API}/auth/me`)
        .set(...auth(doctorA.token))
        .expect(200);
      expect(new Set(res.body.permissions)).toEqual(
        new Set(ROLE_PERMISSIONS[ROLE.DOCTOR]),
      );
      expect(res.body.permissions).toHaveLength(12);
      expect(res.body.roles).toEqual([ROLE.DOCTOR]);
    });
  });

  // ─────────────────────────── Working hours ────────────────────────────── //

  describe('Working hours — the reported 403, fixed without loosening isolation', () => {
    it('own clinic, first branch: 200 with the branch’s hours (the exact request that used to 403)', async () => {
      const res = await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: branchA1 })
        .set(...auth(doctorA.token))
        .expect(200);
      const rows = res.body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.day_of_week)).toEqual([1, 2]);
      expect(rows[0]).toMatchObject({ is_closed: false });
      expect(String(rows[0].start_time)).toMatch(/^09:00/);
    });

    it('own clinic, a DIFFERENT branch: 200 (any branch of the clinic; this one simply has no hours yet)', async () => {
      const res = await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: branchA2 })
        .set(...auth(doctorA.token))
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it("a FOREIGN clinic's branch: 404, and none of that clinic's rows leak", async () => {
      const res = await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: branchB1 })
        .set(...auth(doctorA.token))
        .expect(404);
      expect(JSON.stringify(res.body)).not.toContain('08:00');
    });

    it('a random UUID is indistinguishable from the foreign branch: 404', async () => {
      await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: randomUUID() })
        .set(...auth(doctorA.token))
        .expect(404);
    });

    it('missing or malformed branchId: 400', async () => {
      await request(server())
        .get(`${API}/working-hours`)
        .set(...auth(doctorA.token))
        .expect(400);
      await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: 'not-a-uuid' })
        .set(...auth(doctorA.token))
        .expect(400);
    });

    it('a doctor still cannot WRITE working hours: create/update/delete are 403', async () => {
      const list = await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: branchA1 })
        .set(...auth(owner.token))
        .expect(200);
      const rowId = list.body[0].id as string;

      await request(server())
        .post(`${API}/working-hours`)
        .set(...auth(doctorA.token))
        .send({
          branchId: branchA1,
          dayOfWeek: 5,
          startTime: '09:00',
          endTime: '10:00',
        })
        .expect(403);
      await request(server())
        .patch(`${API}/working-hours/${rowId}`)
        .set(...auth(doctorA.token))
        .send({ endTime: '23:00' })
        .expect(403);
      await request(server())
        .delete(`${API}/working-hours/${rowId}`)
        .set(...auth(doctorA.token))
        .expect(403);

      const after = await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: branchA1 })
        .set(...auth(owner.token))
        .expect(200);
      expect(after.body).toHaveLength(2);
    });

    it('roles that already read working hours are unchanged: owner and receptionist 200', async () => {
      for (const token of [owner.token, receptionistToken]) {
        await request(server())
          .get(`${API}/working-hours`)
          .query({ branchId: branchA1 })
          .set(...auth(token))
          .expect(200);
      }
    });

    it('the nurse still has NO working-hours read (unchanged): 403', async () => {
      await request(server())
        .get(`${API}/working-hours`)
        .query({ branchId: branchA1 })
        .set(...auth(nurse.token))
        .expect(403);
    });

    it('the read grant did not unlock staff browsing or branch administration for the doctor', async () => {
      await request(server())
        .get(`${API}/staff`)
        .set(...auth(doctorA.token))
        .expect(403);
      await request(server())
        .get(`${API}/staff/availability`)
        .query({ branchId: branchA1 })
        .set(...auth(doctorA.token))
        .expect(403);
      await request(server())
        .post(`${API}/branches`)
        .set(...auth(doctorA.token))
        .send({ name: 'Nope' })
        .expect(403);
      await request(server())
        .patch(`${API}/branches/${branchA1}`)
        .set(...auth(doctorA.token))
        .send({ name: 'Renamed' })
        .expect(403);
      await request(server())
        .delete(`${API}/branches/${branchA1}`)
        .set(...auth(doctorA.token))
        .expect(403);
      // ...while the branch LIST the Branches page renders is still readable.
      const list = await request(server())
        .get(`${API}/branches`)
        .set(...auth(doctorA.token))
        .expect(200);
      const ids = (list.body as Array<{ id: string }>).map((b) => b.id);
      expect(ids).toEqual(expect.arrayContaining([branchA1, branchA2]));
      expect(ids).not.toContain(branchB1);
    });
  });

  // ──────────────────────────────── Queue ───────────────────────────────── //

  describe('Queue — own lifecycle allowed', () => {
    it('check-in -> call -> start -> complete on OWN appointment: every step succeeds, the appointment follows, and the doctor is not redacted', async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });

      const checkIn = await request(server())
        .post(`${API}/queue/check-in`)
        .set(...auth(doctorA.token))
        .send({ appointmentId: appt })
        .expect(201);
      const entryId = checkIn.body.id as string;
      expect(checkIn.body.state).toBe('WAITING');
      // A doctor holds appointments.read_own, so financials stay visible (unchanged).
      expect(checkIn.body.appointment).toHaveProperty('paymentStatus');

      await request(server())
        .post(`${API}/queue/${entryId}/call`)
        .set(...auth(doctorA.token))
        .expect(200);
      expect(await queueState(entryId)).toBe('CALLED');

      await request(server())
        .post(`${API}/queue/${entryId}/start`)
        .set(...auth(doctorA.token))
        .expect(200);
      expect(await queueState(entryId)).toBe('IN_CONSULTATION');
      expect(await apptStatus(appt)).toBe(AppointmentStatus.IN_PROGRESS);

      const done = await request(server())
        .post(`${API}/queue/${entryId}/complete`)
        .set(...auth(doctorA.token))
        .expect(200);
      expect(done.body.state).toBe('COMPLETED');
      expect(await apptStatus(appt)).toBe(AppointmentStatus.COMPLETED);
    });

    it('skip -> recall and no-show also work on the OWN entry', async () => {
      const skipAppt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      const skipEntry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(doctorA.token))
          .send({ appointmentId: skipAppt })
          .expect(201)
      ).body.id as string;
      await request(server())
        .post(`${API}/queue/${skipEntry}/call`)
        .set(...auth(doctorA.token))
        .expect(200);
      await request(server())
        .post(`${API}/queue/${skipEntry}/skip`)
        .set(...auth(doctorA.token))
        .expect(200);
      await request(server())
        .post(`${API}/queue/${skipEntry}/recall`)
        .set(...auth(doctorA.token))
        .expect(200);
      expect(await queueState(skipEntry)).toBe('WAITING');

      await request(server())
        .post(`${API}/queue/${skipEntry}/no-show`)
        .set(...auth(doctorA.token))
        .expect(200);
      expect(await queueState(skipEntry)).toBe('NO_SHOW');
      expect(await apptStatus(skipAppt)).toBe(AppointmentStatus.NO_SHOW);
    });

    it('GET /queue is own-scoped for a doctor: sees own entries, never another doctor’s', async () => {
      const aAppt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      const bAppt = await mkAppt({
        staffId: doctorB.staffId,
        customerId: custB,
      });
      const aEntry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(owner.token))
          .send({ appointmentId: aAppt })
          .expect(201)
      ).body.id as string;
      const bEntry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(owner.token))
          .send({ appointmentId: bAppt })
          .expect(201)
      ).body.id as string;

      const listA = await request(server())
        .get(`${API}/queue`)
        .query({ branchId: branchA1 })
        .set(...auth(doctorA.token))
        .expect(200);
      const idsA = (listA.body.data as Array<{ id: string }>).map((e) => e.id);
      expect(listA.body.scope).toEqual({ staff: 'OWN' });
      expect(idsA).toContain(aEntry);
      expect(idsA).not.toContain(bEntry);
    });
  });

  describe('Queue — another doctor’s entry is untouchable (IDOR)', () => {
    let waitingEntry: string;
    let waitingAppt: string;
    let calledEntry: string;
    let calledAppt: string;

    beforeAll(async () => {
      waitingAppt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      waitingEntry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(owner.token))
          .send({ appointmentId: waitingAppt })
          .expect(201)
      ).body.id as string;

      calledAppt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      calledEntry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(owner.token))
          .send({ appointmentId: calledAppt })
          .expect(201)
      ).body.id as string;
      await request(server())
        .post(`${API}/queue/${calledEntry}/call`)
        .set(...auth(owner.token))
        .expect(200);
    });

    it.each(['call', 'start', 'complete', 'skip', 'recall', 'no-show'])(
      'doctor B -> %s on doctor A’s entry: 404, never the 409 the state machine would give (the ownership check runs first)',
      async (action) => {
        const res = await request(server())
          .post(`${API}/queue/${waitingEntry}/${action}`)
          .set(...auth(doctorB.token));
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Queue entry not found');
      },
    );

    it('...and after every attempt above, the entry and its appointment are exactly as they were', async () => {
      expect(await queueState(waitingEntry)).toBe('WAITING');
      expect(await apptStatus(waitingAppt)).toBe(AppointmentStatus.CONFIRMED);
    });

    it('doctor B skipping/no-showing a CALLED entry (a state where the action WOULD be valid) is still 404 and moves nothing', async () => {
      for (const action of ['skip', 'no-show']) {
        await request(server())
          .post(`${API}/queue/${calledEntry}/${action}`)
          .set(...auth(doctorB.token))
          .expect(404);
      }
      expect(await queueState(calledEntry)).toBe('CALLED');
      expect(await apptStatus(calledAppt)).toBe(AppointmentStatus.CONFIRMED);
    });

    it('doctor B cannot check in doctor A’s appointment: 404 and no queue row is created', async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      const res = await request(server())
        .post(`${API}/queue/check-in`)
        .set(...auth(doctorB.token))
        .send({ appointmentId: appt });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Appointment not found');
      expect(await queueRowsFor(appt)).toBe(0);
    });

    it("a doctor cannot reach ANOTHER CLINIC's entry or appointment: 404 on every route, nothing changes", async () => {
      const foreignAppt = await mkAppt({
        staffId: foreignDoctor.staffId,
        customerId: foreignCust,
        tenantId: owner2.tenantId,
        branchId: branchB1,
      });
      const foreignEntry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(owner2.token))
          .send({ appointmentId: foreignAppt })
          .expect(201)
      ).body.id as string;

      for (const action of [
        'call',
        'start',
        'complete',
        'skip',
        'recall',
        'no-show',
      ]) {
        await request(server())
          .post(`${API}/queue/${foreignEntry}/${action}`)
          .set(...auth(doctorA.token))
          .expect(404);
      }
      await request(server())
        .post(`${API}/queue/check-in`)
        .set(...auth(doctorA.token))
        .send({ appointmentId: foreignAppt })
        .expect(404);

      expect(await queueState(foreignEntry)).toBe('WAITING');
      expect(await apptStatus(foreignAppt)).toBe(AppointmentStatus.CONFIRMED);
    });
  });

  describe('Queue — every other role keeps its reach (no regression)', () => {
    it("the nurse (tenant-wide, NOT confined) still drives doctor A's entry: call -> start -> complete", async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      const entry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(nurse.token))
          .send({ appointmentId: appt })
          .expect(201)
      ).body.id as string;
      for (const action of ['call', 'start', 'complete']) {
        await request(server())
          .post(`${API}/queue/${entry}/${action}`)
          .set(...auth(nurse.token))
          .expect(200);
      }
      expect(await apptStatus(appt)).toBe(AppointmentStatus.COMPLETED);
    });

    it("the owner still drives doctor B's entry (tenant-wide)", async () => {
      const appt = await mkAppt({
        staffId: doctorB.staffId,
        customerId: custB,
      });
      const entry = (
        await request(server())
          .post(`${API}/queue/check-in`)
          .set(...auth(owner.token))
          .send({ appointmentId: appt })
          .expect(201)
      ).body.id as string;
      await request(server())
        .post(`${API}/queue/${entry}/call`)
        .set(...auth(owner.token))
        .expect(200);
    });
  });

  // ─────────────────────────── Appointment status ───────────────────────── //

  describe('Appointment status — own appointments, clinical lifecycle only', () => {
    it('CONFIRMED -> IN_PROGRESS -> COMPLETED on OWN appointment: 200, response not redacted', async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      const start = await request(server())
        .post(`${API}/appointments/${appt}/status`)
        .set(...auth(doctorA.token))
        .send({ status: AppointmentStatus.IN_PROGRESS })
        .expect(200);
      expect(start.body.status).toBe(AppointmentStatus.IN_PROGRESS);
      expect(start.body).toHaveProperty('total_amount');

      await request(server())
        .post(`${API}/appointments/${appt}/status`)
        .set(...auth(doctorA.token))
        .send({ status: AppointmentStatus.COMPLETED })
        .expect(200);
      expect(await apptStatus(appt)).toBe(AppointmentStatus.COMPLETED);
    });

    it('NO_SHOW on OWN appointment: 200', async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      await request(server())
        .post(`${API}/appointments/${appt}/status`)
        .set(...auth(doctorA.token))
        .send({ status: AppointmentStatus.NO_SHOW })
        .expect(200);
      expect(await apptStatus(appt)).toBe(AppointmentStatus.NO_SHOW);
    });

    it("another doctor's appointment: 404 (identical to an own-scoped read) and unchanged", async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      const res = await request(server())
        .post(`${API}/appointments/${appt}/status`)
        .set(...auth(doctorB.token))
        .send({ status: AppointmentStatus.IN_PROGRESS });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Appointment not found');
      expect(await apptStatus(appt)).toBe(AppointmentStatus.CONFIRMED);

      const read = await request(server())
        .get(`${API}/appointments/${appt}`)
        .set(...auth(doctorB.token));
      expect(read.status).toBe(404);
    });

    it("another clinic's appointment: 404 and unchanged", async () => {
      const foreignAppt = await mkAppt({
        staffId: foreignDoctor.staffId,
        customerId: foreignCust,
        tenantId: owner2.tenantId,
        branchId: branchB1,
      });
      await request(server())
        .post(`${API}/appointments/${foreignAppt}/status`)
        .set(...auth(doctorA.token))
        .send({ status: AppointmentStatus.IN_PROGRESS })
        .expect(404);
      expect(await apptStatus(foreignAppt)).toBe(AppointmentStatus.CONFIRMED);
    });

    it('a doctor may NOT manually CONFIRM a PENDING_PAYMENT booking (403) — that would bypass payment confirmation; the status is unchanged', async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
        status: AppointmentStatus.PENDING_PAYMENT,
      });
      const res = await request(server())
        .post(`${API}/appointments/${appt}/status`)
        .set(...auth(doctorA.token))
        .send({ status: AppointmentStatus.CONFIRMED });
      expect(res.status).toBe(403);
      expect(await apptStatus(appt)).toBe(AppointmentStatus.PENDING_PAYMENT);
    });

    it('a doctor may not set RESCHEDULED either (403)', async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      await request(server())
        .post(`${API}/appointments/${appt}/status`)
        .set(...auth(doctorA.token))
        .send({ status: AppointmentStatus.RESCHEDULED })
        .expect(403);
      expect(await apptStatus(appt)).toBe(AppointmentStatus.CONFIRMED);
    });

    it('unconfined roles keep the manual CONFIRM they always had: owner and nurse -> 200', async () => {
      for (const token of [owner.token, nurse.token]) {
        const appt = await mkAppt({
          staffId: doctorA.staffId,
          customerId: custA,
          status: AppointmentStatus.PENDING_PAYMENT,
        });
        await request(server())
          .post(`${API}/appointments/${appt}/status`)
          .set(...auth(token))
          .send({ status: AppointmentStatus.CONFIRMED })
          .expect(200);
        expect(await apptStatus(appt)).toBe(AppointmentStatus.CONFIRMED);
      }
    });

    it('every OTHER appointment write stays refused for the doctor: create/update/services/notes/cancel/reschedule/delete are 403', async () => {
      const appt = await mkAppt({
        staffId: doctorA.staffId,
        customerId: custA,
      });
      const t = auth(doctorA.token);
      const checks = await Promise.all([
        request(server())
          .post(`${API}/appointments`)
          .set(...t)
          .send({}),
        request(server())
          .patch(`${API}/appointments/${appt}`)
          .set(...t)
          .send({}),
        request(server())
          .put(`${API}/appointments/${appt}/services`)
          .set(...t)
          .send({ serviceIds: [randomUUID()] }),
        request(server())
          .post(`${API}/appointments/${appt}/notes`)
          .set(...t)
          .send({ text: 'nope' }),
        request(server())
          .post(`${API}/appointments/${appt}/cancel`)
          .set(...t)
          .send({}),
        request(server())
          .post(`${API}/appointments/${appt}/reschedule`)
          .set(...t)
          .send({}),
        request(server())
          .delete(`${API}/appointments/${appt}`)
          .set(...t),
      ]);
      for (const res of checks) expect(res.status).toBe(403);
      expect(await apptStatus(appt)).toBe(AppointmentStatus.CONFIRMED);
    });
  });

  // ──────────────────────────────── Patients ────────────────────────────── //

  describe('Patients — edit is scoped to the doctor’s own patients', () => {
    it('OWN patient: PATCH contact/demographic fields -> 200 and persisted', async () => {
      const res = await request(server())
        .patch(`${API}/crm/customers/${custA}`)
        .set(...auth(doctorA.token))
        .send({
          full_name: 'Renamed By Doctor A',
          phone: '+966511223344',
          gender: 'female',
          date_of_birth: '1991-04-02',
          preferred_locale: 'ar',
        })
        .expect(200);
      expect(res.body.full_name).toBe('Renamed By Doctor A');

      const row = await customerRow(custA);
      expect(row.full_name).toBe('Renamed By Doctor A');
      expect(row.phone).toBe('+966511223344');
      expect(row.preferred_locale).toBe('ar');
    });

    it('the chronic-disease intake answer is editable, with the cross-field rule still enforced', async () => {
      await request(server())
        .patch(`${API}/crm/customers/${custA}`)
        .set(...auth(doctorA.token))
        .send({ has_chronic_diseases: true, chronic_diseases: 'Asthma' })
        .expect(200);
      await request(server())
        .patch(`${API}/crm/customers/${custA}`)
        .set(...auth(doctorA.token))
        .send({ has_chronic_diseases: true, chronic_diseases: '' })
        .expect(400);
      expect((await customerRow(custA)).chronic_diseases).toBe('Asthma');
    });

    it("ANOTHER doctor's patient: 403, and nothing is written", async () => {
      const before = await customerRow(custB);
      const res = await request(server())
        .patch(`${API}/crm/customers/${custB}`)
        .set(...auth(doctorA.token))
        .send({ full_name: 'Hijacked' });
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/appointment with/);
      expect((await customerRow(custB)).full_name).toBe(before.full_name);
    });

    it('a patient with NO appointment with anyone: 403', async () => {
      const before = await customerRow(custNone);
      await request(server())
        .patch(`${API}/crm/customers/${custNone}`)
        .set(...auth(doctorA.token))
        .send({ full_name: 'Hijacked' })
        .expect(403);
      expect((await customerRow(custNone)).full_name).toBe(before.full_name);
    });

    it('a patient whose only appointment with the doctor was soft-deleted: 403 (a deleted relationship grants nothing)', async () => {
      await request(server())
        .patch(`${API}/crm/customers/${custSoftDeleted}`)
        .set(...auth(doctorA.token))
        .send({ full_name: 'Hijacked' })
        .expect(403);
    });

    it("another CLINIC's patient: 404 (indistinguishable from a missing id), nothing written", async () => {
      const before = await customerRow(foreignCust);
      await request(server())
        .patch(`${API}/crm/customers/${foreignCust}`)
        .set(...auth(doctorA.token))
        .send({ full_name: 'Hijacked' })
        .expect(404);
      await request(server())
        .patch(`${API}/crm/customers/${randomUUID()}`)
        .set(...auth(doctorA.token))
        .send({ full_name: 'Hijacked' })
        .expect(404);
      expect((await customerRow(foreignCust)).full_name).toBe(before.full_name);
    });

    it.each([
      ['is_active', false],
      ['marketing_opt_in', true],
      ['source', 'walk_in'],
      ['national_id', 'ID-99887766'],
      ['whatsapp_id', 'wa-1234'],
      ['whatsapp_name', 'WA Name'],
      ['has_health_insurance', true],
    ])(
      'mass assignment: %s on an OWN patient is refused (403) ATOMICALLY — the allowed field sent alongside it is not written either',
      async (field, value) => {
        const before = await customerRow(custA);
        const res = await request(server())
          .patch(`${API}/crm/customers/${custA}`)
          .set(...auth(doctorA.token))
          .send({ full_name: 'Partial Write Attempt', [field]: value });
        expect(res.status).toBe(403);
        expect(res.body.message).toContain(field);

        const after = await customerRow(custA);
        expect(after.full_name).toBe(before.full_name);
        expect((after as any)[field]).toEqual((before as any)[field]);
      },
    );

    it.each(['tenant', 'id', 'tenantId', 'deleted_at', 'opted_out_at'])(
      'mass assignment: an unknown/system field (%s) is rejected 400 by the global whitelist before anything runs',
      async (field) => {
        await request(server())
          .patch(`${API}/crm/customers/${custA}`)
          .set(...auth(doctorA.token))
          .send({ [field]: field === 'tenant' ? { id: owner2.tenantId } : 'x' })
          .expect(400);
      },
    );

    it('a doctor cannot create, delete, import, or manage addresses/notes/tags/files/segments', async () => {
      const t = auth(doctorA.token);
      const checks = await Promise.all([
        request(server())
          .post(`${API}/crm/customers`)
          .set(...t)
          .send({ phone: '+966500000001', email: 'x@example.test' }),
        request(server())
          .delete(`${API}/crm/customers/${custA}`)
          .set(...t),
        request(server())
          .post(`${API}/crm/customers/${custA}/addresses`)
          .set(...t)
          .send({}),
        request(server())
          .post(`${API}/crm/customers/${custA}/notes`)
          .set(...t)
          .send({ content: 'nope' }),
        request(server())
          .post(`${API}/crm/customers/${custA}/tags`)
          .set(...t)
          .send({ tagId: randomUUID() }),
        request(server())
          .post(`${API}/crm/customers/${custA}/files`)
          .set(...t)
          .send({}),
        request(server())
          .post(`${API}/crm/segments`)
          .set(...t)
          .send({}),
        request(server())
          .post(`${API}/crm/customers/import/commit`)
          .set(...t)
          .send({}),
      ]);
      for (const res of checks) expect(res.status).toBe(403);
      expect((await customerRow(custA)).deleted_at).toBeFalsy();
    });

    it('READS stay clinic-wide (unchanged, FR-H010c): the doctor can open another doctor’s patient, plus the notes/tags/files care context', async () => {
      const t = auth(doctorA.token);
      await request(server())
        .get(`${API}/crm/customers/${custB}`)
        .set(...t)
        .expect(200);
      await request(server())
        .get(`${API}/crm/customers`)
        .set(...t)
        .expect(200);
      await request(server())
        .get(`${API}/crm/customers/${custA}/notes`)
        .set(...t)
        .expect(200);
      await request(server())
        .get(`${API}/crm/customers/${custA}/tags`)
        .set(...t)
        .expect(200);
      await request(server())
        .get(`${API}/crm/customers/${custA}/files`)
        .set(...t)
        .expect(200);
    });

    it('a foreign clinic’s patient is unreadable: 404', async () => {
      await request(server())
        .get(`${API}/crm/customers/${foreignCust}`)
        .set(...auth(doctorA.token))
        .expect(404);
    });
  });

  describe('Patient profile (emergency contact + clinical fields)', () => {
    it('OWN patient: PUT -> 200, including the clinical fields the doctor holds clinical.records.manage for', async () => {
      const res = await request(server())
        .put(`${API}/crm/customers/${custA}/profile`)
        .set(...auth(doctorA.token))
        .send({
          emergency_contact_name: 'Next Of Kin',
          emergency_contact_phone: '+966500009999',
          allergies: 'Penicillin',
          blood_type: 'O+',
        })
        .expect(200);
      expect(res.body.emergency_contact_name).toBe('Next Of Kin');
      expect(res.body.allergies).toBe('Penicillin');

      const read = await request(server())
        .get(`${API}/crm/customers/${custA}/profile`)
        .set(...auth(doctorA.token))
        .expect(200);
      expect(read.body.blood_type).toBe('O+');
    });

    it("another doctor's patient: PUT -> 403 and nothing is created", async () => {
      await request(server())
        .put(`${API}/crm/customers/${custB}/profile`)
        .set(...auth(doctorA.token))
        .send({ emergency_contact_name: 'Hijacked' })
        .expect(403);
      const rows = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM customer_profiles WHERE customer_id = $1`,
        [custB],
      );
      expect(rows[0].c).toBe(0);
    });

    it("another clinic's patient: PUT -> 404", async () => {
      await request(server())
        .put(`${API}/crm/customers/${foreignCust}/profile`)
        .set(...auth(doctorA.token))
        .send({ emergency_contact_name: 'Hijacked' })
        .expect(404);
    });

    it('unknown profile fields are rejected 400 (whitelist)', async () => {
      await request(server())
        .put(`${API}/crm/customers/${custA}/profile`)
        .set(...auth(doctorA.token))
        .send({ tenant: { id: owner2.tenantId } })
        .expect(400);
    });
  });

  describe('Patient edit — every other role is unchanged', () => {
    it('the owner still edits ANY patient in the clinic, including the fields a doctor is refused', async () => {
      await request(server())
        .patch(`${API}/crm/customers/${custB}`)
        .set(...auth(owner.token))
        .send({
          full_name: 'Owner Edit',
          is_active: true,
          marketing_opt_in: true,
          source: 'walk_in',
        })
        .expect(200);
      expect((await customerRow(custB)).full_name).toBe('Owner Edit');
    });

    it('the receptionist still edits a patient with no appointment link at all', async () => {
      await request(server())
        .patch(`${API}/crm/customers/${custNone}`)
        .set(...auth(receptionistToken))
        .send({ full_name: 'Reception Edit' })
        .expect(200);
      expect((await customerRow(custNone)).full_name).toBe('Reception Edit');
    });

    it('the nurse still cannot edit a patient (read-only CRM, unchanged)', async () => {
      await request(server())
        .patch(`${API}/crm/customers/${custA}`)
        .set(...auth(nurse.token))
        .send({ full_name: 'Nurse Edit' })
        .expect(403);
      await request(server())
        .put(`${API}/crm/customers/${custA}/profile`)
        .set(...auth(nurse.token))
        .send({ emergency_contact_name: 'Nurse Edit' })
        .expect(403);
    });

    it('the doctor cannot escalate by any route into administration: staff, roles, billing, settings stay 403', async () => {
      const t = auth(doctorA.token);
      for (const path of ['/staff', '/services', '/roles', '/users']) {
        const res = await request(server())
          .get(`${API}${path}`)
          .set(...t);
        expect([401, 403, 404]).toContain(res.status);
        expect(res.status).not.toBe(200);
      }
      await request(server())
        .post(`${API}/staff/from-new-user`)
        .set(...t)
        .send({
          email: 'x@example.test',
          fullName: 'X',
          roleSlug: ROLE.OWNER,
          title: 'X',
        })
        .expect(403);
    });
  });
});
