/**
 * Nurse role — the full allow/deny matrix, as real HTTP requests against the
 * REAL AppModule (see the plan at
 * `.claude/plans/pasted-content-id-b54e-review-the-polymorphic-quilt.md`,
 * Phase 3). Every fixture goes through the REAL service layer
 * (`POST /staff/from-new-user`) rather than inserting `StaffProfile` rows
 * directly, so this suite never falls into the pre-existing, unrelated
 * `staff_profiles.public_slug` NOT NULL fixture bug tracked separately
 * (background task) that crashes several OTHER e2e files.
 *
 * Pins, one per adopted decision:
 *  - D1: Nurse is clinic-wide — never branch-restricted (no `branches.update_own`).
 *  - D2: Nurse holds `appointments.status.update`, never `appointments.update` —
 *    queue/status routes only, never PATCH/services/cancel/reschedule/delete.
 *  - D3: Nurse's CRM/file access is read-only — never `crm.files.manage`.
 *  - D4: Nurse may create NOTE/VITALS entries only, never DIAGNOSIS/MEDICATION/
 *    ALLERGY, and may correct only their OWN NOTE/VITALS entries.
 *  - Public booking: a nurse profile is NEVER bookable, even when the request
 *    forges `isAvailableForBooking: true`, even when converted FROM a
 *    bookable doctor, even with a real working schedule at a branch — proven
 *    both at the write boundary (`StaffService`) and at the actual public
 *    read surface (`GET /public/discovery/doctors`) Phase 0 identified as
 *    the sole gate every public/AI booking surface shares.
 *  - Appointment financial redaction: a nurse's `appointments.read` never
 *    surfaces `total_amount`/`payment_status`/`currency`/service `price`/
 *    `refundAmount`/queue `paymentStatus`; every other real system role
 *    (owner/receptionist/doctor) keeps seeing them, unchanged.
 *  - `StaffAccessService.grant()`'s pre-existing "converts to receptionist"
 *    behaviour is never reached by ordinary nurse creation/update.
 *
 * DATABASE ISOLATION: every fixture lives under a freshly created Tenant (two,
 * for the cross-tenant 404 case); `afterAll` deletes every row this suite
 * created, in FK-safe order.
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

import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Customer } from '../src/entities/CRM/Customer';
import { Service, PricingType } from '../src/entities/Services/Service';
import { Appointment } from '../src/entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceLine } from '../src/entities/Calendar&Appointments/AppointmentService';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import {
  AppointmentStatus,
  AppointmentPaymentStatus,
  AppointmentSource,
  ClinicalEntryKind,
} from '../src/entities/enums';
import { PERMISSION, ROLE, ROLE_PERMISSIONS } from '../src/rbac/rbac.constants';

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

/** The REAL pre-seeded system role (tenant IS NULL) — mirrors clinical-records-authz.e2e-spec.ts. */
async function mintTokenForSystemRole(
  e2e: E2eApp,
  tenantId: string,
  roleSlug: string,
  label: string,
) {
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

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as any,
      email: `${suffix}@example.test`,
      full_name: `T-Nurse ${suffix}`,
      is_active: true,
    }),
  );
  await userRoles.save(
    userRoles.create({
      user: { id: user.id } as User,
      role: { id: role.id } as Role,
    }),
  );

  const token = await mintTokenFor(e2e, user.id, tenantId);
  return { userId: user.id, token };
}

