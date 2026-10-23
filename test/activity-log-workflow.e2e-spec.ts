/**
 * The workflow the clinic-wide Activity log exists for, proven end-to-end
 * over real HTTP against the real `AppModule`:
 *
 *   receptionist signs in → creates an appointment
 *     → the owner opens Activity → `appointment.created` is there
 *     → the ACTOR is the receptionist (not the customer, not the owner)
 *     → searching the receptionist's name finds it
 *     → searching "appoint" finds it
 *     → another tenant's owner can find NONE of it, in the list OR in the
 *       typeahead suggestions.
 *
 * This is the regression that motivated the whole change: the appointment
 * write path recorded to `appointment_history`/`appointment_status_logs` and
 * NOTHING to `audit_logs`, so the single most common action in a clinic was
 * invisible to its owner. A unit test cannot prove it — the defect lived in
 * the seam between a service that did not call the audit writer and an
 * allow-list that would not have surfaced it either way.
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

import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Customer } from '../src/entities/CRM/Customer';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { WorkingHour } from '../src/entities/Staff/WorkingHour';
import { Service } from '../src/entities/Services/Service';

const API = '/api/v1';

/** Far-future Wednesday, UTC branch — no collision with any other suite. */
const DAY = '2031-03-05';
const WEDNESDAY = 3;

interface ClinicFixture {
  owner: OwnerFixture;
  receptionistUserId: string;
  receptionistToken: string;
  receptionistName: string;
  branchId: string;
  staffId: string;
  serviceId: string;
  customerId: string;
}

