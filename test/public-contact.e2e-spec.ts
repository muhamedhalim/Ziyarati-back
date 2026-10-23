/**
 * CR-05 - the public Contact Us form posts to `POST /public/contact`, which did not exist (every
 * lead was a 404). Real PostgreSQL, the real HTTP stack and the real migration-built table.
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

import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';

describe('POST /public/contact - website enquiries (CR-05) - real Postgres', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let superAdmin: { userId: string; token: string };
  const marker = `cr05-${randomUUID().slice(0, 8)}`;
  const email = `${marker}@prospect.test`;

  const http = () => request(e2e.app.getHttpServer());
  const body = (over: Record<string, unknown> = {}) => ({
    fullName: 'Layla Hassan',
    email,
    subject: 'demo',
    message: `${marker} We run three branches and want a demo.`,
    locale: 'ar',
    ...over,
  });
  const rows = () =>
    e2e.dataSource.query(`SELECT * FROM contact_leads WHERE email = $1 ORDER BY created_at`, [email]);

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'contact-owner');

    const role = await e2e.dataSource
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.SUPER_ADMIN })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error('Seeded super_admin role not found');
    const user = await e2e.dataSource.getRepository(User).save(
      e2e.dataSource.getRepository(User).create({
        tenant: undefined,
        email: `${marker}-sa@example.test`,
        full_name: `E2E ${marker}`,
        is_active: true,
      }),
    );
    await e2e.dataSource.getRepository(UserRole).save(
      e2e.dataSource
        .getRepository(UserRole)
        .create({ user: { id: user.id } as User, role: { id: role.id } as Role }),
    );
    const token = await e2e.jwt.signAsync(
      { sub: user.id, tenantId: null, type: 'access' },
      { secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'), expiresIn: '15m' },
    );
    superAdmin = { userId: user.id, token };
  }, 90_000);

  afterAll(async () => {
    await e2e.dataSource.query(`DELETE FROM contact_leads WHERE email = $1`, [email]).catch(() => undefined);
    if (superAdmin) {
      await e2e.dataSource
        .getRepository(UserRole)
        .delete({ user: { id: superAdmin.userId } })
        .catch(() => undefined);
      await e2e.dataSource.getRepository(User).delete({ id: superAdmin.userId }).catch(() => undefined);
    }
    if (owner) await cleanupTenant(e2e, owner.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 60_000);

  it('accepts an anonymous enquiry (no cookie, no token) and stores it', async () => {
    const res = await http().post(`${API}/public/contact`).send(body());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: true });

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      full_name: 'Layla Hassan',
      email,
      subject: 'demo',
      locale: 'ar',
      status: 'new',
    });
  });

  it('an immediate identical re-submit (double click) does not create a second lead', async () => {
    const res = await http().post(`${API}/public/contact`).send(body());
    expect(res.status).toBe(201);
    expect(await rows()).toHaveLength(1);
  });

  it('refuses an invalid enquiry with 400 and stores nothing', async () => {
    const before = (await rows()).length;
    for (const bad of [
      body({ email: 'nope' }),
      body({ message: 'short' }),
      body({ subject: 'spam' }),
      body({ status: 'handled' }), // mass-assignment of a server-owned field
    ]) {
      const res = await http().post(`${API}/public/contact`).send(bad);
      expect(res.status).toBe(400);
    }
    expect(await rows()).toHaveLength(before);
  });

  it('a clinic user with an auth cookie can still submit it (stale-cookie CSRF must not block the form)', async () => {
    const res = await http()
      .post(`${API}/public/contact`)
      .set('Cookie', [`access_token=${owner.token}`])
      .send(body({ message: `${marker} second enquiry from a signed-in clinic user` }));
    expect(res.status).toBe(201);
    expect(await rows()).toHaveLength(2);
  });

  it('the list is super-admin only', async () => {
    expect((await http().get(`${API}/platform/contact-leads`)).status).toBe(401);
    expect(
      (await http().get(`${API}/platform/contact-leads`).set(...authHeader(owner.token))).status,
    ).toBe(403);

    const res = await http().get(`${API}/platform/contact-leads?limit=100`).set(...authHeader(superAdmin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.filter((l: { email: string }) => l.email === email)).toHaveLength(2);
  });

  it('a super-admin can mark an enquiry handled; an unknown id is 404', async () => {
    const [row] = await rows();
    const ok = await http().post(`${API}/platform/contact-leads/${row.id}/handled`).set(...authHeader(superAdmin.token));
    expect([200, 201]).toContain(ok.status);
    expect((await rows())[0].status).toBe('handled');

    const missing = await http()
      .post(`${API}/platform/contact-leads/${randomUUID()}/handled`)
      .set(...authHeader(superAdmin.token));
    expect(missing.status).toBe(404);
  });
});