describe('Nurse role — full allow/deny matrix (Phase 3, HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let owner2: OwnerFixture;
  let branchId: string;
  let tenantSlug: string;

  let nurseStaffId: string;
  let nurseUserId: string;
  let nurseToken: string;

  let doctorStaffId: string;
  let doctorUserId: string;
  let doctorToken: string;

  let customerId: string;
  let foreignCustomerId: string;
  let serviceId: string;

  let apptFinancial: string;
  let apptForStatus: string;
  let apptForQueue: string;

  const createStaff = async (opts: {
    roleSlug: string;
    title: string;
    isAvailableForBooking?: boolean;
  }) => {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/staff/from-new-user`)
      .set(...authHeader(owner.token))
      .send({
        email: `${opts.roleSlug}-${randomUUID().slice(0, 8)}@example.test`,
        fullName: `Test ${opts.roleSlug}`,
        roleSlug: opts.roleSlug,
        title: opts.title,
        isAvailableForBooking: opts.isAvailableForBooking,
      })
      .expect(201);
    return res.body as {
      profile: {
        id: string;
        is_available_for_booking: boolean;
        user: { id: string };
        role?: { slug: string };
      };
    };
  };

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 't3-owner');
    owner2 = await createOwnerFixture(e2e, 't3-foreign');

    const tenants = e2e.dataSource.getRepository(Tenant);
    const tenant = await tenants.findOneByOrFail({ id: owner.tenantId });
    tenantSlug = tenant.slug;

    await e2e.dataSource.getRepository(TenantSetting).save(
      e2e.dataSource.getRepository(TenantSetting).create({
        tenant: { id: owner.tenantId } as Tenant,
        public_booking_enabled: true,
        payment_required: false,
      }),
    );

    const branch = await e2e.dataSource.getRepository(Branch).save(
      e2e.dataSource.getRepository(Branch).create({
        tenant: { id: owner.tenantId } as any,
        name: `T3 Branch ${randomUUID().slice(0, 6)}`,
        is_active: true,
      }),
    );
    branchId = branch.id;

    // ── Nurse: created with isAvailableForBooking forged to true — proves
    // the write-time invariant (Phase 1 item 5) at the very entry point. ──
    const nurse = await createStaff({
      roleSlug: ROLE.NURSE,
      title: 'Staff Nurse',
      isAvailableForBooking: true,
    });
    nurseStaffId = nurse.profile.id;
    nurseUserId = nurse.profile.user.id;
    nurseToken = await mintTokenFor(e2e, nurseUserId, owner.tenantId);

    const doctor = await createStaff({
      roleSlug: ROLE.DOCTOR,
      title: 'General Practitioner',
      isAvailableForBooking: true,
    });
    doctorStaffId = doctor.profile.id;
    doctorUserId = doctor.profile.user.id;
    doctorToken = await mintTokenFor(e2e, doctorUserId, owner.tenantId);

    // A real working schedule for BOTH at the branch — so the discovery test
    // below proves the flag (not the absence of a schedule) is what hides
    // the nurse.
    const schedules = e2e.dataSource.getRepository(StaffSchedule);
    for (const staffId of [nurseStaffId, doctorStaffId]) {
      for (let day = 0; day < 7; day += 1) {
        await schedules.save(
          schedules.create({
            tenant: { id: owner.tenantId } as any,
            staff: { id: staffId } as any,
            branch: { id: branchId } as any,
            day_of_week: day,
            start_time: '08:00:00',
            end_time: '20:00:00',
            is_active: true,
          }),
        );
      }
    }

    const customers = e2e.dataSource.getRepository(Customer);
    const customer = await customers.save(
      customers.create({
        tenant: { id: owner.tenantId } as any,
        full_name: 'T3 Test Patient',
        phone: `+9665${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
        email: `t3-patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    customerId = customer.id;

    const foreignCustomer = await customers.save(
      customers.create({
        tenant: { id: owner2.tenantId } as any,
        full_name: 'T3 Foreign Patient',
        phone: `+9665${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
        email: `t3-foreign-patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    foreignCustomerId = foreignCustomer.id;

    const service = await e2e.dataSource.getRepository(Service).save(
      e2e.dataSource.getRepository(Service).create({
        tenant: { id: owner.tenantId } as any,
        name: 'T3 Consultation',
        public_slug: `t3-consultation-${randomUUID().slice(0, 8)}`,
        duration_minutes: 30,
        base_price: 200,
        pricing_type: PricingType.FIXED,
        is_active: true,
      }),
    );
    serviceId = service.id;

    const appointments = e2e.dataSource.getRepository(Appointment);
    const baseAppt = {
      tenant: { id: owner.tenantId } as any,
      branch: { id: branchId } as any,
      customer: { id: customerId } as any,
      staff: { id: doctorStaffId } as any,
      status: AppointmentStatus.CONFIRMED,
      payment_status: AppointmentPaymentStatus.PAID,
      total_amount: 200,
      currency: 'SAR',
      source: AppointmentSource.MANUAL,
    };

    const financial = await appointments.save(
      appointments.create({
        ...baseAppt,
        start_at: new Date('2027-02-01T10:00:00Z'),
        end_at: new Date('2027-02-01T10:30:00Z'),
      }),
    );
    apptFinancial = financial.id;
    await e2e.dataSource.getRepository(AppointmentServiceLine).save(
      e2e.dataSource.getRepository(AppointmentServiceLine).create({
        tenant: { id: owner.tenantId } as any,
        appointment: { id: apptFinancial } as any,
        service: { id: serviceId } as any,
        price: 200,
        duration_minutes: 30,
      }),
    );

    const forStatus = await appointments.save(
      appointments.create({
        ...baseAppt,
        start_at: new Date('2027-02-02T10:00:00Z'),
        end_at: new Date('2027-02-02T10:30:00Z'),
      }),
    );
    apptForStatus = forStatus.id;

    const forQueue = await appointments.save(
      appointments.create({
        ...baseAppt,
        start_at: new Date('2027-02-03T10:00:00Z'),
        end_at: new Date('2027-02-03T10:30:00Z'),
      }),
    );
    apptForQueue = forQueue.id;
  }, 120_000);

  afterAll(async () => {
    const q1 = (sql: string) => e2e.dataSource.query(sql, [owner.tenantId]);
    const q2 = (sql: string) => e2e.dataSource.query(sql, [owner2.tenantId]);
    for (const q of [q1, q2]) {
      await q(`DELETE FROM clinical_access_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM clinical_entry_revisions WHERE "tenantId" = $1`);
      await q(`DELETE FROM clinical_entries WHERE "tenantId" = $1`);
      await q(`DELETE FROM clinical_encounters WHERE "tenantId" = $1`);
      await q(`DELETE FROM queue_entries WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
      await q(`DELETE FROM services WHERE "tenantId" = $1`);
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
  }, 60_000);

  // ────────────────────────────── /auth/me ──────────────────────────────── //

  describe('/auth/me — exact permission set', () => {
    it("the nurse's live permission set is exactly ROLE_PERMISSIONS['nurse']", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/auth/me`)
        .set(...authHeader(nurseToken))
        .expect(200);
      expect(new Set(res.body.permissions)).toEqual(
        new Set(ROLE_PERMISSIONS[ROLE.NURSE]),
      );
      expect(res.body.roles).toEqual([ROLE.NURSE]);
    });
  });

  // ─────────────────────────── Public booking ───────────────────────────── //

  describe('Public booking — a nurse is never a bookable provider', () => {
    it('is stored as NOT bookable even though the create request forged isAvailableForBooking: true', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/${nurseStaffId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.is_available_for_booking).toBe(false);
    });

    it('GET /public/discovery/doctors — the nurse never appears, the doctor does (both hold a real working schedule at the branch)', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/doctors`)
        .query({ clinicSlug: tenantSlug, pageSize: 24 })
        .expect(200);
      const ids = (res.body.items as Array<{ id: string }>).map((d) => d.id);
      expect(ids).toContain(doctorStaffId);
      expect(ids).not.toContain(nurseStaffId);
    });

    it('POST /staff/:id/activate on the nurse is refused (422) — activation would make it bookable', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/staff/${nurseStaffId}/activate`)
        .set(...authHeader(owner.token))
        .expect(422);
      expect(res.body.code).toBe('UNPROCESSABLE_ENTITY');
    });

    it('converting a bookable doctor to nurse flips isAvailableForBooking off, even without asking', async () => {
      const promoted = await createStaff({
        roleSlug: ROLE.DOCTOR,
        title: 'To Be Converted',
        isAvailableForBooking: true,
      });
      expect(promoted.profile.is_available_for_booking).toBe(true);

      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/staff/${promoted.profile.id}`)
        .set(...authHeader(owner.token))
        .send({ roleSlug: ROLE.NURSE })
        .expect(200);
      expect(res.body.is_available_for_booking).toBe(false);
      expect(res.body.role?.slug).toBe(ROLE.NURSE);
    });
  });

  // ────────────────────────────── Appointments ──────────────────────────── //

  describe('Appointments — read yes, financial fields redacted, writes (beyond status) refused', () => {
    it('GET /appointments — 200, list includes the appointment but strips every financial field', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .set(...authHeader(nurseToken))
        .expect(200);
      const row = (res.body.data as Array<Record<string, unknown>>).find(
        (a) => a.id === apptFinancial,
      );
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('total_amount');
      expect(row).not.toHaveProperty('payment_status');
      expect(row).not.toHaveProperty('currency');
    });

    it('GET /appointments/:id — 200, financial fields (incl. nested service price) absent', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${apptFinancial}`)
        .set(...authHeader(nurseToken))
        .expect(200);
      expect(res.body).not.toHaveProperty('total_amount');
      expect(res.body).not.toHaveProperty('payment_status');
      expect(res.body).not.toHaveProperty('currency');
      expect(res.body.services?.[0]).not.toHaveProperty('price');
      expect(res.body.services?.[0]?.service).not.toHaveProperty('base_price');
      expect(res.body.services?.[0]?.service).not.toHaveProperty(
        'pricing_type',
      );
      // Non-financial fields survive.
      expect(res.body.id).toBe(apptFinancial);
    });

    it('the SAME appointment, read by the owner (full appointments.update), still shows every financial field — no regression', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${apptFinancial}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.total_amount).toBeDefined();
      expect(res.body.payment_status).toBe(AppointmentPaymentStatus.PAID);
      expect(res.body.services[0].price).toBeDefined();
    });

    it("the SAME appointment, read by the real receptionist role, also still shows financial fields", async () => {
      const receptionist = await mintTokenForSystemRole(
        e2e,
        owner.tenantId,
        ROLE.RECEPTIONIST,
        'reception-fin',
      );
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${apptFinancial}`)
        .set(...authHeader(receptionist.token))
        .expect(200);
      expect(res.body.total_amount).toBeDefined();
      expect(res.body.payment_status).toBe(AppointmentPaymentStatus.PAID);
    });

    it('GET /appointments/:id/notes and /timeline — 200 (appointments.read grants both)', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);
      const notes = await request(server)
        .get(`${API}/appointments/${apptFinancial}/notes`)
        .set(...auth);
      expect(notes.status).toBe(200);
      const timeline = await request(server)
        .get(`${API}/appointments/${apptFinancial}/timeline`)
        .set(...auth);
      expect(timeline.status).toBe(200);
    });

    it('every appointment WRITE beyond status is refused (create/update/services/notes/cancel/reschedule/delete)', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);

      const checks = await Promise.all([
        request(server)
          .post(`${API}/appointments`)
          .set(...auth)
          .send({}),
        request(server)
          .patch(`${API}/appointments/${apptFinancial}`)
          .set(...auth)
          .send({}),
        request(server)
          .put(`${API}/appointments/${apptFinancial}/services`)
          .set(...auth)
          .send({ serviceIds: [serviceId] }),
        request(server)
          .post(`${API}/appointments/${apptFinancial}/notes`)
          .set(...auth)
          .send({ text: 'nope' }),
        request(server)
          .post(`${API}/appointments/${apptFinancial}/cancel`)
          .set(...auth)
          .send({}),
        request(server)
          .post(`${API}/appointments/${apptFinancial}/reschedule`)
          .set(...auth)
          .send({}),
        request(server).delete(`${API}/appointments/${apptFinancial}`).set(...auth),
      ]);
      for (const res of checks) expect(res.status).toBe(403);
    });

    it('POST /appointments/:id/status — 200, legal transition succeeds and the response is still redacted', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/appointments/${apptForStatus}/status`)
        .set(...authHeader(nurseToken))
        .send({ status: AppointmentStatus.IN_PROGRESS })
        .expect(200);
      expect(res.body.status).toBe(AppointmentStatus.IN_PROGRESS);
      expect(res.body).not.toHaveProperty('total_amount');
      expect(res.body).not.toHaveProperty('payment_status');
    });
  });

  // ──────────────────────────────── Queue ───────────────────────────────── //

  describe('Queue — full lifecycle via appointments.status.update, no paymentStatus leak', () => {
    let entryId: string;

    it('POST /queue/check-in — 201, no appointment.paymentStatus in the response', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/queue/check-in`)
        .set(...authHeader(nurseToken))
        .send({ appointmentId: apptForQueue })
        .expect(201);
      entryId = res.body.id;
      expect(res.body.appointment).not.toHaveProperty('paymentStatus');
    });

    it('GET /queue — 200, list entries never carry paymentStatus for the nurse', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/queue`)
        .query({ branchId })
        .set(...authHeader(nurseToken))
        .expect(200);
      for (const entry of res.body.data as Array<Record<string, any>>) {
        expect(entry.appointment).not.toHaveProperty('paymentStatus');
      }
    });

    it('call -> start -> complete — every step 200, still redacted', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);

      const call = await request(server)
        .post(`${API}/queue/${entryId}/call`)
        .set(...auth)
        .send();
      expect(call.status).toBe(200);
      expect(call.body.appointment).not.toHaveProperty('paymentStatus');

      const start = await request(server)
        .post(`${API}/queue/${entryId}/start`)
        .set(...auth)
        .send();
      expect(start.status).toBe(200);

      const complete = await request(server)
        .post(`${API}/queue/${entryId}/complete`)
        .set(...auth)
        .send();
      expect(complete.status).toBe(200);
      expect(complete.body.appointment).not.toHaveProperty('paymentStatus');
    });
  });

  // ───────────────────────────────── CRM ────────────────────────────────── //

  describe('CRM — read-only (D3): customers/notes/tags/files readable, every write refused', () => {
    it('customers: GET list + GET :id succeed, POST/PATCH refused', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);

      const list = await request(server).get(`${API}/crm/customers`).set(...auth);
      expect(list.status).toBe(200);
      const detail = await request(server)
        .get(`${API}/crm/customers/${customerId}`)
        .set(...auth);
      expect(detail.status).toBe(200);

      const create = await request(server)
        .post(`${API}/crm/customers`)
        .set(...auth)
        .send({ fullName: 'Should be refused' });
      expect(create.status).toBe(403);
      const update = await request(server)
        .patch(`${API}/crm/customers/${customerId}`)
        .set(...auth)
        .send({ fullName: 'Should be refused' });
      expect(update.status).toBe(403);
    });

    it('notes: GET succeeds, POST refused', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);
      const read = await request(server)
        .get(`${API}/crm/customers/${customerId}/notes`)
        .set(...auth);
      expect(read.status).toBe(200);
      const write = await request(server)
        .post(`${API}/crm/customers/${customerId}/notes`)
        .set(...auth)
        .send({ content: 'nope' });
      expect(write.status).toBe(403);
    });

    it('tags: GET succeeds, POST refused', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);
      const read = await request(server)
        .get(`${API}/crm/customers/${customerId}/tags`)
        .set(...auth);
      expect(read.status).toBe(200);
      const write = await request(server)
        .post(`${API}/crm/customers/${customerId}/tags`)
        .set(...auth)
        .send({ tagId: randomUUID() });
      expect(write.status).toBe(403);
    });

    it('files (D3 — read-only in v1): GET succeeds, POST + DELETE refused', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);
      const read = await request(server)
        .get(`${API}/crm/customers/${customerId}/files`)
        .set(...auth);
      expect(read.status).toBe(200);
      const upload = await request(server)
        .post(`${API}/crm/customers/${customerId}/files`)
        .set(...auth)
        .send({});
      expect(upload.status).toBe(403);
      const remove = await request(server)
        .delete(`${API}/crm/customers/${customerId}/files/${randomUUID()}`)
        .set(...auth);
      expect(remove.status).toBe(403);
    });
  });

  // ─────────────────────────────── Clinical ─────────────────────────────── //

  describe('Clinical (D4) — NOTE/VITALS create, own-only correct, no diagnosis/medication/allergy/delete', () => {
    let ownNoteId: string;
    let ownNoteVersion: number;
    let doctorNoteId: string;

    it('GET timeline/summary — 200, and a timeline read writes a clinical_access_logs row', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);

      const before = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM clinical_access_logs WHERE "customerId" = $1`,
        [customerId],
      );
      const timeline = await request(server)
        .get(`${API}/clinical/patients/${customerId}/timeline`)
        .set(...auth);
      expect(timeline.status).toBe(200);
      const summary = await request(server)
        .get(`${API}/clinical/patients/${customerId}/summary`)
        .set(...auth);
      expect(summary.status).toBe(200);
      const after = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM clinical_access_logs WHERE "customerId" = $1`,
        [customerId],
      );
      expect(after[0].c).toBeGreaterThan(before[0].c);
    });

    it('creates a NOTE — 201', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/clinical/patients/${customerId}/entries`)
        .set(...authHeader(nurseToken))
        .send({ kind: ClinicalEntryKind.NOTE, data: { text: 'BP checked, stable.' } })
        .expect(201);
      ownNoteId = res.body.id;
      ownNoteVersion = res.body.version;
    });

    it('creates a VITALS entry — 201', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/clinical/patients/${customerId}/entries`)
        .set(...authHeader(nurseToken))
        .send({
          kind: ClinicalEntryKind.VITALS,
          data: { heartRate: 72, systolic: 118, diastolic: 76 },
        })
        .expect(201);
    });

    it('DIAGNOSIS / MEDICATION / ALLERGY creation are all refused (403)', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);
      const attempts = await Promise.all([
        request(server)
          .post(`${API}/clinical/patients/${customerId}/entries`)
          .set(...auth)
          .send({
            kind: ClinicalEntryKind.DIAGNOSIS,
            data: { label: 'Hypertension', status: 'ACTIVE' },
          }),
        request(server)
          .post(`${API}/clinical/patients/${customerId}/entries`)
          .set(...auth)
          .send({
            kind: ClinicalEntryKind.MEDICATION,
            data: { name: 'Lisinopril', active: true },
          }),
        request(server)
          .post(`${API}/clinical/patients/${customerId}/entries`)
          .set(...auth)
          .send({
            kind: ClinicalEntryKind.ALLERGY,
            data: { substance: 'Penicillin', severity: 'SEVERE' },
          }),
      ]);
      for (const res of attempts) expect(res.status).toBe(403);
    });

    it('corrects their OWN NOTE — 200', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/clinical/entries/${ownNoteId}`)
        .set(...authHeader(nurseToken))
        .send({ version: ownNoteVersion, data: { text: 'BP re-checked, stable.' } })
        .expect(200);
      expect(res.body.data.text).toBe('BP re-checked, stable.');
    });

    it("cannot correct the DOCTOR's NOTE (not their own entry) — 403", async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/clinical/patients/${customerId}/entries`)
        .set(...authHeader(doctorToken))
        .send({ kind: ClinicalEntryKind.NOTE, data: { text: "Doctor's own note." } })
        .expect(201);
      doctorNoteId = created.body.id;

      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/clinical/entries/${doctorNoteId}`)
        .set(...authHeader(nurseToken))
        .send({ version: created.body.version, data: { text: 'tampered' } })
        .expect(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it('DELETE any entry is refused (403) — clinical.records.manage only', async () => {
      await request(e2e.app.getHttpServer())
        .delete(`${API}/clinical/entries/${ownNoteId}`)
        .set(...authHeader(nurseToken))
        .expect(403);
    });

    it("a foreign tenant's customer: the timeline never leaks their data (tenant-filtered to empty, not another tenant's rows), and entry-create is a 404 (Phase 1's assertBelongsToTenant hardening)", async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);

      // getTimeline filters clinical rows by THIS tenantId, so a customer id
      // that belongs to another tenant simply matches nothing — 200 with an
      // empty page, never another tenant's content. (It does not 404,
      // because the route never existed to look the customer up by id in
      // the first place — unlike encounter/entry lookups, which do.)
      const timeline = await request(server)
        .get(`${API}/clinical/patients/${foreignCustomerId}/timeline`)
        .set(...auth);
      expect(timeline.status).toBe(200);
      expect(timeline.body.data).toHaveLength(0);

      const create = await request(server)
        .post(`${API}/clinical/patients/${foreignCustomerId}/entries`)
        .set(...auth)
        .send({ kind: ClinicalEntryKind.NOTE, data: { text: 'x' } });
      expect(create.status).toBe(404);
    });
  });

  // ───────────────── Finance / billing / analytics / settings / etc. ─────── //

  describe('Everything else the plan says a nurse must never reach', () => {
    it('finance/billing/analytics/services/roles/staff/activity all 403', async () => {
      const server = e2e.app.getHttpServer();
      const auth = authHeader(nurseToken);

      const checks = await Promise.all([
        request(server).get(`${API}/analytics/dashboard`).set(...auth),
        request(server).get(`${API}/billing/invoices`).set(...auth),
        request(server).get(`${API}/services`).set(...auth),
        request(server).get(`${API}/roles`).set(...auth),
        request(server).get(`${API}/staff`).set(...auth),
        request(server).get(`${API}/activity`).set(...auth),
      ]);
      for (const res of checks) expect(res.status).toBe(403);
    });
  });

  // ────────────────────── Staff-access regression ───────────────────────── //

  describe('StaffAccessService regression — nurse creation/update never becomes receptionist', () => {
    it('after creation and a profile update, the staff row is STILL role "nurse"', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/staff/${nurseStaffId}`)
        .set(...authHeader(owner.token))
        .send({ bio: 'Updated bio, no role change requested.' })
        .expect(200);
      expect(res.body.role?.slug).toBe(ROLE.NURSE);

      const fetched = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/${nurseStaffId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(fetched.body.role?.slug).toBe(ROLE.NURSE);
    });
  });
});