describe('Activity Log — receptionist → owner workflow (HTTP e2e)', () => {
  let e2e: E2eApp;
  let clinic: ClinicFixture;
  let otherClinic: ClinicFixture;

  /**
   * A tenant with everything a real booking needs: a branch with working
   * hours, a bookable doctor on the schedule, a service, a customer, and a
   * receptionist who holds the pre-seeded system `receptionist` role (which
   * carries `appointments.create` but NOT `audit.read` — the split the whole
   * scenario turns on).
   */
  async function createClinic(label: string): Promise<ClinicFixture> {
    const ds = e2e.dataSource;
    const owner = await createOwnerFixture(e2e, label);
    const tenantId = owner.tenantId;
    const suffix = randomUUID().slice(0, 8);

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: `Activity Branch ${suffix}`,
        timezone: 'UTC',
        is_active: true,
      }),
    );

    const receptionistName = `Ahmed Mohamed ${suffix}`;
    const receptionist = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `reception-${suffix}@example.test`,
        full_name: receptionistName,
        is_active: true,
      }),
    );
    // The SYSTEM role (tenant IS NULL), never a tenant's own custom role of
    // the same slug — same reasoning as `createOwnerFixture`.
    const receptionRole = await ds
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: 'receptionist' })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!receptionRole) {
      throw new Error(
        'Seeded system role "receptionist" not found — run the RBAC seed against the test database first.',
      );
    }
    await ds.getRepository(UserRole).save(
      ds.getRepository(UserRole).create({
        user: { id: receptionist.id } as User,
        role: { id: receptionRole.id } as Role,
      }),
    );
    const receptionistToken = await e2e.jwt.signAsync(
      { sub: receptionist.id, tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );

    const doctorUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `doctor-${suffix}@example.test`,
        full_name: `Dr Activity ${suffix}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        public_slug: `stf-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: tenantId } as Tenant,
        user: { id: doctorUser.id } as User,
        title: 'Dentist',
        is_available_for_booking: true,
      }),
    );

    await ds.getRepository(WorkingHour).save(
      ds.getRepository(WorkingHour).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        day_of_week: WEDNESDAY,
        start_time: '08:00',
        end_time: '20:00',
        is_closed: false,
      }),
    );
    await ds.getRepository(StaffSchedule).save(
      ds.getRepository(StaffSchedule).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branch.id } as Branch,
        staff: { id: staff.id } as StaffProfile,
        day_of_week: WEDNESDAY,
        start_time: '08:00',
        end_time: '20:00',
        is_active: true,
      }),
    );

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: tenantId } as Tenant,
        name: `Dental cleaning ${suffix}`,
        duration_minutes: 60,
        base_price: 150,
        is_active: true,
      }),
    );

    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: tenantId } as Tenant,
        full_name: `Patient ${suffix}`,
        email: `patient-${suffix}@example.test`,
        phone: `+9665${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        is_active: true,
      }),
    );

    return {
      owner,
      receptionistUserId: receptionist.id,
      receptionistToken,
      receptionistName,
      branchId: branch.id,
      staffId: staff.id,
      serviceId: service.id,
      customerId: customer.id,
    };
  }

  /** Books through the REAL endpoint, as the receptionist. */
  async function bookAs(fixture: ClinicFixture, hour: string) {
    return request(e2e.app.getHttpServer())
      .post(`${API}/appointments`)
      .set(...authHeader(fixture.receptionistToken))
      .send({
        branchId: fixture.branchId,
        customerId: fixture.customerId,
        staffId: fixture.staffId,
        serviceIds: [fixture.serviceId],
        startAt: `${DAY}T${hour}:00:00.000Z`,
      });
  }

  const activityAs = (token: string, query: Record<string, unknown> = {}) =>
    request(e2e.app.getHttpServer())
      .get(`${API}/activity`)
      .query(query)
      .set(...authHeader(token));

  const suggestionsAs = (token: string, q: string) =>
    request(e2e.app.getHttpServer())
      .get(`${API}/activity/suggestions`)
      .query({ q })
      .set(...authHeader(token));

  beforeAll(async () => {
    e2e = await createE2eApp();
    clinic = await createClinic('activity-flow');
    otherClinic = await createClinic('activity-flow-other');

    // The action under test, performed for real by the receptionist.
    const booked = await bookAs(clinic, '09');
    expect(booked.status).toBe(201);
    // And one in the OTHER tenant, so every isolation assertion below has a
    // real row it could wrongly leak rather than an empty set that proves
    // nothing.
    const otherBooked = await bookAs(otherClinic, '09');
    expect(otherBooked.status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    for (const fixture of [clinic, otherClinic]) {
      if (!fixture) continue;
      const q = (sql: string) =>
        e2e.dataSource.query(sql, [fixture.owner.tenantId]);
      // This suite books real appointments, and `cleanupTenant` deletes
      // `customers` without first clearing the appointment graph that FKs to
      // them — so the appointment children go first, here.
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_notes WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_cancellations WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_reschedules WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`);
      await q(`DELETE FROM working_hours WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
      await q(`DELETE FROM services WHERE "tenantId" = $1`);
      await cleanupTenant(e2e, fixture.owner.tenantId);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`);
    }
    await e2e.app.close();
  }, 120_000);

  describe('the reported bug: a receptionist books, the owner sees it', () => {
    it('records appointment.created and shows it to the owner', async () => {
      const res = await activityAs(clinic.owner.token);

      expect(res.status).toBe(200);
      const created = res.body.data.filter(
        (r: { action: string }) => r.action === 'appointment.created',
      );
      expect(created).toHaveLength(1);
      expect(created[0].entityType).toBe('Appointment');
    });

    it('attributes it to the RECEPTIONIST — not the owner, and not the customer', async () => {
      const res = await activityAs(clinic.owner.token, {
        action: 'appointment.created',
      });

      const row = res.body.data[0];
      expect(row.actor.id).toBe(clinic.receptionistUserId);
      expect(row.actor.name).toBe(clinic.receptionistName);
      expect(row.actor.id).not.toBe(clinic.owner.userId);
      expect(row.isSystem).toBe(false);
      expect(row.actor.isDeleted).toBe(false);
      // The role is resolved so the owner can read "who" without a second page.
      expect(row.actor.role?.slug).toBe('receptionist');
    });

    it('carries the branch and a non-sensitive resource label — never the patient', async () => {
      const res = await activityAs(clinic.owner.token, {
        action: 'appointment.created',
      });

      const row = res.body.data[0];
      expect(row.branch?.id).toBe(clinic.branchId);
      expect(row.entityLabel).toContain('Dental cleaning');
      // No patient name, phone or clinical value may reach this surface.
      expect(JSON.stringify(row)).not.toContain('Patient ');
      expect(JSON.stringify(row)).not.toContain('+9665');
    });

    it('never returns a raw before/after VALUE, only changed field names (FR-U008)', async () => {
      const res = await activityAs(clinic.owner.token);

      for (const row of res.body.data) {
        expect(row).not.toHaveProperty('oldValues');
        expect(row).not.toHaveProperty('newValues');
        expect(Array.isArray(row.changedFields)).toBe(true);
      }
    });

    it('a receptionist cannot read the activity log at all (audit.read is owner/manager only)', async () => {
      const res = await activityAs(clinic.receptionistToken);
      expect(res.status).toBe(403);
    });
  });

  describe('search', () => {
    it('finds it by a PARTIAL actor name — "Ah" matches "Ahmed …"', async () => {
      const res = await activityAs(clinic.owner.token, { q: 'Ah' });

      expect(res.status).toBe(200);
      expect(
        res.body.data.some(
          (r: { action: string }) => r.action === 'appointment.created',
        ),
      ).toBe(true);
    });

    it('finds it by the full actor name', async () => {
      const res = await activityAs(clinic.owner.token, {
        q: clinic.receptionistName,
      });

      expect(res.body.total).toBeGreaterThan(0);
    });

    it('finds it by a partial ACTION — "appoint" matches "appointment.created"', async () => {
      const res = await activityAs(clinic.owner.token, { q: 'appoint' });

      expect(
        res.body.data.some(
          (r: { action: string }) => r.action === 'appointment.created',
        ),
      ).toBe(true);
    });

    it('is case-insensitive', async () => {
      const lower = await activityAs(clinic.owner.token, { q: 'appoint' });
      const upper = await activityAs(clinic.owner.token, { q: 'APPOINT' });

      expect(upper.body.total).toBe(lower.body.total);
      expect(upper.body.total).toBeGreaterThan(0);
    });

    it('finds it by the entity label', async () => {
      const res = await activityAs(clinic.owner.token, { q: 'Dental' });

      expect(res.body.total).toBeGreaterThan(0);
    });

    it('finds it by the actor email', async () => {
      const res = await activityAs(clinic.owner.token, { q: 'reception-' });

      expect(res.body.total).toBeGreaterThan(0);
    });

    it('a LIKE metacharacter is escaped, not interpreted — "%" matches nothing', async () => {
      const all = await activityAs(clinic.owner.token);
      const wildcard = await activityAs(clinic.owner.token, { q: '%%' });

      expect(all.body.total).toBeGreaterThan(0);
      expect(wildcard.body.total).toBe(0);
    });

    it('a term below the minimum length is ignored, not rejected', async () => {
      const res = await activityAs(clinic.owner.token, { q: 'a' });

      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThan(0); // unfiltered, not an error
    });

    it('a non-matching term returns an empty page, not an error', async () => {
      const res = await activityAs(clinic.owner.token, { q: 'zzzznotathing' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it('an Arabic term is accepted and matched, not mangled', async () => {
      const res = await activityAs(clinic.owner.token, { q: 'أحمد' });

      // No row happens to contain it, but the query must run cleanly and
      // report an honest empty result rather than 500.
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    it('`total` agrees with the searched page — the count joins the same tables', async () => {
      const res = await activityAs(clinic.owner.token, {
        q: 'appoint',
        limit: 100,
      });

      expect(res.body.total).toBe(res.body.data.length);
    });
  });

  describe('filters and pagination', () => {
    it('the action filter narrows to exactly that action', async () => {
      const res = await activityAs(clinic.owner.token, {
        action: 'appointment.created',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(row.action).toBe('appointment.created');
      }
    });

    it('the actor filter narrows to that person', async () => {
      const res = await activityAs(clinic.owner.token, {
        actorUserId: clinic.receptionistUserId,
      });

      expect(res.body.data.length).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(row.actor.id).toBe(clinic.receptionistUserId);
      }
    });

    it('the branch filter narrows to that branch', async () => {
      const res = await activityAs(clinic.owner.token, {
        branchId: clinic.branchId,
      });

      expect(res.body.data.length).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(row.branch?.id).toBe(clinic.branchId);
      }
    });

    it('search and the action filter compose', async () => {
      const res = await activityAs(clinic.owner.token, {
        q: 'appoint',
        action: 'appointment.created',
      });

      expect(res.status).toBe(200);
      for (const row of res.body.data) {
        expect(row.action).toBe('appointment.created');
      }
    });

    it('pagination stays correct under a search: page 2 of a 1-per-page search is empty but valid', async () => {
      const first = await activityAs(clinic.owner.token, {
        q: 'appoint',
        limit: 1,
        page: 1,
      });
      const second = await activityAs(clinic.owner.token, {
        q: 'appoint',
        limit: 1,
        page: 2,
      });

      expect(first.body.data).toHaveLength(1);
      expect(first.body.page).toBe(1);
      expect(second.body.page).toBe(2);
      expect(second.body.total).toBe(first.body.total);
      // Same total, no overlap — the offset actually moved.
      if (second.body.data.length > 0) {
        expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
      }
    });
  });

  describe('suggestions', () => {
    it('suggests the actor by a partial name', async () => {
      const res = await suggestionsAs(clinic.owner.token, 'Ah');

      expect(res.status).toBe(200);
      expect(
        res.body.data.some((s: { value: string }) =>
          s.value.startsWith('Ahmed Mohamed'),
        ),
      ).toBe(true);
    });

    it('suggests actions by a partial term', async () => {
      const res = await suggestionsAs(clinic.owner.token, 'appoint');

      expect(
        res.body.data.some(
          (s: { value: string }) => s.value === 'appointment.created',
        ),
      ).toBe(true);
    });

    it('returns a bounded list', async () => {
      const res = await suggestionsAs(clinic.owner.token, 'a');
      expect(res.body.data).toEqual([]); // below the minimum

      const real = await suggestionsAs(clinic.owner.token, 'ap');
      expect(real.body.data.length).toBeLessThanOrEqual(8);
    });

    it('a receptionist cannot read suggestions either', async () => {
      const res = await suggestionsAs(clinic.receptionistToken, 'Ah');
      expect(res.status).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it("the other tenant's owner sees their OWN booking and never this one", async () => {
      const mine = await activityAs(clinic.owner.token, {
        action: 'appointment.created',
      });
      const theirs = await activityAs(otherClinic.owner.token, {
        action: 'appointment.created',
      });

      const myIds = mine.body.data.map((r: { id: string }) => r.id);
      const theirIds = theirs.body.data.map((r: { id: string }) => r.id);

      expect(myIds.length).toBeGreaterThan(0);
      expect(theirIds.length).toBeGreaterThan(0);
      expect(theirIds).not.toEqual(expect.arrayContaining(myIds));
    });

    it("searching the OTHER tenant's receptionist name from here finds nothing", async () => {
      const res = await activityAs(clinic.owner.token, {
        q: otherClinic.receptionistName,
      });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    it("suggestions never leak another tenant's people", async () => {
      const res = await suggestionsAs(
        clinic.owner.token,
        otherClinic.receptionistName.slice(0, 10),
      );

      expect(res.status).toBe(200);
      const values = res.body.data.map((s: { value: string }) => s.value);
      expect(values).not.toContain(otherClinic.receptionistName);
    });

    it("the actor filter cannot be pointed at another tenant's user", async () => {
      const res = await activityAs(clinic.owner.token, {
        actorUserId: otherClinic.receptionistUserId,
      });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    it("the branch filter cannot be pointed at another tenant's branch", async () => {
      const res = await activityAs(clinic.owner.token, {
        branchId: otherClinic.branchId,
      });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });
  });

  describe('the rest of the appointment lifecycle', () => {
    it('records appointment.status_changed with the previous status among the changed fields', async () => {
      const booked = await bookAs(clinic, '11');
      expect(booked.status).toBe(201);

      // The lifecycle state machine only allows certain transitions, and the
      // status a new booking lands in depends on whether an online payment is
      // due — so the target is derived from the ACTUAL status rather than
      // assumed, which is what makes this assert the audit trail and not the
      // booking rules.
      const target =
        booked.body.status === 'PENDING_PAYMENT' ? 'CONFIRMED' : 'IN_PROGRESS';
      const changed = await request(e2e.app.getHttpServer())
        .post(`${API}/appointments/${booked.body.id}/status`)
        .set(...authHeader(clinic.receptionistToken))
        .send({ status: target });
      expect([200, 201]).toContain(changed.status);

      const res = await activityAs(clinic.owner.token, {
        action: 'appointment.status_changed',
      });
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].changedFields).toContain('status');
    });

    it('records appointment.cancelled for a staff cancellation', async () => {
      const booked = await bookAs(clinic, '13');
      expect(booked.status).toBe(201);

      const cancelled = await request(e2e.app.getHttpServer())
        .post(`${API}/appointments/${booked.body.id}/cancel`)
        .set(...authHeader(clinic.receptionistToken))
        .send({ reason: 'Clinic closed' });
      expect([200, 201]).toContain(cancelled.status);

      const res = await activityAs(clinic.owner.token, {
        action: 'appointment.cancelled',
      });
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].actor.id).toBe(clinic.receptionistUserId);
    });
  });
});
