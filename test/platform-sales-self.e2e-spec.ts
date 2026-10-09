/**
 * HTTP e2e — the sales rep's own console API (`/platform/sales/me/**`) and the
 * invitation lifecycle that leads to it: create -> invite -> accept -> login ->
 * own data.
 *
 * Boots the REAL AppModule against the migrations-built `ziyarati_e2e`
 * database. Mail is forced off (see sales-self-env.setup.ts); the raw
 * invitation token is captured from `AuthService.issuePasswordSetupToken`.
 * Every fixture is created here and removed in `afterAll`, FK-safe.
 */
import './utils/sales-self-env.setup';

import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';

import {
  authHeader,
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { AuthService } from '../src/modules/auth/auth.service';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Str0ng!Passw0rd#1';
const PASSWORD_2 = 'An0ther!Passw0rd#2';
const CLOSED = '2019-05';

interface Actor {
  userId: string;
  token: string;
}

describe('Sales rep self-service + invitation lifecycle (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let admin: Actor;
  let support: Actor;
  let repA: Actor;
  let repB: Actor;
  let clinicA1: string;
  let clinicA2: string;
  let clinicB1: string;
  let unowned: string;
  const issued: Array<{ userId: string; token: string }> = [];
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  const http = () => e2e.app.getHttpServer();
  const api = {
    get: (path: string, token: string) =>
      request(http()).get(`${API}${path}`).set(...authHeader(token)),
    post: (path: string, body: object, token: string) =>
      request(http()).post(`${API}${path}`).set(...authHeader(token)).send(body),
    put: (path: string, body: object, token: string) =>
      request(http()).put(`${API}${path}`).set(...authHeader(token)).send(body),
    patch: (path: string, body: object, token: string) =>
      request(http()).patch(`${API}${path}`).set(...authHeader(token)).send(body),
  };
  const mint = (userId: string) =>
    e2e.jwt.signAsync(
      { sub: userId, tenantId: null, type: 'access' },
      { secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'), expiresIn: '15m' },
    );
  const tokenFor = (userId: string) => issued.filter((t) => t.userId === userId).map((t) => t.token);

  async function platformUser(roleSlug: string, label: string): Promise<Actor> {
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
        email: `${label}-${RUN}@example.test`,
        full_name: `E2E ${label}`,
        is_active: true,
      }),
    );
    await e2e.dataSource
      .getRepository(UserRole)
      .save({ user: { id: user.id } as User, role: { id: role.id } as Role });
    createdUserIds.push(user.id);
    return { userId: user.id, token: await mint(user.id) };
  }

  async function seedClinic(label: string): Promise<string> {
    const [row] = (await e2e.dataSource.query(
      `INSERT INTO tenants (name, slug, contact_email, contact_phone, approval_status)
       VALUES ($1, $2, $3, '+966500000001', 'APPROVED') RETURNING id`,
      [`SelfE2E ${label}`, `self-${RUN}-${label}`, `${label}-${RUN}@clinic.example.test`],
    )) as Array<{ id: string }>;
    createdTenantIds.push(row.id);
    return row.id;
  }

  /** Creates a sales employee THROUGH the API, with an invitation. */
  async function inviteRep(label: string): Promise<{ id: string; email: string }> {
    const email = `invite-${label}-${RUN}@example.test`;
    const res = await api
      .post('/platform/staff', { email, fullName: `Rep ${label}`, roleSlug: ROLE.PLATFORM_SALES }, admin.token)
      .expect(201);
    createdUserIds.push(res.body.id);
    return { id: res.body.id as string, email };
  }

  const resetPassword = (token: string, newPassword = PASSWORD) =>
    request(http()).post(`${API}/auth/reset-password`).send({ token, newPassword });

  async function login(email: string, password: string) {
    const res = await request(http()).post(`${API}/auth/login`).send({ email, password });
    const cookies = ((res.headers['set-cookie'] as unknown as string[]) ?? []).map((c) => c.split(';')[0]);
    return { res, cookie: cookies.join('; ') };
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    const auth = e2e.app.get(AuthService);
    const original = auth.issuePasswordSetupToken.bind(auth);
    jest.spyOn(auth, 'issuePasswordSetupToken').mockImplementation(async (userId, ttl) => {
      const token = await original(userId, ttl);
      issued.push({ userId, token });
      return token;
    });

    owner = await createOwnerFixture(e2e, 'sales-self-owner');
    admin = await platformUser(ROLE.SUPER_ADMIN, 'sa');
    support = await platformUser(ROLE.PLATFORM_SUPPORT, 'cs');
    repA = await platformUser(ROLE.PLATFORM_SALES, 'repa');
    repB = await platformUser(ROLE.PLATFORM_SALES, 'repb');

    clinicA1 = await seedClinic('a1');
    clinicA2 = await seedClinic('a2');
    clinicB1 = await seedClinic('b1');
    unowned = await seedClinic('free');

    await api
      .post(`/platform/sales/employees/${repA.userId}/assignments`, { tenantIds: [clinicA1, clinicA2], kind: 'acquired', note: 'PRIVATE-ADMIN-NOTE' }, admin.token)
      .expect(201);
    await api
      .post(`/platform/sales/employees/${repB.userId}/assignments`, { tenantIds: [clinicB1], note: 'B-NOTE' }, admin.token)
      .expect(201);

    // A CLOSED month for repA with a bonus rule, approved, voided (with a reason), approved again.
    await e2e.dataSource.query(
      `UPDATE sales_clinic_assignments SET assigned_at = '2019-05-02T09:00:00Z' WHERE sales_user_id = $1`,
      [repA.userId],
    );
    await api
      .put(
        `/platform/sales/employees/${repA.userId}/targets/${CLOSED}/new_clinics`,
        { targetValue: 2, bonusType: 'fixed_on_threshold', bonusThresholdPct: 100, bonusAmount: 500, bonusCurrency: 'SAR', reason: 'ADMIN-TARGET-REASON' },
        admin.token,
      )
      .expect(200);
    const approve = () =>
      api.post(`/platform/sales/employees/${repA.userId}/targets/${CLOSED}/new_clinics/bonus/approve`, {}, admin.token);
    const a1 = await approve().expect(201);
    await api
      .post(`/platform/sales/employees/${repA.userId}/bonuses/${a1.body.id}/void`, { reason: 'ADMIN-VOID-REASON' }, admin.token)
      .expect(200);
    await approve().expect(201);
  }, 120_000);

  afterAll(async () => {
    const ds = e2e.dataSource;
    jest.restoreAllMocks();
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM sales_bonus_records WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM sales_target_revisions WHERE target_id IN (SELECT id FROM sales_targets WHERE sales_user_id = ANY($1::uuid[]))`, [createdUserIds]);
      await ds.query(`DELETE FROM sales_targets WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
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

  // ───────────────────────── invitation lifecycle ─────────────────────────

  describe('create -> invite -> accept -> login -> own data', () => {
    it('walks the whole path for a real rep, and the account was unusable before accepting', async () => {
      const rep = await inviteRep('flow');
      const [token] = tokenFor(rep.id);
      expect(token).toBeDefined();

      const list = await api.get(`/platform/staff?role=${ROLE.PLATFORM_SALES}&limit=100`, admin.token).expect(200);
      expect(list.body.data.find((s: { id: string }) => s.id === rep.id).invitationStatus).toBe('invitation_pending');

      // The random placeholder password cannot be guessed: nothing to log in with yet.
      expect((await login(rep.email, PASSWORD)).res.status).toBe(401);

      await resetPassword(token).expect(200);

      const { res, cookie } = await login(rep.email, PASSWORD);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ tenantId: null, roles: [ROLE.PLATFORM_SALES], permissions: [] });

      const me = await request(http()).get(`${API}/auth/me`).set('Cookie', cookie).expect(200);
      expect(me.body).toMatchObject({ tenantId: null, roles: [ROLE.PLATFORM_SALES] });

      const mine = await request(http()).get(`${API}/platform/sales/me`).set('Cookie', cookie).expect(200);
      expect(mine.body).toMatchObject({ id: rep.id, assignedCount: 0 });

      const after = await api.get(`/platform/staff?role=${ROLE.PLATFORM_SALES}&limit=100`, admin.token).expect(200);
      expect(after.body.data.find((s: { id: string }) => s.id === rep.id).invitationStatus).toBe('active');
    });

    it('a link is single use', async () => {
      const rep = await inviteRep('once');
      const [token] = tokenFor(rep.id);
      await resetPassword(token).expect(200);
      const again = await resetPassword(token, PASSWORD_2).expect(400);
      expect(again.body.code ?? again.body.error?.code).toBe('INVALID_RESET_TOKEN');
      expect((await login(rep.email, PASSWORD_2)).res.status).toBe(401);
      expect((await login(rep.email, PASSWORD)).res.status).toBe(200);
    });

    it('an expired link is refused', async () => {
      const rep = await inviteRep('expired');
      const [token] = tokenFor(rep.id);
      await e2e.dataSource.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE "userId" = $1`, [rep.id]);
      await resetPassword(token).expect(400);
      const list = await api.get(`/platform/staff?role=${ROLE.PLATFORM_SALES}&limit=100`, admin.token).expect(200);
      expect(list.body.data.find((s: { id: string }) => s.id === rep.id).invitationStatus).toBe('invitation_expired');
    });

    it('re-sending kills every earlier link; only the newest one works', async () => {
      const rep = await inviteRep('resend');
      await api.post(`/platform/staff/${rep.id}/resend-invitation`, {}, admin.token).expect(201);
      const [old, fresh] = tokenFor(rep.id);
      expect(fresh).toBeDefined();
      await resetPassword(old).expect(400);
      await resetPassword(fresh).expect(200);
    });

    it('a deactivated account cannot be re-invited', async () => {
      const rep = await inviteRep('inactive');
      await api.patch(`/platform/staff/${rep.id}/status`, { isActive: false }, admin.token).expect(200);
      const before = tokenFor(rep.id).length;
      await api.post(`/platform/staff/${rep.id}/resend-invitation`, {}, admin.token).expect(422);
      expect(tokenFor(rep.id)).toHaveLength(before);
    });

    it('accepting kills the other outstanding links of the same user', async () => {
      const rep = await inviteRep('others');
      // Two live links (as left by the pre-fix behaviour), then use one.
      const raw = 'f'.repeat(64);
      const hash = createHash('sha256').update(raw).digest('hex');
      await e2e.dataSource.query(
        `INSERT INTO password_resets (token_hash, expires_at, "userId") VALUES ($1, now() + interval '1 day', $2)`,
        [hash, rep.id],
      );
      await resetPassword(tokenFor(rep.id)[0]).expect(200);
      await resetPassword(raw, PASSWORD_2).expect(400);
      const live = await e2e.dataSource.query(`SELECT 1 FROM password_resets WHERE "userId" = $1 AND used_at IS NULL`, [rep.id]);
      expect(live).toHaveLength(0);
    });

    it('two simultaneous submissions of one link: exactly one wins and the password is the winner’s', async () => {
      const rep = await inviteRep('race');
      const [token] = tokenFor(rep.id);
      const [r1, r2] = await Promise.all([resetPassword(token, PASSWORD), resetPassword(token, PASSWORD_2)]);
      expect([r1.status, r2.status].sort()).toEqual([200, 400]);
      const winner = r1.status === 200 ? PASSWORD : PASSWORD_2;
      const loser = r1.status === 200 ? PASSWORD_2 : PASSWORD;
      expect((await login(rep.email, winner)).res.status).toBe(200);
      expect((await login(rep.email, loser)).res.status).toBe(401);
    });
  });

  // ───────────────────────── what a rep sees ─────────────────────────

  describe('GET /platform/sales/me/**', () => {
    it('lists only the caller’s own clinics, with contact details and WITHOUT the admin note', async () => {
      const a = await api.get('/platform/sales/me/clinics', repA.token).expect(200);
      expect(a.body.total).toBe(2);
      const ids = a.body.data.map((r: { clinic: { id: string } }) => r.clinic.id).sort();
      expect(ids).toEqual([clinicA1, clinicA2].sort());
      expect(a.body.data[0].clinic.contactEmail).toContain('@clinic.example.test');
      expect(a.body.data[0].clinic.contactPhone).toBe('+966500000001');
      expect(JSON.stringify(a.body)).not.toContain('PRIVATE-ADMIN-NOTE');
      expect(a.body.data[0]).not.toHaveProperty('note');

      const b = await api.get('/platform/sales/me/clinics', repB.token).expect(200);
      expect(b.body.data.map((r: { clinic: { id: string } }) => r.clinic.id)).toEqual([clinicB1]);
      expect(JSON.stringify(b.body)).not.toContain(clinicA1);
    });

    it('profile counts are the caller’s own', async () => {
      const a = await api.get('/platform/sales/me', repA.token).expect(200);
      const b = await api.get('/platform/sales/me', repB.token).expect(200);
      expect(a.body).toMatchObject({ id: repA.userId, assignedCount: 2 });
      expect(b.body).toMatchObject({ id: repB.userId, assignedCount: 1 });
      for (const hidden of ['roles', 'invitationStatus', 'lastLoginAt', 'endedCount']) {
        expect(a.body).not.toHaveProperty(hidden);
      }
    });

    it('targets show progress but never the revision reasons or ids', async () => {
      const res = await api.get(`/platform/sales/me/targets?from=${CLOSED}&to=${CLOSED}`, repA.token).expect(200);
      const row = res.body.months[0].metrics.find((m: { metric: string }) => m.metric === 'new_clinics');
      expect(row).toMatchObject({ target: 2, achieved: 2, isCompleted: true });
      expect(JSON.stringify(res.body)).not.toContain('ADMIN-TARGET-REASON');
      for (const hidden of ['targetId', 'version', 'employeeId']) expect(row).not.toHaveProperty(hidden);

      const other = await api.get(`/platform/sales/me/targets?from=${CLOSED}&to=${CLOSED}`, repB.token).expect(200);
      const otherRow = other.body.months[0].metrics.find((m: { metric: string }) => m.metric === 'new_clinics');
      expect(otherRow.target).toBeNull();
    });

    it('bonuses show the approved record only: no void reason, no admin names, no voided record', async () => {
      const list = await api.get('/platform/sales/me/bonuses', repA.token).expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.data[0]).toMatchObject({ period: CLOSED, status: 'approved', amount: 500 });
      const prev = await api.get(`/platform/sales/me/bonus-preview?period=${CLOSED}`, repA.token).expect(200);
      expect(prev.body.items[0].record).toMatchObject({ status: 'approved' });
      const blob = JSON.stringify([list.body, prev.body]);
      for (const leak of ['ADMIN-VOID-REASON', 'voidReason', 'approvedBy', 'voidedBy', 'paidMarkedBy', 'voidedCount', 'E2E sa']) {
        expect(blob).not.toContain(leak);
      }
      expect((await api.get('/platform/sales/me/bonuses', repB.token).expect(200)).body.total).toBe(0);
    });
  });

  describe('POST /platform/sales/me/activities', () => {
    const body = (extra: object) => ({ type: 'visit', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), ...extra });

    it('logs against an owned clinic as source self, visible to the rep and (as self) to the admin', async () => {
      const res = await api.post('/platform/sales/me/activities', body({ tenantId: clinicA1, outcome: 'interested' }), repA.token).expect(201);
      expect(res.body).toMatchObject({ source: 'self', clinic: { id: clinicA1 } });
      expect(res.body).not.toHaveProperty('recordedBy');

      const mine = await api.get('/platform/sales/me/activities', repA.token).expect(200);
      expect(mine.body.data.map((a: { id: string }) => a.id)).toContain(res.body.id);
      const theirs = await api.get('/platform/sales/me/activities', repB.token).expect(200);
      expect(theirs.body.data.map((a: { id: string }) => a.id)).not.toContain(res.body.id);

      const adminView = await api.get(`/platform/sales/employees/${repA.userId}/activities`, admin.token).expect(200);
      const row = adminView.body.data.find((a: { id: string }) => a.id === res.body.id);
      expect(row).toMatchObject({ source: 'self', recordedBy: { id: repA.userId } });
    });

    it('a prospect needs no clinic', async () => {
      await api.post('/platform/sales/me/activities', body({ prospectName: 'Al Noor Polyclinic' }), repA.token).expect(201);
    });

    it('refuses a clinic owned by someone else, an unassigned clinic and a nonexistent one — identically', async () => {
      const refusals = await Promise.all(
        [clinicB1, unowned, randomUUID()].map((tenantId) =>
          api.post('/platform/sales/me/activities', body({ tenantId }), repA.token),
        ),
      );
      expect(refusals.map((r) => r.status)).toEqual([400, 400, 400]);
      expect(new Set(refusals.map((r) => JSON.stringify(r.body.message ?? r.body.error?.message))).size).toBe(1);
    });

    it('cannot pretend to be someone else: unknown fields are rejected', async () => {
      for (const extra of [{ salesUserId: repB.userId }, { source: 'admin_manual' }, { recordedBy: repB.userId }]) {
        await api.post('/platform/sales/me/activities', body({ prospectName: 'X', ...extra }), repA.token).expect(400);
      }
    });

    it('the future and ancient dates are still refused', async () => {
      await api.post('/platform/sales/me/activities', body({ prospectName: 'X', occurredAt: new Date(Date.now() + 86_400_000).toISOString() }), repA.token).expect(400);
      await api.post('/platform/sales/me/activities', body({ prospectName: 'X', occurredAt: new Date(Date.now() - 800 * 86_400_000).toISOString() }), repA.token).expect(400);
    });
  });

  // ───────────────────────── boundaries ─────────────────────────

  describe('who may call what', () => {
    const SELF_ROUTES = ['/platform/sales/me', '/platform/sales/me/clinics', '/platform/sales/me/targets', '/platform/sales/me/bonus-preview', '/platform/sales/me/bonuses', '/platform/sales/me/activities'];

    it.each(SELF_ROUTES)('%s: 401 without a token; 403 for super admin, support and a clinic owner', async (route) => {
      expect((await request(http()).get(`${API}${route}`)).status).toBe(401);
      for (const token of [admin.token, support.token, owner.token]) {
        expect((await api.get(route, token)).status).toBe(403);
      }
    });

    it('a rep has no way into any admin surface', async () => {
      const adminGets = [
        '/platform/staff',
        '/platform/sales/overview',
        '/platform/sales/employees',
        `/platform/sales/employees/${repA.userId}`,
        `/platform/sales/employees/${repA.userId}/clinics`,
        `/platform/sales/employees/${repB.userId}/targets`,
        `/platform/sales/employees/${repB.userId}/bonuses`,
        `/platform/sales/employees/${repB.userId}/activities`,
        `/platform/sales/employees/${repB.userId}/target-revisions`,
      ];
      for (const route of adminGets) expect((await api.get(route, repA.token)).status).toBe(403);
      await api.post(`/platform/sales/employees/${repA.userId}/activities`, { type: 'visit', occurredAt: new Date().toISOString(), prospectName: 'x' }, repA.token).expect(403);
      await api.put(`/platform/sales/employees/${repA.userId}/targets/2099-01/new_clinics`, { targetValue: 1000 }, repA.token).expect(403);
    });

    it('a rep has no tenant, so clinic-workspace APIs refuse them', async () => {
      for (const route of ['/appointments', '/customers', '/dashboard/summary']) {
        const status = (await api.get(route, repA.token)).status;
        expect([401, 403, 404]).toContain(status);
      }
    });
  });

  describe('session changes', () => {
    it('deactivating a rep ends access on the very next request, reactivating restores it', async () => {
      const rep = await platformUser(ROLE.PLATFORM_SALES, 'session');
      await api.get('/platform/sales/me', rep.token).expect(200);

      await api.patch(`/platform/staff/${rep.userId}/status`, { isActive: false }, admin.token).expect(200);
      expect([401, 403]).toContain((await api.get('/platform/sales/me', rep.token)).status);

      await api.patch(`/platform/staff/${rep.userId}/status`, { isActive: true }, admin.token).expect(200);
      await api.get('/platform/sales/me', rep.token).expect(200);
    });

    it('a user who loses the role loses the API at once', async () => {
      const rep = await platformUser(ROLE.PLATFORM_SALES, 'norole');
      await api.get('/platform/sales/me', rep.token).expect(200);
      await e2e.dataSource.query(`DELETE FROM user_roles WHERE "userId" = $1`, [rep.userId]);
      expect([401, 403]).toContain((await api.get('/platform/sales/me', rep.token)).status);
    });
  });
});
