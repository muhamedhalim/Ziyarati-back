/**
 * HTTP e2e — Sales Staff Management, Phase 2: employees + clinic ownership.
 *
 * Boots the REAL AppModule against the migrations-built `ziyarati_e2e`
 * database (see setup-e2e-db.js), so the partial unique indexes that carry the
 * ownership rules (`UQ_sales_assignment_active_tenant`,
 * `UQ_sales_assignment_acquired_tenant`) are the ones production has — not
 * something `synchronize` would have dropped. Every fixture is created here and
 * removed in `afterAll`, FK-safe.
 *
 * Emails: employees are created with `sendInvitation: false`, so no mail is
 * ever attempted.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';

import {
  authHeader,
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Role } from '../src/entities/Auth&RBAC/Role';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';
const RUN = randomUUID().slice(0, 8);

interface Actor {
  userId: string;
  token: string;
  email: string;
}

describe('Sales Staff Management — employees and clinic ownership (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let admin: Actor;
  let support: Actor;
  let salesSelf: Actor; // a platform_sales user acting AS themselves
  let repA: string;
  let repB: string;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  const http = () => e2e.app.getHttpServer();
  const get = (path: string, token = admin.token) =>
    request(http()).get(`${API}${path}`).set(...authHeader(token));
  const post = (path: string, body: object = {}, token = admin.token) =>
    request(http()).post(`${API}${path}`).set(...authHeader(token)).send(body);
  const patch = (path: string, body: object = {}, token = admin.token) =>
    request(http()).patch(`${API}${path}`).set(...authHeader(token)).send(body);
  const put = (path: string, body: object = {}, token = admin.token) =>
    request(http()).put(`${API}${path}`).set(...authHeader(token)).send(body);

  const mint = (userId: string, tenantId: string | null) =>
    e2e.jwt.signAsync(
      { sub: userId, tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
        expiresIn: '15m',
      },
    );

  /** A platform-scope user (tenantId NULL) holding a SEEDED global role. */
  async function createPlatformActor(roleSlug: string, label: string): Promise<Actor> {
    const role = await e2e.dataSource
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: roleSlug })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error(`Role "${roleSlug}" is not seeded — run migrations first.`);
    const users = e2e.dataSource.getRepository(User);
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `${label}-${RUN}-${randomUUID().slice(0, 6)}@example.test`,
        full_name: `E2E ${label}`,
        is_active: true,
      }),
    );
    await e2e.dataSource
      .getRepository(UserRole)
      .save({ user: { id: user.id } as User, role: { id: role.id } as Role });
    createdUserIds.push(user.id);
    return { userId: user.id, token: await mint(user.id, null), email: user.email! };
  }

  /** N approved (or given status) clinics in one INSERT — no per-row round trips. */
  async function seedClinics(
    n: number,
    label: string,
    status: 'APPROVED' | 'REJECTED' | 'PENDING_APPROVAL' = 'APPROVED',
  ): Promise<Array<{ id: string; slug: string }>> {
    const rows = (await e2e.dataSource.query(
      `INSERT INTO tenants (name, slug, contact_email, approval_status)
       SELECT $1 || ' ' || g, $2 || '-' || g, $2 || '-' || g || '@example.test', '${status}'
         FROM generate_series(1, $3::int) g
       RETURNING id, slug`,
      [`SalesE2E ${label}`, `se2e-${RUN}-${label}`, n],
    )) as Array<{ id: string; slug: string }>;
    rows.forEach((r) => createdTenantIds.push(r.id));
    return rows;
  }

  const activeOwners = async (tenantId: string) =>
    (await e2e.dataSource.query(
      `SELECT sales_user_id FROM sales_clinic_assignments WHERE tenant_id = $1 AND ended_at IS NULL`,
      [tenantId],
    )) as Array<{ sales_user_id: string }>;

  async function createRep(label: string): Promise<string> {
    const res = await post('/platform/staff', {
      email: `rep-${label}-${RUN}@example.test`,
      fullName: `Rep ${label}`,
      roleSlug: ROLE.PLATFORM_SALES,
      sendInvitation: false,
    }).expect(201);
    createdUserIds.push(res.body.id);
    return res.body.id as string;
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'sales-owner');
    admin = await createPlatformActor(ROLE.SUPER_ADMIN, 'sa');
    support = await createPlatformActor(ROLE.PLATFORM_SUPPORT, 'cs');
    salesSelf = await createPlatformActor(ROLE.PLATFORM_SALES, 'self');
    repA = await createRep('A');
    repB = await createRep('B');
  }, 90_000);

  afterAll(async () => {
    const ds = e2e.dataSource;
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM sales_activities WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM sales_clinic_assignments WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
    }
    if (createdTenantIds.length) {
      await ds.query(`DELETE FROM sales_clinic_assignments WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM api_logs WHERE "tenantId" = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM audit_logs WHERE "tenantId" = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [createdTenantIds]);
    }
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM password_resets WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM refresh_tokens WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM user_roles WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM audit_logs WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    }
    await cleanupTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 60_000);

  // ───────────────────────── provisioning (reuses /platform/staff) ─────────────────────────

  describe('provisioning a sales employee through /platform/staff', () => {
    it('creates a tenantId=NULL user with exactly platform_sales, NOT invited, and issues no token', async () => {
      const id = await createRep('prov');
      const user = await e2e.dataSource
        .getRepository(User)
        .findOneOrFail({ where: { id }, relations: { tenant: true } });
      expect(user.tenant).toBeNull();

      const slugs = (await e2e.dataSource.query(
        `SELECT r.slug FROM user_roles ur JOIN roles r ON r.id = ur."roleId" WHERE ur."userId" = $1`,
        [id],
      )) as Array<{ slug: string }>;
      expect(slugs.map((s) => s.slug)).toEqual([ROLE.PLATFORM_SALES]);

      const resets = await e2e.dataSource.query(
        `SELECT 1 FROM password_resets WHERE "userId" = $1`,
        [id],
      );
      expect(resets).toHaveLength(0);
    });

    it('the response says not_invited, and the staff list can be filtered to sales', async () => {
      const res = await get(`/platform/staff?role=${ROLE.PLATFORM_SALES}&limit=100`).expect(200);
      const a = res.body.data.find((s: { id: string }) => s.id === repA);
      expect(a).toMatchObject({ roles: [ROLE.PLATFORM_SALES], invitationStatus: 'not_invited' });
      expect(res.body.data.every((s: { roles: string[] }) => s.roles.includes(ROLE.PLATFORM_SALES))).toBe(true);
    });

    it('?isActive=false returns INACTIVE staff (it used to be coerced to true)', async () => {
      const id = await createRep('inactive-filter');
      await patch(`/platform/staff/${id}/status`, { isActive: false }).expect(200);

      const inactive = await get(`/platform/staff?isActive=false&limit=100`).expect(200);
      const ids = inactive.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(id);
      expect(inactive.body.data.every((s: { isActive: boolean }) => s.isActive === false)).toBe(true);

      const active = await get(`/platform/staff?isActive=true&limit=100`).expect(200);
      expect(active.body.data.map((s: { id: string }) => s.id)).not.toContain(id);
    });

    it('a clinic Owner cannot grant platform_sales through /roles/:id/users/:userId', async () => {
      const role = await e2e.dataSource
        .getRepository(Role)
        .createQueryBuilder('r')
        .where('r.slug = :slug', { slug: ROLE.PLATFORM_SALES })
        .andWhere('r."tenantId" IS NULL')
        .getOneOrFail();
      await request(http())
        .post(`${API}/roles/${role.id}/users/${owner.userId}`)
        .set(...authHeader(owner.token))
        .expect(403);
    });
  });

  // ───────────────────────── authorization matrix ─────────────────────────

  describe('every sales route is Super-Admin only', () => {
    const someId = randomUUID();
    // Every row has THREE cells: a 2-cell row makes jest pass `done` as the 3rd arg and the test waits on it forever.
    const routes: Array<[string, string, object | undefined]> = [
      ['GET', '/platform/sales/overview', undefined],
      ['GET', '/platform/sales/employees', undefined],
      ['GET', `/platform/sales/employees/${someId}`, undefined],
      ['GET', `/platform/sales/employees/${someId}/clinics`, undefined],
      ['GET', '/platform/sales/clinics', undefined],
      ['GET', `/platform/sales/clinics/${someId}/assignments`, undefined],
      ['POST', `/platform/sales/employees/${someId}/assignments`, { tenantIds: [someId] }],
      ['POST', `/platform/sales/employees/${someId}/assignments/transfer`, { toEmployeeId: someId, all: true }],
      ['POST', '/platform/sales/assignments/end', { assignmentIds: [someId] }],
      ['GET', `/platform/sales/employees/${someId}/targets`, undefined],
      ['GET', `/platform/sales/employees/${someId}/target-revisions`, undefined],
      ['PUT', `/platform/sales/employees/${someId}/targets/2026-09/new_clinics`, { targetValue: 5 }],
      ['DELETE', `/platform/sales/employees/${someId}/targets/2026-09/new_clinics`, undefined],
      ['GET', `/platform/sales/employees/${someId}/bonus-preview`, undefined],
      ['GET', `/platform/sales/employees/${someId}/bonuses`, undefined],
      ['POST', `/platform/sales/employees/${someId}/targets/2019-05/new_clinics/bonus/approve`, {}],
      ['POST', `/platform/sales/employees/${someId}/bonuses/${someId}/mark-paid`, {}],
      ['POST', `/platform/sales/employees/${someId}/bonuses/${someId}/void`, { reason: 'x' }],
      ['GET', `/platform/sales/employees/${someId}/activities`, undefined],
      ['POST', `/platform/sales/employees/${someId}/activities`, { type: 'visit', occurredAt: '2026-01-01T00:00:00Z', prospectName: 'x' }],
      ['DELETE', `/platform/sales/employees/${someId}/activities/${someId}`, undefined],
      ['GET', '/platform/sales/assignments/import/template', undefined],
      ['GET', '/platform/sales/assignments/export', undefined],
      ['POST', `/platform/sales/employees/${someId}/assignments/import/preview`, {}],
      ['POST', `/platform/sales/employees/${someId}/assignments/import/commit`, {}],
    ];

    const send = (method: string, path: string, body: object | undefined, token?: string) => {
      const verb = ({ GET: 'get', POST: 'post', PUT: 'put', DELETE: 'delete' } as const)[
        method as 'GET' | 'POST' | 'PUT' | 'DELETE'
      ];
      const r = request(http())[verb](`${API}${path}`);
      if (token) r.set(...authHeader(token));
      return method === 'GET' || method === 'DELETE' ? r : r.send(body ?? {});
    };

    it.each(routes)('%s %s → 401 without a token', async (method, path, body) => {
      await send(method, path, body).expect(401);
    });

    it.each(routes)('%s %s → 403 for a clinic Owner', async (method, path, body) => {
      await send(method, path, body, owner.token).expect(403);
    });

    it.each(routes)('%s %s → 403 for platform_support', async (method, path, body) => {
      await send(method, path, body, support.token).expect(403);
    });

    it.each(routes)('%s %s → 403 for a sales employee themselves', async (method, path, body) => {
      await send(method, path, body, salesSelf.token).expect(403);
    });
  });

  // ───────────────────────── employee 404s (no existence leak) ─────────────────────────

  describe('an id that is not a live sales employee is one identical 404', () => {
    it('tenant user, super admin, platform_support and a random uuid look the same everywhere', async () => {
      const ids = [owner.userId, admin.userId, support.userId, randomUUID()];
      const [tenant] = await seedClinics(1, 'nf');
      const bodies: string[] = [];
      for (const id of ids) {
        const detail = await get(`/platform/sales/employees/${id}`).expect(404);
        expect(detail.body.code).toBe('SALES_EMPLOYEE_NOT_FOUND');
        await get(`/platform/sales/employees/${id}/clinics`).expect(404);
        await post(`/platform/sales/employees/${id}/assignments`, { tenantIds: [tenant.id] }).expect(404);
        await get(`/platform/sales/employees/${id}/bonuses`).expect(404);
        await get(`/platform/sales/employees/${id}/bonus-preview`).expect(404);
        await get(`/platform/sales/employees/${id}/activities`).expect(404);
        await post(`/platform/sales/employees/${id}/activities`, {
          type: 'visit',
          occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
          prospectName: 'Nobody',
        }).expect(404);
        bodies.push(JSON.stringify({ code: detail.body.code, message: detail.body.message }));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(await activeOwners(tenant.id)).toHaveLength(0); // nothing was assigned
    });

    it('a soft-deleted sales user is a 404 too', async () => {
      const id = await createRep('softdel');
      await e2e.dataSource.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [id]);
      await get(`/platform/sales/employees/${id}`).expect(404);
    });
  });

  // ───────────────────────── clinic picker ─────────────────────────

  describe('clinic picker', () => {
    it('lists unassigned clinics by default, hides REJECTED ones, and searches by slug', async () => {
      const ok = await seedClinics(3, 'pick');
      const [rejected] = await seedClinics(1, 'pickrej', 'REJECTED');

      const res = await get(`/platform/sales/clinics?search=se2e-${RUN}-pick&limit=50`).expect(200);
      const slugs = res.body.data.map((c: { slug: string }) => c.slug);
      for (const c of ok) expect(slugs).toContain(c.slug);
      expect(slugs).not.toContain(rejected.slug);
      expect(res.body.data.every((c: { owner: unknown }) => c.owner === null)).toBe(true);
      expect(res.body).toMatchObject({ page: 1, limit: 50 });
    });

    it('shows the CURRENT owner, and assignment=unassigned stops offering an owned clinic', async () => {
      const [c] = await seedClinics(1, 'owned');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id] }).expect(201);

      const any = await get(`/platform/sales/clinics?search=${c.slug}&assignment=any`).expect(200);
      expect(any.body.data[0].owner).toMatchObject({ employeeId: repA, kind: 'managed' });

      const unassigned = await get(`/platform/sales/clinics?search=${c.slug}`).expect(200);
      expect(unassigned.body.data).toHaveLength(0);

      const excl = await get(
        `/platform/sales/clinics?search=${c.slug}&assignment=any&excludeEmployeeId=${repA}`,
      ).expect(200);
      expect(excl.body.data).toHaveLength(0);
    });

    it('paginates with a stable order (no repeats or gaps across pages of 7)', async () => {
      await seedClinics(20, 'page');
      const seen: string[] = [];
      let total = 0;
      for (let page = 1; page <= 4; page++) {
        const res = await get(`/platform/sales/clinics?search=se2e-${RUN}-page&limit=7&page=${page}`).expect(200);
        total = res.body.total;
        seen.push(...res.body.data.map((c: { id: string }) => c.id));
      }
      expect(total).toBe(20);
      expect(seen).toHaveLength(20);
      expect(new Set(seen).size).toBe(20);
    });

    it('rejects an injected sort key with 400', async () => {
      await get(`/platform/sales/clinics?sortBy=name;DROP TABLE tenants`).expect(400);
      await get(`/platform/sales/employees?sortDir=asc;--`).expect(400);
    });
  });

  // ───────────────────────── assigning ─────────────────────────

  describe('assigning clinics', () => {
    it('assigns a batch, is idempotent, and lists it in the portfolio', async () => {
      const clinics = await seedClinics(3, 'batch');
      const tenantIds = clinics.map((c) => c.id);

      const first = await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds }).expect(201);
      expect(first.body).toMatchObject({ requested: 3, assigned: 3, reassigned: 0, skipped: [] });

      const again = await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds }).expect(201);
      expect(again.body.assigned).toBe(0);
      expect(again.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(
        Array(3).fill('already_assigned_to_employee'),
      );

      const portfolio = await get(`/platform/sales/employees/${repA}/clinics?search=se2e-${RUN}-batch`).expect(200);
      expect(portfolio.body.total).toBe(3);
      expect(portfolio.body.data[0]).toMatchObject({ kind: 'managed', endedAt: null });
      expect(portfolio.body.data[0].clinic).toMatchObject({ approvalStatus: 'APPROVED' });
    });

    it('skips unknown, deleted and REJECTED clinics with distinct reasons and assigns the rest', async () => {
      const [good] = await seedClinics(1, 'mix');
      const [rej] = await seedClinics(1, 'mixrej', 'REJECTED');
      const [del] = await seedClinics(1, 'mixdel');
      await e2e.dataSource.query(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, [del.id]);
      const unknown = randomUUID();

      const res = await post(`/platform/sales/employees/${repA}/assignments`, {
        tenantIds: [good.id, rej.id, del.id, unknown],
      }).expect(201);

      expect(res.body.assigned).toBe(1);
      const byId = Object.fromEntries(res.body.skipped.map((s: { tenantId: string; reason: string }) => [s.tenantId, s.reason]));
      expect(byId[rej.id]).toBe('clinic_rejected');
      expect(byId[del.id]).toBe('clinic_not_found');
      expect(byId[unknown]).toBe('clinic_not_found');
    });

    it('a clinic another employee owns is skipped by default, naming the owner', async () => {
      const [c] = await seedClinics(1, 'conflict');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id] }).expect(201);

      const res = await post(`/platform/sales/employees/${repB}/assignments`, { tenantIds: [c.id] }).expect(201);
      expect(res.body.skipped).toEqual([
        { tenantId: c.id, reason: 'assigned_to_other', ownerEmployeeId: repA },
      ]);
      expect((await activeOwners(c.id)).map((o) => o.sales_user_id)).toEqual([repA]);
    });

    it('reassign takes the clinic over, closes the old row, and the history shows both', async () => {
      const [c] = await seedClinics(1, 'reassign');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id] }).expect(201);

      const res = await post(`/platform/sales/employees/${repB}/assignments`, {
        tenantIds: [c.id],
        onConflict: 'reassign',
      }).expect(201);
      expect(res.body).toMatchObject({ assigned: 1, reassigned: 1 });
      expect((await activeOwners(c.id)).map((o) => o.sales_user_id)).toEqual([repB]);

      const history = await get(`/platform/sales/clinics/${c.id}/assignments`).expect(200);
      expect(history.body.total).toBe(2);
      // newest first
      expect(history.body.data[0]).toMatchObject({ employee: { id: repB }, endedAt: null });
      expect(history.body.data[1]).toMatchObject({ employee: { id: repA }, endReason: 'reassigned' });

      // A's portfolio: gone from active, present under ended
      const aActive = await get(`/platform/sales/employees/${repA}/clinics?search=${c.id}`).expect(200);
      const aEnded = await get(`/platform/sales/employees/${repA}/clinics?status=ended&search=se2e-${RUN}-reassign`).expect(200);
      expect(aActive.body.total).toBe(0);
      expect(aEnded.body.data[0]).toMatchObject({ endReason: 'reassigned' });
    });

    it('acquisition credit is granted at most once per clinic, EVER', async () => {
      const [c] = await seedClinics(1, 'acq');
      const first = await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id], kind: 'acquired' }).expect(201);
      expect(first.body.assigned).toBe(1);

      // another rep tries to take it over AND be credited: refused, nothing changes
      const stolen = await post(`/platform/sales/employees/${repB}/assignments`, {
        tenantIds: [c.id], kind: 'acquired', onConflict: 'reassign',
      }).expect(201);
      expect(stolen.body.skipped).toEqual([{ tenantId: c.id, reason: 'acquisition_already_credited' }]);
      expect((await activeOwners(c.id)).map((o) => o.sales_user_id)).toEqual([repA]);

      // ...but as a plain managed hand-over it works
      await post(`/platform/sales/employees/${repB}/assignments`, {
        tenantIds: [c.id], onConflict: 'reassign',
      }).expect(201);

      // and credit survives the original owner losing the clinic
      const [{ n }] = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM sales_clinic_assignments WHERE tenant_id = $1 AND kind = 'acquired'`,
        [c.id],
      );
      expect(n).toBe(1);
    });

    it('rejects malformed bodies with 400 and touches nothing', async () => {
      const [c] = await seedClinics(1, 'bad');
      const over = Array.from({ length: 201 }, () => randomUUID());
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: over }).expect(400);
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [] }).expect(400);
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id, c.id] }).expect(400);
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: ['nope'] }).expect(400);
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id], salesUserId: repB }).expect(400);
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id], kind: 'owner' }).expect(400);
      await post(`/platform/sales/employees/not-a-uuid/assignments`, { tenantIds: [c.id] }).expect(400);
      expect(await activeOwners(c.id)).toHaveLength(0);
    });

    it('writes an audit entry: bulk = one row, single clinic = attributed to that clinic', async () => {
      const [single] = await seedClinics(1, 'audit1');
      const bulk = await seedClinics(3, 'auditN');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [single.id] }).expect(201);
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: bulk.map((c) => c.id) }).expect(201);

      const rows = (await e2e.dataSource.query(
        `SELECT "tenantId", new_values FROM audit_logs
          WHERE action = 'platform_admin.sales.assignment_created' AND "userId" = $1 AND entity_id = $2
          ORDER BY created_at DESC LIMIT 20`,
        [admin.userId, repA],
      )) as Array<{ tenantId: string | null; new_values: { assigned: number } }>;

      expect(rows.some((r) => r.tenantId === single.id)).toBe(true);
      const bulkRow = rows.find((r) => r.new_values.assigned === 3);
      expect(bulkRow).toBeDefined();
      expect(bulkRow!.tenantId).toBeNull();
      // a skipped-only request writes nothing
      const before = rows.length;
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [single.id] }).expect(201);
      const [{ n }] = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'platform_admin.sales.assignment_created' AND "userId" = $1 AND entity_id = $2`,
        [admin.userId, repA],
      );
      expect(n).toBe(before);
    });
  });

  // ───────────────────────── concurrency ─────────────────────────

  describe('concurrent assignment', () => {
    it('two employees racing for the SAME clinic: exactly one wins, the other is skipped, one active row', async () => {
      for (let round = 0; round < 5; round++) {
        const [c] = await seedClinics(1, `race${round}`);
        const [a, b] = await Promise.all([
          post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id] }),
          post(`/platform/sales/employees/${repB}/assignments`, { tenantIds: [c.id] }),
        ]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body.assigned + b.body.assigned).toBe(1);
        const loser = a.body.assigned === 0 ? a : b;
        expect(['concurrent_assignment', 'assigned_to_other']).toContain(loser.body.skipped[0].reason);
        expect(await activeOwners(c.id)).toHaveLength(1);
      }
    });

    it('overlapping batches in opposite order do not deadlock and never double-own a clinic', async () => {
      const clinics = await seedClinics(20, 'overlap');
      const asc = clinics.map((c) => c.id);
      const desc = [...asc].reverse();
      const [a, b] = await Promise.all([
        post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: asc }),
        post(`/platform/sales/employees/${repB}/assignments`, { tenantIds: desc }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.assigned + b.body.assigned).toBe(20);
      for (const c of clinics) expect(await activeOwners(c.id)).toHaveLength(1);
    });

    it('the database itself refuses a second active owner (the guard is not just app logic)', async () => {
      const [c] = await seedClinics(1, 'dbguard');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id] }).expect(201);
      await expect(
        e2e.dataSource.query(
          `INSERT INTO sales_clinic_assignments (sales_user_id, tenant_id, kind) VALUES ($1, $2, 'managed')`,
          [repB, c.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  // ───────────────────────── ending & transferring ─────────────────────────

  describe('ending assignments', () => {
    it('ends by id, is idempotent, and reports unknown ids', async () => {
      const [c] = await seedClinics(1, 'end');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id] }).expect(201);
      const [row] = await e2e.dataSource.query(
        `SELECT id FROM sales_clinic_assignments WHERE tenant_id = $1 AND ended_at IS NULL`, [c.id]);
      const ghost = randomUUID();

      const res = await post('/platform/sales/assignments/end', { assignmentIds: [row.id, ghost] }).expect(200);
      expect(res.body).toMatchObject({ requested: 2, ended: 1 });
      expect(res.body.skipped).toEqual([{ assignmentId: ghost, reason: 'not_found' }]);
      expect(await activeOwners(c.id)).toHaveLength(0);

      const again = await post('/platform/sales/assignments/end', { assignmentIds: [row.id] }).expect(200);
      expect(again.body).toMatchObject({ ended: 0, skipped: [{ assignmentId: row.id, reason: 'already_ended' }] });

      // the clinic is unowned and can be picked again; its history keeps both facts
      const hist = await get(`/platform/sales/clinics/${c.id}/assignments`).expect(200);
      expect(hist.body.data[0]).toMatchObject({ endReason: 'unassigned' });
    });

    it('ending several at once reports every one as ended and NONE as skipped', async () => {
      // Regression: a stale build reported all of them as "already ended" because
      // it treated the [rows, count] UPDATE tuple as the row list. One ended row
      // plus a ghost id cannot tell the two apart; several ended rows can.
      const clinics = await seedClinics(3, 'endmany');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: clinics.map((c) => c.id) }).expect(201);
      const rows: Array<{ id: string }> = await e2e.dataSource.query(
        `SELECT id FROM sales_clinic_assignments WHERE tenant_id = ANY($1::uuid[]) AND ended_at IS NULL`,
        [clinics.map((c) => c.id)],
      );
      expect(rows).toHaveLength(3);

      const res = await post('/platform/sales/assignments/end', { assignmentIds: rows.map((r) => r.id) }).expect(200);
      expect(res.body).toEqual({ requested: 3, ended: 3, skipped: [] });
      for (const c of clinics) expect(await activeOwners(c.id)).toHaveLength(0);
    });
  });

  describe('deactivation and hand-off', () => {
    it('deactivating reports the clinics still owned; an inactive employee cannot receive clinics', async () => {
      const rep = await createRep('leaver');
      const clinics = await seedClinics(3, 'leaver');
      await post(`/platform/sales/employees/${rep}/assignments`, { tenantIds: clinics.map((c) => c.id) }).expect(201);

      const res = await patch(`/platform/staff/${rep}/status`, { isActive: false }).expect(200);
      expect(res.body.activeAssignments).toBe(3);

      const [extra] = await seedClinics(1, 'leaverx');
      const refused = await post(`/platform/sales/employees/${rep}/assignments`, { tenantIds: [extra.id] }).expect(409);
      expect(refused.body.code).toBe('SALES_EMPLOYEE_INACTIVE');
      expect(await activeOwners(extra.id)).toHaveLength(0);
    });

    it('transfers a deactivated employee\'s whole portfolio to an active one', async () => {
      const rep = await createRep('xfer');
      const clinics = await seedClinics(4, 'xfer');
      await post(`/platform/sales/employees/${rep}/assignments`, { tenantIds: clinics.map((c) => c.id) }).expect(201);
      await patch(`/platform/staff/${rep}/status`, { isActive: false }).expect(200);

      const res = await post(`/platform/sales/employees/${rep}/assignments/transfer`, {
        toEmployeeId: repB, all: true,
      }).expect(200);
      expect(res.body).toMatchObject({ transferred: 4, remaining: 0, skipped: [] });

      for (const c of clinics) expect((await activeOwners(c.id)).map((o) => o.sales_user_id)).toEqual([repB]);
      const hist = await get(`/platform/sales/clinics/${clinics[0].id}/assignments`).expect(200);
      expect(hist.body.data[1]).toMatchObject({ employee: { id: rep }, endReason: 'transferred' });
      const detail = await get(`/platform/sales/employees/${rep}`).expect(200);
      expect(detail.body).toMatchObject({ assignedCount: 0, endedCount: 4 });
    });

    it('cannot transfer to yourself, to an inactive employee, or to a non-employee', async () => {
      await post(`/platform/sales/employees/${repA}/assignments/transfer`, { toEmployeeId: repA, all: true }).expect(400);
      const gone = await createRep('gone');
      await patch(`/platform/staff/${gone}/status`, { isActive: false }).expect(200);
      await post(`/platform/sales/employees/${repA}/assignments/transfer`, { toEmployeeId: gone, all: true }).expect(409);
      await post(`/platform/sales/employees/${repA}/assignments/transfer`, { toEmployeeId: owner.userId, all: true }).expect(404);
      await post(`/platform/sales/employees/${repA}/assignments/transfer`, { toEmployeeId: repB }).expect(400); // neither ids nor all
    });

    it("an assignment id that is not the source employee's is never moved (IDOR)", async () => {
      const src = await createRep('idor-src');
      const [mine] = await seedClinics(1, 'idorm');
      const [theirs] = await seedClinics(1, 'idort');
      await post(`/platform/sales/employees/${src}/assignments`, { tenantIds: [mine.id] }).expect(201);
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [theirs.id] }).expect(201);
      const [row] = await e2e.dataSource.query(
        `SELECT id FROM sales_clinic_assignments WHERE tenant_id = $1 AND ended_at IS NULL`, [theirs.id]);

      const res = await post(`/platform/sales/employees/${src}/assignments/transfer`, {
        toEmployeeId: repB, assignmentIds: [row.id],
      }).expect(200);
      expect(res.body).toMatchObject({ transferred: 0, skipped: [{ assignmentId: row.id, reason: 'not_owned_by_employee' }] });
      expect((await activeOwners(theirs.id)).map((o) => o.sales_user_id)).toEqual([repA]);
    });

    it('the sales role cannot be removed while the employee still owns clinics', async () => {
      const rep = await createRep('rolestrip');
      const [c] = await seedClinics(1, 'rolestrip');
      await post(`/platform/sales/employees/${rep}/assignments`, { tenantIds: [c.id] }).expect(201);

      const res = await put(`/platform/staff/${rep}/roles`, { roleSlugs: [ROLE.PLATFORM_SUPPORT] }).expect(409);
      expect(res.body.context).toMatchObject({ activeAssignments: 1 });
      // still a sales employee
      await get(`/platform/sales/employees/${rep}`).expect(200);

      await post('/platform/sales/assignments/end', {
        assignmentIds: (await e2e.dataSource.query(
          `SELECT id FROM sales_clinic_assignments WHERE sales_user_id = $1 AND ended_at IS NULL`, [rep]))
          .map((r: { id: string }) => r.id),
      }).expect(200);
      await put(`/platform/staff/${rep}/roles`, { roleSlugs: [ROLE.PLATFORM_SUPPORT] }).expect(200);
      await get(`/platform/sales/employees/${rep}`).expect(404); // no longer a sales employee
    });
  });

  // ───────────────────────── employees list & overview ─────────────────────────

  describe('employees list and overview', () => {
    it('lists ONLY sales employees, with assigned counts, sortable and paginated', async () => {
      const res = await get('/platform/sales/employees?limit=100&sortBy=assigned&sortDir=DESC').expect(200);
      const ids = res.body.data.map((e: { id: string }) => e.id);
      expect(ids).toEqual(expect.arrayContaining([repA, repB]));
      expect(ids).not.toContain(support.userId);
      expect(ids).not.toContain(admin.userId);
      expect(ids).not.toContain(owner.userId);
      const counts = res.body.data.map((e: { assignedCount: number }) => e.assignedCount);
      expect(counts).toEqual([...counts].sort((x, y) => y - x));
      const a = res.body.data.find((e: { id: string }) => e.id === repA);
      expect(a.assignedCount).toBeGreaterThan(0);
      expect(a).toMatchObject({ roles: [ROLE.PLATFORM_SALES], lastActivityAt: null });
    });

    it('paginates the employee list without repeats', async () => {
      const seen: string[] = [];
      let total = 0;
      for (let page = 1; page <= 30; page++) {
        const res = await get(`/platform/sales/employees?limit=3&page=${page}&sortBy=name`).expect(200);
        total = res.body.total;
        if (!res.body.data.length) break;
        seen.push(...res.body.data.map((e: { id: string }) => e.id));
      }
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    });

    it('filters by active state and searches by name', async () => {
      const inactive = await get('/platform/sales/employees?isActive=false&limit=100').expect(200);
      expect(inactive.body.data.every((e: { isActive: boolean }) => !e.isActive)).toBe(true);
      const byName = await get(`/platform/sales/employees?search=${encodeURIComponent('Rep A')}`).expect(200);
      expect(byName.body.data.map((e: { id: string }) => e.id)).toContain(repA);
    });

    it('overview counts agree with the data and report the billing mode', async () => {
      const res = await get('/platform/sales/overview?period=2026-09').expect(200);
      expect(res.body).toMatchObject({ period: '2026-09', periodMonth: '2026-09-01' });
      expect(res.body.employees).toBeGreaterThanOrEqual(2);
      expect(res.body.activeEmployees).toBeLessThanOrEqual(res.body.employees);
      expect(res.body.assignedClinics).toBeGreaterThan(0);
      expect(typeof res.body.billingLive).toBe('boolean');
      await get('/platform/sales/overview?period=2026-13').expect(400);
      await get('/platform/sales/overview').expect(200); // defaults to the current month
    });

    it('overview: assigning moves a clinic from unassigned to assigned by exactly one', async () => {
      const [c] = await seedClinics(1, 'ovw');
      const before = (await get('/platform/sales/overview').expect(200)).body;
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c.id] }).expect(201);
      const after = (await get('/platform/sales/overview').expect(200)).body;
      expect(after.assignedClinics - before.assignedClinics).toBe(1);
      expect(before.unassignedClinics - after.unassignedClinics).toBe(1);
    });
  });

  // ───────────────────────── portfolio filters ─────────────────────────

  describe('portfolio filters', () => {
    it('staleDays finds never-worked clinics; a logged activity removes a clinic from the stale list', async () => {
      const rep = await createRep('stale');
      const [worked, idle] = await seedClinics(2, 'stale');
      await post(`/platform/sales/employees/${rep}/assignments`, { tenantIds: [worked.id, idle.id] }).expect(201);

      const before = await get(`/platform/sales/employees/${rep}/clinics?staleDays=30`).expect(200);
      expect(before.body.total).toBe(2);

      await e2e.dataSource.query(
        `INSERT INTO sales_activities (sales_user_id, tenant_id, type, occurred_at, recorded_by)
         VALUES ($1, $2, 'visit', now() - interval '2 days', $3)`,
        [rep, worked.id, admin.userId],
      );
      const after = await get(`/platform/sales/employees/${rep}/clinics?staleDays=30`).expect(200);
      expect(after.body.data.map((r: { clinic: { id: string } }) => r.clinic.id)).toEqual([idle.id]);

      const all = await get(`/platform/sales/employees/${rep}/clinics?sortBy=lastActivity&sortDir=DESC`).expect(200);
      expect(all.body.data[0].clinic.id).toBe(worked.id);
      expect(all.body.data[0].lastActivityAt).not.toBeNull();
      expect(all.body.data[1].lastActivityAt).toBeNull();

      const detail = await get(`/platform/sales/employees/${rep}`).expect(200);
      expect(detail.body.lastActivityAt).not.toBeNull();
    });
  });

  // ───────────────────────── measured: no N+1 ─────────────────────────

  describe('query count does not grow with page size (no N+1)', () => {
    // Every statement any pooled connection sends goes through pg.Client#query.
    const proto = PgClient.prototype as unknown as { query: (...a: unknown[]) => unknown };
    const original = proto.query;
    let counting = false;
    let count = 0;

    beforeAll(() => {
      proto.query = function patched(this: unknown, ...args: unknown[]) {
        if (counting) count++;
        return original.apply(this, args);
      };
    });
    afterAll(() => {
      proto.query = original;
    });

    async function statements(path: string): Promise<number> {
      count = 0;
      counting = true;
      try {
        await get(path).expect(200);
      } finally {
        counting = false;
      }
      return count;
    }

    it('employees list: same statement count for 2 and for 12 rows', async () => {
      for (let i = 0; i < 12; i++) await createPlatformActor(ROLE.PLATFORM_SALES, `qc${i}`);
      await get('/platform/sales/employees?limit=2'); // warm caches
      const small = await statements('/platform/sales/employees?limit=2&sortBy=assigned');
      const large = await statements('/platform/sales/employees?limit=12&sortBy=assigned');
      console.log(`[query-count] employees: limit=2 → ${small}, limit=12 → ${large}`);
      expect(large).toBe(small);
    });

    it('clinic picker and portfolio: same statement count for 5 and for 30 rows', async () => {
      const rep = await createRep('qcpf');
      const clinics = await seedClinics(30, 'qc');
      await post(`/platform/sales/employees/${rep}/assignments`, { tenantIds: clinics.map((c) => c.id) }).expect(201);
      const picker = (n: number) => `/platform/sales/clinics?search=se2e-${RUN}-qc&assignment=any&limit=${n}`;
      const folio = (n: number) => `/platform/sales/employees/${rep}/clinics?limit=${n}`;
      await get(picker(5));
      await get(folio(5));

      const pSmall = await statements(picker(5));
      const pLarge = await statements(picker(30));
      const fSmall = await statements(folio(5));
      const fLarge = await statements(folio(30));
      console.log(`[query-count] picker: 5 → ${pSmall}, 30 → ${pLarge}; portfolio: 5 → ${fSmall}, 30 → ${fLarge}`);
      expect(pLarge).toBe(pSmall);
      expect(fLarge).toBe(fSmall);
    });
  });
});
