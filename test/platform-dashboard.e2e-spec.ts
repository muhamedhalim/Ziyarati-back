/**
 * HTTP e2e for the Platform Control Center (`/platform/dashboard`).
 *
 * Boots the REAL AppModule against the real dev Postgres so the whole guard
 * chain runs exactly as it does in production. Two things are asserted that a
 * unit test structurally cannot:
 *
 *  1. **Authorization at the edge.** Only `super_admin` reaches these routes.
 *     A clinic owner, a platform-support agent and an anonymous caller must all
 *     be refused — by the server, not by a hidden button.
 *  2. **Nothing sensitive escapes.** The responses are scanned, as serialized
 *     text, for the field names that must never appear: clinic contact details,
 *     integration credentials, raw audit payloads, operator IPs.
 *
 * DATABASE ISOLATION: this suite is READ-ONLY apart from the platform users it
 * creates for the authorization checks, which `afterAll` removes.
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

import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { RefreshToken } from '../src/entities/Auth&RBAC/RefreshToken';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';
const BASE = `${API}/platform/dashboard`;

const ROUTES = [
  `${BASE}/snapshot`,
  `${BASE}/summary?range=30d`,
  `${BASE}/alerts`,
  `${BASE}/activity?range=30d&limit=5`,
];

/**
 * Field names that must never reach this surface.
 *
 * Asserted on the serialized response rather than a typed shape on purpose: a
 * leak is usually an accidentally-widened `SELECT *` or a relation eagerly
 * loaded by a future change, and both slip past a structural check while the
 * raw text still names the column.
 */
const FORBIDDEN_FIELDS = [
  'contact_email',
  'contact_phone',
  'commercial_registration_number',
  'legal_name',
  'access_token',
  'waba_id',
  'phone_number_id',
  'old_values',
  'new_values',
  'ip_address',
  'key_hash',
  'password',
];

async function mintTokenFor(
  e2e: E2eApp,
  userId: string,
  tenantId: string | null,
): Promise<string> {
  return e2e.jwt.signAsync(
    { sub: userId, tenantId, type: 'access' },
    {
      secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: '15m',
    },
  );
}

/** A platform-scope user (tenantId = NULL) holding the given SEEDED global role. */
async function createPlatformActor(e2e: E2eApp, roleSlug: string, label: string) {
  const users = e2e.dataSource.getRepository(User);
  const roles = e2e.dataSource.getRepository(Role);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: roleSlug })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) throw new Error(`Seeded platform role "${roleSlug}" not found`);

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
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

  return { userId: user.id, token: await mintTokenFor(e2e, user.id, null) };
}

