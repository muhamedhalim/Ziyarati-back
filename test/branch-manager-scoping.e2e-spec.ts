/**
 * Branch Manager — server-side branch isolation, proven over real HTTP against
 * real Postgres.
 *
 * THE DEFECT THIS PINS
 * A staff member who runs ONE branch could read and mutate the WHOLE clinic.
 * `branchId` existed on `/appointments`, `/staff` and `/activity` only as a
 * client-supplied FILTER, so omitting it returned everything and supplying a
 * sibling branch's UUID returned that branch. Hiding a nav item does nothing
 * about either. Every assertion below therefore goes through the HTTP layer
 * with a real JWT — never a service call — because the escape being closed is
 * exactly "call the API directly and ignore the UI".
 *
 * THE FIXTURE
 * One tenant, two branches (A and B), one appointment in each, and two
 * principals: the seeded Owner (tenant-wide) and a `branch_manager` assigned
 * to branch A only. Every scoping assertion is made TWICE — once for the
 * Branch Manager (must be narrowed) and once for the Owner (must be
 * unchanged) — because a regression that narrowed everyone would otherwise
 * pass a Branch-Manager-only suite while breaking every clinic in production.
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
import { ROLE, ROLE_PERMISSIONS } from '../src/rbac/rbac.constants';

const API = '/api/v1';

interface Fixture {
  owner: OwnerFixture;
  branchA: string;
  branchB: string;
  /** A `branch_manager` assigned to branch A only. */
  managerToken: string;
  managerUserId: string;
  apptA: string;
  apptB: string;
  staffAUserId: string;
  staffBUserId: string;
  staffAProfileId: string;
  staffBProfileId: string;
  customerId: string;
  serviceId: string;
}

