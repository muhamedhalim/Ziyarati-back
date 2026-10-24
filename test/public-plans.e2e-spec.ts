/**
 * `/platform/subscriptions` -> `/pricing` link, proven end to end on real
 * PostgreSQL.
 *
 * Every plan here is created / edited / activated / deactivated through the
 * SAME super-admin HTTP routes the admin page calls
 * (`/platform/billing/plans...`) and then observed through the anonymous
 * `GET /public/plans` the pricing page reads — never by writing the table
 * directly, so a break anywhere between the admin action and the public
 * response fails here.
 *
 * The public catalogue is compared to the database's own `is_active` rows
 * (not to a hand-written expectation), so the assertion "only active plans
 * are exposed" holds whatever else already lives in the e2e database.
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
import {
  createSubscribedOwnerFixture,
  setPaidMode,
  resetBillingMode,
  cleanupSubscriptionFixture,
  type SubscribedOwnerFixture,
} from './utils/subscription-e2e-fixtures';

import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';

interface PublicPlanRow {
  id: string;
  name: string;
  price: string;
  billingCycle: string;
  isCustom: boolean;
  limits: Array<{ key: string; value: number | null }>;
  features: unknown[];
}

describe('Public plan catalogue follows /platform/subscriptions — real Postgres', () => {
  let e2e: E2eApp;
  let superAdmin: { userId: string; token: string };
  let owner: OwnerFixture;
  let subscribed: SubscribedOwnerFixture;
  const createdUserIds: string[] = [];
  const createdPlanIds: string[] = [];

  const http = () => request(e2e.app.getHttpServer());

  beforeAll(async () => {
    e2e = await createE2eApp();
    await setPaidMode(e2e);
    superAdmin = await createSuperAdmin();
    createdUserIds.push(superAdmin.userId);
    owner = await createOwnerFixture(e2e, 'public-plans-owner');
    subscribed = await createSubscribedOwnerFixture(e2e, 'public-plans-sub');
  }, 90_000);

  afterAll(async () => {
    if (!e2e) return;
    if (subscribed) {
      await cleanupSubscriptionFixture(
        e2e,
        subscribed.tenantId,
        subscribed.planId,
      ).catch(() => undefined);
      await cleanupTenant(e2e, subscribed.tenantId).catch(() => undefined);
    }
    if (owner) await cleanupTenant(e2e, owner.tenantId).catch(() => undefined);
    if (createdPlanIds.length) {
      await e2e.dataSource
        .query(`DELETE FROM subscription_plans WHERE id = ANY($1)`, [
          createdPlanIds,
        ])
        .catch(() => undefined);
    }
    if (createdUserIds.length) {
      await e2e.dataSource
        .query(`DELETE FROM user_roles WHERE "userId" = ANY($1)`, [
          createdUserIds,
        ])
        .catch(() => undefined);
      await e2e.dataSource
        .query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds])
        .catch(() => undefined);
    }
    await resetBillingMode(e2e);
    await e2e.app.close();
  }, 60_000);

  // ───────────────────────────── helpers ──────────────────────────────── //

  async function createSuperAdmin() {
    const users = e2e.dataSource.getRepository(User);
    const roles = e2e.dataSource.getRepository(Role);
    const userRoles = e2e.dataSource.getRepository(UserRole);
    const role = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.SUPER_ADMIN })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error('Seeded super_admin role not found');
    const suffix = `pp-sa-${randomUUID().slice(0, 8)}`;
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `${suffix}@example.test`,
        full_name: `E2E ${suffix}`,
        is_active: true,
      }),
    );
    await userRoles.save(
      userRoles.create({
        user: { id: user.id } as User,
        role: { id: role.id } as Role,
      }),
    );
    const token = await e2e.jwt.signAsync(
      { sub: user.id, tenantId: null, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );
    return { userId: user.id, token };
  }

  const uniq = (label: string) => `E2E ${label} ${randomUUID().slice(0, 8)}`;

  async function adminCreatePlan(body: Record<string, unknown>) {
    const res = await http()
      .post(`${API}/platform/billing/plans`)
      .set(...authHeader(superAdmin.token))
      .send(body);
    expect([200, 201]).toContain(res.status);
    const id = (res.body.data ?? res.body).id as string;
    createdPlanIds.push(id);
    return id;
  }

  const adminPatch = (id: string, body: Record<string, unknown>) =>
    http()
      .patch(`${API}/platform/billing/plans/${id}`)
      .set(...authHeader(superAdmin.token))
      .send(body);

  const adminToggle = (id: string, action: 'activate' | 'deactivate') =>
    http()
      .post(`${API}/platform/billing/plans/${id}/${action}`)
      .set(...authHeader(superAdmin.token));

  async function publicCatalog() {
    const res = await http().get(`${API}/public/plans`);
    expect(res.status).toBe(200);
    const data = (res.body.data ?? res.body) as {
      currency: string;
      plans: PublicPlanRow[];
    };
    return { res, ...data };
  }

  const publicPlan = async (id: string) =>
    (await publicCatalog()).plans.find((p) => p.id === id);

  // ───────────────────────────── scenarios ────────────────────────────── //

  it('1. a plan created active appears, with the stored name, price, cycle and limits', async () => {
    const name = uniq('Active');
    const id = await adminCreatePlan({
      name,
      price: 149.5,
      billingCycle: 'MONTHLY',
      maxUsers: 12,
      isActive: true,
    });

    const p = await publicPlan(id);
    expect(p).toBeDefined();
    expect(p).toMatchObject({
      name,
      price: '149.50',
      billingCycle: 'MONTHLY',
      isCustom: false,
    });
    expect(p!.limits).toContainEqual({ key: 'maxUsers', value: 12 });
  });

  it('2. a plan created disabled does not appear', async () => {
    const id = await adminCreatePlan({
      name: uniq('Hidden'),
      price: 10,
      billingCycle: 'MONTHLY',
      isActive: false,
    });
    expect(await publicPlan(id)).toBeUndefined();
  });

  it('3 + 4. enabling shows it, disabling removes it again — and the row is never deleted', async () => {
    const id = await adminCreatePlan({
      name: uniq('Toggle'),
      price: 20,
      billingCycle: 'YEARLY',
      isActive: false,
    });
    expect(await publicPlan(id)).toBeUndefined();

    expect((await adminToggle(id, 'activate')).status).toBe(200);
    expect((await publicPlan(id))?.billingCycle).toBe('YEARLY');

    expect((await adminToggle(id, 'deactivate')).status).toBe(200);
    expect(await publicPlan(id)).toBeUndefined();

    const rows = await e2e.dataSource.query(
      `SELECT is_active FROM subscription_plans WHERE id = $1`,
      [id],
    );
    expect(rows).toEqual([{ is_active: false }]);
  });

  it('5. editing name, price and limits is reflected on the next request', async () => {
    const id = await adminCreatePlan({
      name: uniq('Before'),
      price: 30,
      billingCycle: 'MONTHLY',
      maxBranches: 1,
    });
    const renamed = uniq('After');

    const res = await adminPatch(id, {
      name: renamed,
      price: 45.25,
      maxBranches: 4,
    });
    expect(res.status).toBe(200);

    const p = await publicPlan(id);
    expect(p).toMatchObject({ name: renamed, price: '45.25' });
    expect(p!.limits).toContainEqual({ key: 'maxBranches', value: 4 });
  });

  it('6. the public list is exactly the active rows in the database, and never exposes disabled ones — even by id', async () => {
    const hiddenId = await adminCreatePlan({
      name: uniq('Direct'),
      price: 5,
      billingCycle: 'MONTHLY',
      isActive: false,
    });

    const { plans } = await publicCatalog();
    const dbActive = await e2e.dataSource.query(
      `SELECT id FROM subscription_plans WHERE is_active = true`,
    );
    expect(plans.map((p) => p.id).sort()).toEqual(
      dbActive.map((r: { id: string }) => r.id).sort(),
    );
    expect(plans.map((p) => p.id)).not.toContain(hiddenId);

    // No per-plan public route exists to fetch a disabled plan directly.
    expect((await http().get(`${API}/public/plans/${hiddenId}`)).status).toBe(
      404,
    );
  });

  it('6b. exposes no internal or financial field', async () => {
    await adminCreatePlan({
      name: uniq('Shape'),
      price: 7,
      billingCycle: 'MONTHLY',
    });
    const { res } = await publicCatalog();
    const json = JSON.stringify(res.body);
    for (const forbidden of [
      'is_active',
      'isActive',
      'is_in_use',
      'limit_declarations',
      'limitDeclarations',
      'tenantId',
      'subscriber',
      'invoice',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('6c. needs no credentials and cannot be written to', async () => {
    expect((await http().get(`${API}/public/plans`)).status).toBe(200);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await http()
        [method](`${API}/public/plans`)
        .send({ name: 'x' });
      expect([404, 405]).toContain(res.status);
    }
  });

  it('7. disabling a plan leaves existing subscriptions, their plan and access untouched', async () => {
    expect((await adminToggle(subscribed.planId, 'deactivate')).status).toBe(
      200,
    );
    expect(await publicPlan(subscribed.planId)).toBeUndefined();

    const current = await http()
      .get(`${API}/subscriptions/current`)
      .set(...authHeader(subscribed.token));
    expect(current.status).toBe(200);
    const view = current.body.data ?? current.body;
    expect(view.subscription.status).toBe('ACTIVE');
    expect(view.subscription.plan.id).toBe(subscribed.planId);
    expect(view.isUsable).toBe(true);

    const rows = await e2e.dataSource.query(
      `SELECT status FROM subscriptions WHERE id = $1 AND deleted_at IS NULL`,
      [subscribed.subscriptionId],
    );
    expect(rows).toEqual([{ status: 'ACTIVE' }]);
  });

  it('8. an active plan can still be subscribed to; a deactivated one is refused for new purchases', async () => {
    const activeId = await adminCreatePlan({
      name: uniq('Buyable'),
      price: 0,
      billingCycle: 'MONTHLY',
      isActive: true,
    });
    const inactiveId = await adminCreatePlan({
      name: uniq('Retired'),
      price: 0,
      billingCycle: 'MONTHLY',
      isActive: false,
    });

    const refused = await http()
      .post(`${API}/subscriptions`)
      .set(...authHeader(owner.token))
      .send({ planId: inactiveId });
    expect(refused.status).toBe(422);

    const accepted = await http()
      .post(`${API}/subscriptions`)
      .set(...authHeader(owner.token))
      .send({ planId: activeId });
    expect([200, 201]).toContain(accepted.status);

    await e2e.dataSource.query(
      `DELETE FROM subscription_usage WHERE tenant_id = $1`,
      [owner.tenantId],
    );
    // `subscription_invoices` keys on a plain varchar `tenant_id` (baseline migration) — it has NO
    // "tenantId" column. This used to name the wrong column AND swallow the resulting error, so the
    // invoice was never deleted here and every run logged `column "tenantId" does not exist`.
    await e2e.dataSource.query(
      `DELETE FROM subscription_invoices WHERE tenant_id = $1`,
      [owner.tenantId],
    );
    await e2e.dataSource.query(
      `DELETE FROM subscriptions WHERE "tenantId" = $1`,
      [owner.tenantId],
    );
  });

  it('10. only the super admin can create, edit, activate or deactivate plans', async () => {
    const id = await adminCreatePlan({
      name: uniq('Guarded'),
      price: 50,
      billingCycle: 'MONTHLY',
      isActive: false,
    });

    const attempts: Array<[string, () => request.Test]> = [
      [
        'create',
        () =>
          http()
            .post(`${API}/platform/billing/plans`)
            .send({ name: 'x', price: 1, billingCycle: 'MONTHLY' }),
      ],
      [
        'edit price',
        () =>
          http()
            .patch(`${API}/platform/billing/plans/${id}`)
            .send({ price: 1 }),
      ],
      [
        'activate',
        () => http().post(`${API}/platform/billing/plans/${id}/activate`),
      ],
      [
        'deactivate',
        () => http().post(`${API}/platform/billing/plans/${id}/deactivate`),
      ],
    ];

    for (const [label, build] of attempts) {
      const anonymous = await build();
      expect([label, anonymous.status]).toEqual([label, 401]);

      const asClinicOwner = await build().set(...authHeader(owner.token));
      expect([label, asClinicOwner.status]).toEqual([label, 403]);
    }

    // None of the refused attempts changed anything.
    expect(await publicPlan(id)).toBeUndefined();
    const rows = await e2e.dataSource.query(
      `SELECT price, is_active FROM subscription_plans WHERE id = $1`,
      [id],
    );
    expect(rows).toEqual([{ price: '50.00', is_active: false }]);
  });
});