describe('Platform Control Center (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let superAdmin: { userId: string; token: string };
  let platformSupport: { userId: string; token: string };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'dash-owner');
    superAdmin = await createPlatformActor(e2e, ROLE.SUPER_ADMIN, 'dash-sa');
    platformSupport = await createPlatformActor(
      e2e,
      ROLE.PLATFORM_SUPPORT,
      'dash-cs',
    );
    createdUserIds.push(superAdmin.userId, platformSupport.userId);
  }, 60_000);

  afterAll(async () => {
    if (!e2e) return;
    const ds = e2e.dataSource;
    await ds
      .getRepository(RefreshToken)
      .createQueryBuilder()
      .delete()
      .where('"userId" IN (:...ids)', { ids: createdUserIds })
      .execute()
      .catch(() => undefined);
    await ds
      .getRepository(UserRole)
      .createQueryBuilder()
      .delete()
      .where('"userId" IN (:...ids)', { ids: createdUserIds })
      .execute()
      .catch(() => undefined);
    await ds
      .getRepository(User)
      .createQueryBuilder()
      .delete()
      .where('id IN (:...ids)', { ids: createdUserIds })
      .execute()
      .catch(() => undefined);
    await e2e.app.close();
  }, 60_000);

  // ───────────────────────────── Authorization ──────────────────────────── //

  describe('authorization', () => {
    it.each(ROUTES)('super_admin may read %s', async (route) => {
      await request(e2e.app.getHttpServer())
        .get(route)
        .set(...authHeader(superAdmin.token))
        .expect(200);
    });

    it.each(ROUTES)('a clinic owner is refused %s', async (route) => {
      await request(e2e.app.getHttpServer()).get(route).set(...authHeader(owner.token)).expect(403);
    });

    it.each(ROUTES)('a platform-support agent is refused %s', async (route) => {
      // Support Desk is a separate console with its own permission family; it
      // has no business reading platform-wide financials.
      await request(e2e.app.getHttpServer())
        .get(route)
        .set(...authHeader(platformSupport.token))
        .expect(403);
    });

    it.each(ROUTES)('an anonymous caller is refused %s', async (route) => {
      await request(e2e.app.getHttpServer()).get(route).expect(401);
    });
  });

  // ───────────────────────────── Data contract ──────────────────────────── //

  describe('snapshot', () => {
    it('returns exact platform-wide lifecycle counts, with each state separate', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${BASE}/snapshot`)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      const { tenants, subscriptions } = res.body;
      for (const key of [
        'total',
        'approved',
        'pendingVerification',
        'pendingApproval',
        'suspended',
        'rejected',
        'active',
      ]) {
        expect(typeof tenants[key]).toBe('number');
      }

      // Counted per tenant, so the distribution must account for every clinic.
      const distributionTotal = Object.values(
        subscriptions.counts as Record<string, number>,
      ).reduce((a, b) => a + b, 0);
      expect(distributionTotal).toBe(tenants.total);

      expect(res.body.timezone).toBe('UTC');
    });

    it('reports advisory MRR without a currency, because plans carry none', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${BASE}/snapshot`)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      expect(res.body.advisoryMrr.currency).toBeNull();
      expect(res.body.advisoryMrr.note).toBe('contracted-plan-value');
    });
  });

  describe('summary', () => {
    it('uses half-open UTC windows with an equal-length comparison period', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${BASE}/summary?range=7d`)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      const r = res.body.range;
      expect(r.timezone).toBe('UTC');
      const span = Date.parse(r.to) - Date.parse(r.from);
      const prevSpan = Date.parse(r.previousTo) - Date.parse(r.previousFrom);
      expect(prevSpan).toBe(span);
      // No overlap and no gap between the windows.
      expect(Date.parse(r.previousTo)).toBe(Date.parse(r.from));
    });

    it('never fabricates a percentage against a zero denominator', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${BASE}/summary?range=30d`)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      for (const metric of Object.values(res.body.metrics) as {
        previous: number;
        percent: number | null;
        state: string;
      }[]) {
        if (metric.previous === 0) expect(metric.percent).toBeNull();
        expect(['changed', 'new', 'none', 'no-baseline']).toContain(metric.state);
      }
    });

    it('rejects a range beyond the documented ceiling', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${BASE}/summary?from=2020-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`)
        .set(...authHeader(superAdmin.token))
        .expect(400);
    });

    it('rejects an unknown range preset rather than silently defaulting', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${BASE}/summary?range=all-time`)
        .set(...authHeader(superAdmin.token))
        .expect(400);
    });
  });

  describe('alerts', () => {
    it('emits codes and params, never backend-composed prose', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${BASE}/alerts`)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      expect(Array.isArray(res.body.alerts)).toBe(true);
      // Bounded so one noisy category cannot make this the slowest screen.
      expect(res.body.alerts.length).toBeLessThanOrEqual(50);

      for (const alert of res.body.alerts) {
        expect(alert.code).toMatch(/^[A-Z][A-Z_]*$/);
        expect(alert).not.toHaveProperty('message');
        expect(alert.cta.route).toMatch(/^\/platform\//);
        expect(['critical', 'warning', 'info']).toContain(alert.severity);
      }
    });
  });

  // ───────────────────────────── Disclosure ─────────────────────────────── //

  describe('sensitive fields never appear', () => {
    it.each(ROUTES)('%s exposes no PII, credential or raw audit payload', async (route) => {
      const res = await request(e2e.app.getHttpServer())
        .get(route)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      const serialized = JSON.stringify(res.body);
      for (const field of FORBIDDEN_FIELDS) {
        expect(serialized).not.toContain(field);
      }
    });

    it('activity exposes an actor display name only', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${BASE}/activity?range=90d&limit=10`)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      for (const item of res.body.items) {
        expect(Object.keys(item.actor)).toEqual(['displayName']);
      }
    });
  });
});