describe('Branch Manager — branch isolation (e2e)', () => {
  let e2e: E2eApp;
  let fx: Fixture;

  beforeAll(async () => {
    e2e = await createE2eApp();
    fx = await seed();
  }, 60_000);

  afterAll(async () => {
    if (fx?.owner) {
      // `cleanupTenant` is the WhatsApp/campaign fixture's cleanup and knows
      // nothing about appointments, branches or staff — this suite is the
      // first to create them. Delete them here, children before parents, so
      // the shared helper's `DELETE FROM customers` does not trip the
      // appointments FK.
      const q = (sql: string) => e2e.dataSource.query(sql, [fx.owner.tenantId]);
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_cancellations WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_reschedules WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointment_notes WHERE "tenantId" = $1`);
      await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`);
      await q(`DELETE FROM queue_entries WHERE "tenantId" = $1`);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_services WHERE "tenantId" = $1`);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
      await q(`DELETE FROM services WHERE "tenantId" = $1`);
      await q(
        `DELETE FROM password_resets WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(`DELETE FROM branch_users WHERE "tenantId" = $1`);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`);
      await cleanupTenant(e2e, fx.owner.tenantId);
    }
    await e2e?.app.close();
  });

  // ─────────────────────────────── Fixture ────────────────────────────────

  async function seed(): Promise<Fixture> {
    const owner = await createOwnerFixture(e2e, 'branchmgr');
    const ds = e2e.dataSource;
    const t = { id: owner.tenantId } as Tenant;

    const branches = ds.getRepository(Branch);
    const branchA = await branches.save(
      branches.create({ tenant: t, name: 'Branch A', timezone: 'UTC' }),
    );
    const branchB = await branches.save(
      branches.create({ tenant: t, name: 'Branch B', timezone: 'UTC' }),
    );

    const role = await resolveBranchManagerRole();

    // The Branch Manager, assigned to branch A only.
    const users = ds.getRepository(User);
    const manager = await users.save(
      users.create({
        tenant: t,
        email: `bm-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'Branch A Manager',
        is_active: true,
      }),
    );
    await ds
      .getRepository(UserRole)
      .save(
        ds
          .getRepository(UserRole)
          .create({ user: { id: manager.id } as User, role }),
      );
    await ds.getRepository(BranchUser).save(
      ds.getRepository(BranchUser).create({
        tenant: t,
        branch: { id: branchA.id } as Branch,
        user: { id: manager.id } as User,
        is_primary: true,
      }),
    );

    const managerToken = await e2e.jwt.signAsync(
      { sub: manager.id, tenantId: owner.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );

    // One bookable staff member per branch, so the staff-list scoping has
    // something to include AND something to exclude.
    const staffA = await makeStaff(t, branchA.id, 'Doctor A');
    const staffB = await makeStaff(t, branchB.id, 'Doctor B');

    const customers = ds.getRepository(Customer);
    const customer = await customers.save(
      customers.create({
        tenant: t,
        full_name: 'Patient',
        phone: '+966500000001',
        // NOT NULL at the DB level, and tenant-scoped unique — hence the
        // per-run suffix.
        email: `patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    const services = ds.getRepository(Service);
    const service = await services.save(
      services.create({
        tenant: t,
        name: 'Consult',
        duration_minutes: 30,
        price: 100,
        is_active: true,
      }),
    );

    const apptA = await makeAppointment(
      t,
      branchA.id,
      staffA.profileId,
      customer.id,
      service.id,
      1,
    );
    const apptB = await makeAppointment(
      t,
      branchB.id,
      staffB.profileId,
      customer.id,
      service.id,
      2,
    );

    return {
      owner,
      branchA: branchA.id,
      branchB: branchB.id,
      managerToken,
      managerUserId: manager.id,
      apptA,
      apptB,
      staffAUserId: staffA.userId,
      staffBUserId: staffB.userId,
      staffAProfileId: staffA.profileId,
      staffBProfileId: staffB.profileId,
      customerId: customer.id,
      serviceId: service.id,
    };
  }

  /**
   * The seeded system `branch_manager` role (its migration provisions it), or
   * — on a database built before that migration — one synthesized from the
   * SAME `ROLE_PERMISSIONS` entry. Either way the role under test carries the
   * catalogue's real grant list, never a hand-written approximation that
   * could drift from what production assigns.
   */
  async function resolveBranchManagerRole(): Promise<Role> {
    const ds = e2e.dataSource;
    const roles = ds.getRepository(Role);
    const existing = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.BRANCH_MANAGER })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (existing) return existing;

    const role = await roles.save(
      roles.create({
        name: 'Branch Manager',
        slug: ROLE.BRANCH_MANAGER,
        description: 'e2e-provisioned',
        is_system: true,
      }),
    );
    const slugs = ROLE_PERMISSIONS[ROLE.BRANCH_MANAGER] as string[];
    const perms = await ds
      .getRepository(Permission)
      .createQueryBuilder('p')
      .where('p.slug IN (:...slugs)', { slugs })
      .getMany();
    await ds
      .getRepository(RolePermission)
      .save(
        perms.map((permission) =>
          ds.getRepository(RolePermission).create({ role, permission }),
        ),
      );
    return role;
  }

  async function makeStaff(t: Tenant, branchId: string, name: string) {
    const ds = e2e.dataSource;
    const users = ds.getRepository(User);
    const user = await users.save(
      users.create({
        tenant: t,
        email: `${name.replace(/\s+/g, '-').toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
        full_name: name,
        is_active: true,
      }),
    );
    const profiles = ds.getRepository(StaffProfile);
    const profile = await profiles.save(
      profiles.create({
        tenant: t,
        user: { id: user.id } as User,
        title: name,
        is_available_for_booking: true,
      }),
    );
    await ds.getRepository(BranchUser).save(
      ds.getRepository(BranchUser).create({
        tenant: t,
        branch: { id: branchId } as Branch,
        user: { id: user.id } as User,
        is_primary: true,
      }),
    );
    return { userId: user.id, profileId: profile.id };
  }

  async function makeAppointment(
    t: Tenant,
    branchId: string,
    staffId: string,
    customerId: string,
    serviceId: string,
    dayOffset: number,
  ): Promise<string> {
    void serviceId;
    const ds = e2e.dataSource;
    const appointments = ds.getRepository(Appointment);
    const start = new Date(Date.now() + dayOffset * 86_400_000);
    const saved = await appointments.save(
      appointments.create({
        tenant: t,
        branch: { id: branchId } as Branch,
        staff: { id: staffId } as StaffProfile,
        customer: { id: customerId } as Customer,
        start_at: start,
        end_at: new Date(start.getTime() + 30 * 60_000),
        status: AppointmentStatus.CONFIRMED,
        payment_status: AppointmentPaymentStatus.PAID,
        source: AppointmentSource.MANUAL,
        branch_timezone: 'UTC',
      }),
    );
    return saved.id;
  }

  const asManager = () => authHeader(fx.managerToken);
  const asOwner = () => authHeader(fx.owner.token);

  // ── A/B. Creating a Branch Manager from the Staff page ───────────────────

  /**
   * The `/app/staff` flow itself, over HTTP: the role must be OFFERED by the
   * selector's endpoint, its permission set must be PREVIEWABLE, and creating
   * an employee with it must actually work — including the branch assignment
   * the role is meaningless without.
   *
   * Worth asserting rather than assuming: `RolesService` refuses to assign a
   * role carrying an unenforced permission (`assertNoUnenforcedPermission`),
   * so a badly-chosen grant list would make the new role un-assignable in a
   * way no unit test on the constants file would catch.
   */
  describe('creating a Branch Manager from /app/staff', () => {
    it('is offered by GET /staff/assignable-roles', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/assignable-roles`)
        .set(...asOwner())
        .expect(200);

      const roles = res.body as { slug: string; name: string }[];
      const found = roles.find((r) => r.slug === ROLE.BRANCH_MANAGER);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Branch Manager');
    });

    it('previews the role’s real permissions, including the branch-scoped one', async () => {
      const rolesRes = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/assignable-roles`)
        .set(...asOwner())
        .expect(200);
      const roleId = (rolesRes.body as { id: string; slug: string }[]).find(
        (r) => r.slug === ROLE.BRANCH_MANAGER,
      )!.id;

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/assignable-roles/${roleId}/permissions`)
        .set(...asOwner())
        .expect(200);

      const perms = res.body as {
        slug: string;
        scope?: string;
        isOwnershipScoped?: boolean;
      }[];
      const slugs = perms.map((p) => p.slug);

      // The pair that defines the restriction — and the metadata the
      // Permission Preview reports it from.
      expect(slugs).toContain('branches.update_own');
      expect(slugs).not.toContain('branches.update');
      const own = perms.find((p) => p.slug === 'branches.update_own')!;
      expect(own.scope).toBe('branch');
      expect(own.isOwnershipScoped).toBe(true);

      // And the exclusions the role is defined by.
      for (const denied of [
        'payments.read',
        'subscription.read',
        'staff.manage',
        'analytics.dashboard.read',
        'analytics.reports.read',
      ]) {
        expect(slugs).not.toContain(denied);
      }
    });

    it('creates an employee with the role and the branch assignment in one request', async () => {
      const email = `new-bm-${randomUUID().slice(0, 8)}@example.test`;
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/staff/from-new-user`)
        .set(...asOwner())
        .send({
          email,
          fullName: 'New Branch Manager',
          roleSlug: ROLE.BRANCH_MANAGER,
          title: 'Branch Manager',
          branchIds: [fx.branchA],
          primaryBranchId: fx.branchA,
        })
        .expect(201);

      const userId = res.body.profile.user.id as string;

      // The role really landed on the account…
      const [roleRow] = await e2e.dataSource.query(
        `SELECT r.slug FROM user_roles ur JOIN roles r ON r.id = ur."roleId" WHERE ur."userId" = $1`,
        [userId],
      );
      expect(roleRow.slug).toBe(ROLE.BRANCH_MANAGER);

      // …and so did the branch membership the role depends on. Without it the
      // account would be branch-restricted with an EMPTY scope and see
      // nothing — which is why the two belong in one request.
      const [membership] = await e2e.dataSource.query(
        `SELECT "branchId" FROM branch_users WHERE "userId" = $1`,
        [userId],
      );
      expect(membership.branchId).toBe(fx.branchA);
    });

    // ── Operations Manager retirement ─────────────────────────────────────
    // `manager` ("Operations Manager") is retired from new-staff assignment
    // in favor of `branch_manager`. These pin both enforcement surfaces: the
    // selector no longer offers it, and a direct API call can't smuggle it
    // in — mirroring how owner/super_admin/customer/ai-bot are already
    // proven unreachable via this same allow-list.

    it('does not offer manager (Operations Manager) in GET /staff/assignable-roles', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff/assignable-roles`)
        .set(...asOwner())
        .expect(200);

      const roles = res.body as { slug: string }[];
      expect(roles.find((r) => r.slug === ROLE.MANAGER)).toBeUndefined();
    });

    it('refuses to create a new staff member with roleSlug: manager', async () => {
      const email = `new-mgr-${randomUUID().slice(0, 8)}@example.test`;
      await request(e2e.app.getHttpServer())
        .post(`${API}/staff/from-new-user`)
        .set(...asOwner())
        .send({
          email,
          fullName: 'Would-Be Manager',
          roleSlug: ROLE.MANAGER,
          title: 'Manager',
        })
        .expect(403);
    });

    it('refuses to update an existing staff member’s role to manager', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/staff/${fx.staffAProfileId}`)
        .set(...asOwner())
        .send({ roleSlug: ROLE.MANAGER })
        .expect(403);
    });
  });

  // ── F. Branch isolation on reads ─────────────────────────────────────────

  describe('appointments — list', () => {
    it('returns ONLY the branch manager’s own branch when no filter is supplied', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .set(...asManager())
        .expect(200);

      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(fx.apptA);
      expect(ids).not.toContain(fx.apptB);
    });

    it('returns BOTH branches for the owner — tenant-wide behaviour is unchanged', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .set(...asOwner())
        .expect(200);

      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toEqual(expect.arrayContaining([fx.apptA, fx.apptB]));
    });

    // G. API authorization — the direct-call escape.
    it('REFUSES a foreign branchId rather than silently substituting the caller’s own', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .query({ branchId: fx.branchB })
        .set(...asManager())
        .expect(403);
    });

    it('permits the caller’s OWN branchId as an ordinary filter', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .query({ branchId: fx.branchA })
        .set(...asManager())
        .expect(200);
      expect(res.body.data.map((a: { id: string }) => a.id)).toContain(
        fx.apptA,
      );
    });

    it('lets the owner filter to either branch', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .query({ branchId: fx.branchB })
        .set(...asOwner())
        .expect(200);
      expect(res.body.data.map((a: { id: string }) => a.id)).toContain(
        fx.apptB,
      );
    });
  });

  describe('queue — branch picker', () => {
    it('offers the manager only their own branch, never the sibling one', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/queue/branches`)
        .set(...asManager())
        .expect(200);

      const ids = res.body.map((b: { id: string }) => b.id);
      expect(ids).toEqual([fx.branchA]);
    });

    it('offers the owner every branch — tenant-wide behaviour is unchanged', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/queue/branches`)
        .set(...asOwner())
        .expect(200);

      const ids = res.body.map((b: { id: string }) => b.id);
      expect(ids).toEqual(expect.arrayContaining([fx.branchA, fx.branchB]));
    });

    it('never offers a branch the manager would then be refused on GET /queue', async () => {
      const picker = await request(e2e.app.getHttpServer())
        .get(`${API}/queue/branches`)
        .set(...asManager())
        .expect(200);

      for (const branch of picker.body as { id: string }[]) {
        await request(e2e.app.getHttpServer())
          .get(`${API}/queue`)
          .query({ branchId: branch.id })
          .set(...asManager())
          .expect(200);
      }
    });
  });

  // ── IDOR: a record id from another branch ────────────────────────────────

  describe('appointments — single record (IDOR)', () => {
    it('404s a sibling branch’s appointment by UUID — indistinguishable from not existing', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${fx.apptB}`)
        .set(...asManager())
        .expect(404);
    });

    it('200s the caller’s own branch appointment', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/appointments/${fx.apptA}`)
        .set(...asManager())
        .expect(200);
    });

    it('200s BOTH for the owner', async () => {
      for (const id of [fx.apptA, fx.apptB]) {
        await request(e2e.app.getHttpServer())
          .get(`${API}/appointments/${id}`)
          .set(...asOwner())
          .expect(200);
      }
    });
  });

  // ── The write path — the escape a read-only fix would leave open ─────────

  describe('appointments — writes', () => {
    it('refuses to CANCEL a sibling branch’s appointment', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/appointments/${fx.apptB}/cancel`)
        .send({ reason: 'attempted cross-branch cancel' })
        .set(...asManager())
        .expect(404);

      // And prove it really did not happen.
      const after = await e2e.dataSource
        .getRepository(Appointment)
        .findOne({ where: { id: fx.apptB } });
      expect(after?.status).toBe(AppointmentStatus.CONFIRMED);
    });

    it('refuses to RESCHEDULE a sibling branch’s appointment', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/appointments/${fx.apptB}/reschedule`)
        .send({
          newStartAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        })
        .set(...asManager())
        .expect(404);
    });

    /**
     * Every field is a REAL, valid id — the point is to get past validation
     * so the request actually reaches the branch check. A payload that 400s
     * on a malformed UUID would prove nothing about authorization.
     */
    it('refuses to CREATE an appointment at a branch the caller does not run', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/appointments`)
        .send({
          branchId: fx.branchB,
          staffId: fx.staffBProfileId,
          customerId: fx.customerId,
          startAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
          serviceIds: [fx.serviceId],
        })
        .set(...asManager());

      expect(res.status).toBe(403);
    });

    it('CAN create at its own branch — the check narrows, it does not block the role', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/appointments`)
        .send({
          branchId: fx.branchA,
          staffId: fx.staffAProfileId,
          customerId: fx.customerId,
          startAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          serviceIds: [fx.serviceId],
        })
        .set(...asManager());

      // Not asserted as 201 outright: availability/working-hours rules are
      // this endpoint's own business logic and are not what this suite is
      // about. What matters is that it is NOT refused on branch grounds.
      expect(res.status).not.toBe(403);
    });
  });

  // ── Staff roster ─────────────────────────────────────────────────────────

  describe('staff — list', () => {
    it('shows only staff assigned to the caller’s branch', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff`)
        .query({ limit: 100 })
        .set(...asManager())
        .expect(200);

      const userIds = res.body.data.map(
        (s: { user?: { id: string } }) => s.user?.id,
      );
      expect(userIds).toContain(fx.staffAUserId);
      expect(userIds).not.toContain(fx.staffBUserId);
    });

    it('shows the whole roster to the owner', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/staff`)
        .query({ limit: 100 })
        .set(...asOwner())
        .expect(200);

      const userIds = res.body.data.map(
        (s: { user?: { id: string } }) => s.user?.id,
      );
      expect(userIds).toEqual(
        expect.arrayContaining([fx.staffAUserId, fx.staffBUserId]),
      );
    });

    it('refuses a foreign branchId on the staff filter', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/staff`)
        .query({ branchId: fx.branchB })
        .set(...asManager())
        .expect(403);
    });
  });

  // ── Activity log ─────────────────────────────────────────────────────────

  describe('activity log', () => {
    it('refuses a foreign branchId', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({ branchId: fx.branchB })
        .set(...asManager())
        .expect(403);
    });

    it('accepts the caller’s own branchId', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({ branchId: fx.branchA })
        .set(...asManager())
        .expect(200);
    });

    it('never returns a row from another branch, even unfiltered', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/activity`)
        .query({ limit: 100 })
        .set(...asManager())
        .expect(200);

      for (const row of res.body.data as { branch?: { id: string } | null }[]) {
        if (row.branch) expect(row.branch.id).toBe(fx.branchA);
      }
    });
  });

  // ── I. Dashboard data ────────────────────────────────────────────────────

  describe('dashboard summary', () => {
    /**
     * Counted from the database at assertion time rather than hard-coded:
     * the write tests above legitimately add rows, and a fixed literal here
     * would make this suite order-dependent — failing for a reason that has
     * nothing to do with branch scoping.
     */
    const countAppointments = async (branchId?: string) => {
      const rows = branchId
        ? await e2e.dataSource.query(
            `SELECT COUNT(*)::int AS c FROM appointments WHERE "tenantId" = $1 AND "branchId" = $2`,
            [fx.owner.tenantId, branchId],
          )
        : await e2e.dataSource.query(
            `SELECT COUNT(*)::int AS c FROM appointments WHERE "tenantId" = $1`,
            [fx.owner.tenantId],
          );
      return rows[0].c as number;
    };

    /**
     * Mirrors the EXISTS-through-`branch_users` shape the service uses, so
     * this is an independent re-derivation of the same question rather than a
     * copy of the service's own answer.
     */
    const countStaff = async (branchId?: string) => {
      const rows = branchId
        ? await e2e.dataSource.query(
            `SELECT COUNT(*)::int AS c FROM staff_profiles s
              WHERE s."tenantId" = $1
                AND EXISTS (SELECT 1 FROM branch_users bu
                             WHERE bu."userId" = s."user_id" AND bu."branchId" = $2)`,
            [fx.owner.tenantId, branchId],
          )
        : await e2e.dataSource.query(
            `SELECT COUNT(*)::int AS c FROM staff_profiles WHERE "tenantId" = $1`,
            [fx.owner.tenantId],
          );
      return rows[0].c as number;
    };

    it('counts only the caller’s branch, and says so in `scope.branchIds`', async () => {
      const expected = await countAppointments(fx.branchA);
      const expectedStaff = await countStaff(fx.branchA);
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/dashboard/summary`)
        .set(...asManager())
        .expect(200);

      expect(res.body.scope.branchIds).toEqual([fx.branchA]);
      expect(res.body.appointments).toBe(expected);
      expect(res.body.staff).toBe(expectedStaff);
    });

    it('reports a null branch scope and the full counts for the owner', async () => {
      const expected = await countAppointments();
      const expectedStaff = await countStaff();
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/dashboard/summary`)
        .set(...asOwner())
        .expect(200);

      expect(res.body.scope.branchIds).toBeNull();
      expect(res.body.appointments).toBe(expected);
      expect(res.body.staff).toBe(expectedStaff);
    });

    it('the branch manager’s appointment count is strictly smaller than the owner’s', async () => {
      const [manager, owner] = await Promise.all([
        request(e2e.app.getHttpServer())
          .get(`${API}/dashboard/summary`)
          .set(...asManager())
          .expect(200),
        request(e2e.app.getHttpServer())
          .get(`${API}/dashboard/summary`)
          .set(...asOwner())
          .expect(200),
      ]);

      expect(manager.body.appointments).toBeLessThan(owner.body.appointments);
    });
  });

  // ── H. Direct URL access to an owner-only surface ────────────────────────

  describe('owner-only surfaces stay closed', () => {
    it.each([
      ['payments', `${API}/payments`],
      ['subscription', `${API}/subscriptions/me`],
      ['analytics dashboard', `${API}/analytics/dashboard`],
    ])('refuses %s', async (_label, url) => {
      const res = await request(e2e.app.getHttpServer())
        .get(url)
        .set(...asManager());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('refuses to update clinic settings (role-gated to owner/manager)', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .send({ currency: 'USD' })
        .set(...asManager());
      expect(res.status).toBe(403);
    });

    it('refuses to create a branch (holds update_own only)', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/branches`)
        .send({ name: 'Sneaky Branch' })
        .set(...asManager())
        .expect(403);
    });

    it('refuses to update a branch it does not run, but CAN update its own', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/branches/${fx.branchB}`)
        .send({ name: 'Hijacked' })
        .set(...asManager())
        .expect(403);

      await request(e2e.app.getHttpServer())
        .patch(`${API}/branches/${fx.branchA}`)
        .send({ phone: '+966500000009' })
        .set(...asManager())
        .expect(200);
    });
  });
});
