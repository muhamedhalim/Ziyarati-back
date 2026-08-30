/**
 * Tenant operational settings — read/write/persistence, tenant isolation,
 * authorization, and business-logic wiring, against real Postgres.
 *
 * This is the backend half of the "Booking & operations" settings tab fix:
 * the frontend regression (UI reverting to the pre-save value) is covered by
 * `Ziyarati-font/.../SettingsSections.test.tsx`; this suite proves the API
 * contract that fix relies on (the PATCH response IS the authoritative saved
 * row) and — per the task's own worked example — that toggling a setting
 * through the REAL `PATCH /tenants/me/settings` endpoint (not a direct DB
 * write, unlike the existing `public-booking-flow`/`public-booking-context`
 * e2e-specs) actually changes what a downstream consumer does:
 *
 *   publicBookingEnabled       -> public clinic discovery listing
 *   enforceStaffWorkingHours   -> availability for an unscheduled staff day
 *
 * `bookingConfirmation`, `cancellationHours`, `feedbackDelayMinutes`,
 * `defaultLanguage`, `botEnabled` and `currency` are intentionally NOT given
 * business-logic assertions here — an exhaustive backend grep (recorded in
 * the implementation plan) found no consumer for any of them; wiring them up
 * is out of scope for this task and is logged separately, not silently
 * skipped.
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
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';

const API = '/api/v1';
const SUITE = `ts-${randomUUID().slice(0, 8)}`;

describe('Tenant settings — real Postgres', () => {
  let e2e: E2eApp;
  let ownerA: OwnerFixture;
  let ownerB: OwnerFixture;
  let receptionistToken: string;
  let branchId: string;
  let staffId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    ownerA = await createOwnerFixture(e2e, `${SUITE}-a`);
    ownerB = await createOwnerFixture(e2e, `${SUITE}-b`);

    const ds = e2e.dataSource;

    // A branch + a staff member with NO StaffSchedule row — the exact
    // "nothing configured for this day" case `enforceStaffWorkingHours`
    // decides the meaning of.
    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        name: `${SUITE} Main`,
        is_active: true,
        timezone: 'Asia/Riyadh',
      }),
    );
    branchId = branch.id;

    const doctorUser = await ds.getRepository(User).save(
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
        user: { id: doctorUser.id } as User,
        title: 'Consultant',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    // A receptionist principal on tenant A, for the authorization check —
    // same pre-seeded SYSTEM role lookup `createOwnerFixture` uses for
    // 'owner'.
    const receptionistRole = await ds
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: 'receptionist' })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!receptionistRole) {
      throw new Error(
        'Seeded system role "receptionist" not found — run the RBAC seed against the test database first.',
      );
    }
    const receptionistUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        email: `receptionist-${SUITE}@example.test`,
        full_name: `Receptionist ${SUITE}`,
        is_active: true,
      }),
    );
    await ds.getRepository(UserRole).save(
      ds.getRepository(UserRole).create({
        user: { id: receptionistUser.id } as User,
        role: { id: receptionistRole.id } as Role,
      }),
    );
    receptionistToken = await e2e.jwt.signAsync(
      { sub: receptionistUser.id, tenantId: ownerA.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );
  }, 60_000);

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) =>
      e2e.dataSource.query(sql, p).catch(() => undefined);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [
      ownerA.tenantId,
    ]);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [
      ownerA.tenantId,
    ]);
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [
      ownerB.tenantId,
    ]);
    await cleanupTenant(e2e, ownerA.tenantId);
    await cleanupTenant(e2e, ownerB.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ── Read / write / persistence ──────────────────────────────────────── //

  describe('read/write/persistence', () => {
    it('GET lazily creates and returns a default settings row', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(res.body).toMatchObject({
        booking_confirmation: 'AUTO',
        payment_required: true,
        cancellation_hours: 24,
        feedback_delay_minutes: 360,
        default_language: 'ar',
        currency: 'USD',
        bot_enabled: true,
        enforce_staff_working_hours: false,
        public_booking_enabled: false,
        // T011 (spec 014) — fail-closed defaults.
        self_cancellation_enabled: false,
        self_reschedule_enabled: false,
        reminders_enabled: false,
        reminder_lead_minutes: [],
      });
    });

    it('PATCH updates only the supplied fields; the response is the saved row', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ cancellationHours: 48, botEnabled: false })
        .expect(200);

      expect(res.body.cancellation_hours).toBe(48);
      expect(res.body.bot_enabled).toBe(false);
      // Untouched fields keep their prior value — partial update, not a reset.
      expect(res.body.booking_confirmation).toBe('AUTO');
      expect(res.body.default_language).toBe('ar');
    });

    it('the PATCH is durably persisted — a fresh GET reflects it', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(res.body.cancellation_hours).toBe(48);
      expect(res.body.bot_enabled).toBe(false);
    });

    it('T011 (spec 014): PATCH round-trips the self-service/reminder switches', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({
          selfCancellationEnabled: true,
          remindersEnabled: true,
          reminderLeadMinutes: [1440, 60],
        })
        .expect(200);

      expect(res.body.self_cancellation_enabled).toBe(true);
      expect(res.body.self_reschedule_enabled).toBe(false); // untouched
      expect(res.body.reminders_enabled).toBe(true);
      expect(res.body.reminder_lead_minutes).toEqual([1440, 60]);
    });

    it('T011 (spec 014): PATCH rejects a reminder lead time outside the supported set', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ reminderLeadMinutes: [45] })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });
  });

  // ── Tenant isolation / IDOR ─────────────────────────────────────────── //

  describe('tenant isolation', () => {
    it("tenant B's settings are untouched by tenant A's PATCH", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerB.token))
        .expect(200);

      expect(res.body.cancellation_hours).toBe(24);
      expect(res.body.bot_enabled).toBe(true);
    });

    it("tenant B PATCHing its own settings never affects tenant A's row", async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerB.token))
        .send({ cancellationHours: 5 })
        .expect(200);

      const a = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .expect(200);
      expect(a.body.cancellation_hours).toBe(48); // still tenant A's own value

      const b = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerB.token))
        .expect(200);
      expect(b.body.cancellation_hours).toBe(5);
    });
  });

  // ── Authorization ────────────────────────────────────────────────────── //

  describe('authorization', () => {
    it('a receptionist (neither owner nor manager) cannot update settings', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(receptionistToken))
        .send({ botEnabled: true })
        .expect(403);
    });

    it('a receptionist can still read settings (read is any authenticated tenant user)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(receptionistToken))
        .expect(200);
    });
  });

  // ── Business logic: publicBookingEnabled -> public discovery ───────────
  // The task's own worked example: Settings = Disabled -> Save -> Database
  // -> Public Booking/Discovery -> clinic not offered; Enabled -> offered.

  describe('business logic — publicBookingEnabled drives public clinic discovery', () => {
    it('disabled (the default): the clinic is not listed', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/clinics`)
        .query({ q: SUITE })
        .expect(200);
      expect(
        res.body.find((c: { id: string }) => c.id === ownerA.tenantId),
      ).toBeUndefined();
    });

    it('enabling it via the real settings PATCH makes the clinic discoverable', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ publicBookingEnabled: true })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/clinics`)
        .query({ q: SUITE })
        .expect(200);
      expect(
        res.body.find((c: { id: string }) => c.id === ownerA.tenantId),
      ).toBeDefined();
    });

    it('disabling it again via PATCH removes the clinic from discovery', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ publicBookingEnabled: false })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/clinics`)
        .query({ q: SUITE })
        .expect(200);
      expect(
        res.body.find((c: { id: string }) => c.id === ownerA.tenantId),
      ).toBeUndefined();
    });
  });

  // ── Business logic: enforceStaffWorkingHours -> availability ───────────

  describe('business logic — enforceStaffWorkingHours drives staff availability', () => {
    const window = {
      branchId: '',
      staffId: '',
      startTime: '2027-04-12T10:00:00.000Z',
      endTime: '2027-04-12T10:30:00.000Z',
    };

    beforeAll(() => {
      window.branchId = branchId;
      window.staffId = staffId;
    });

    it('off (the default): a staff day with no configured schedule is unconstrained by working hours', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/scheduling/availability/check`)
        .set(...authHeader(ownerA.token))
        .query(window)
        .expect(200);
      expect(res.body.conflicts.outsideAvailability).toBe(false);
    });

    it('turning it on via the real settings PATCH makes the same unscheduled window unbookable', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ enforceStaffWorkingHours: true })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/scheduling/availability/check`)
        .set(...authHeader(ownerA.token))
        .query(window)
        .expect(200);
      expect(res.body.conflicts.outsideAvailability).toBe(true);
      expect(res.body.available).toBe(false);
    });

    it('turning it back off restores the unconstrained default', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ enforceStaffWorkingHours: false })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/scheduling/availability/check`)
        .set(...authHeader(ownerA.token))
        .query(window)
        .expect(200);
      expect(res.body.conflicts.outsideAvailability).toBe(false);
    });
  });
});
