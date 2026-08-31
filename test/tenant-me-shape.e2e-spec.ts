/**
 * `GET /tenants/me` and `GET /tenants/:id` — response shape + round-trip
 * count, against real Postgres.
 *
 * Phase P4 (015-db-api-efficiency-audit), T030. T028's consumer analysis
 * found no consumer of the `settings` sub-object these endpoints previously
 * returned (`TenantService.findById` loaded `relations: { settings: true }`
 * — 2 round trips, R-09). T029 dropped the relation. This suite is the
 * contract proof for that change:
 *
 *  1. The response no longer carries a `settings` key (the documented,
 *     accepted breaking delta — no live consumer reads it, see
 *     `specs/015-db-api-efficiency-audit/evidence/p4-t028-settings-consumer-analysis.md`).
 *  2. Every other field is unchanged.
 *  3. Tenant isolation on `GET /tenants/me` is unaffected — the id always
 *     comes from the caller's own JWT, never the request.
 *  4. `findById` now issues exactly ONE SQL statement (down from 2),
 *     measured with a real `QueryCounterLogger` swapped onto the app's own
 *     `DataSource` for the duration of a single direct service call — no
 *     guard-chain noise, no mocking of TypeORM itself.
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
import { QueryCounterLogger } from './perf/query-counter';

import { TenantService } from '../src/modules/tenant/tenant.service';
import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { RefreshToken } from '../src/entities/Auth&RBAC/RefreshToken';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';
const SUITE = `tms-${randomUUID().slice(0, 8)}`;

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

/** A platform-scope user (tenantId = NULL) holding the seeded `super_admin` role. */
async function createSuperAdmin(e2e: E2eApp, label: string) {
  const users = e2e.dataSource.getRepository(User);
  const roles = e2e.dataSource.getRepository(Role);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: ROLE.SUPER_ADMIN })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) {
    throw new Error(
      'Seeded system role "super_admin" not found — run the RBAC seed against the test database first.',
    );
  }

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

describe('GET /tenants/me and /tenants/:id — shape + round-trip (real Postgres)', () => {
  let e2e: E2eApp;
  let ownerA: OwnerFixture;
  let ownerB: OwnerFixture;
  let superAdmin: { userId: string; token: string };

  beforeAll(async () => {
    e2e = await createE2eApp();
    ownerA = await createOwnerFixture(e2e, `${SUITE}-a`);
    ownerB = await createOwnerFixture(e2e, `${SUITE}-b`);
    superAdmin = await createSuperAdmin(e2e, SUITE);
  }, 60_000);

  afterAll(async () => {
    if (!e2e) return;
    await cleanupTenant(e2e, ownerA.tenantId);
    await cleanupTenant(e2e, ownerB.tenantId);
    const ds = e2e.dataSource;
    await ds
      .getRepository(RefreshToken)
      .createQueryBuilder()
      .delete()
      .where('"userId" = :id', { id: superAdmin.userId })
      .execute()
      .catch(() => undefined);
    await ds
      .getRepository(UserRole)
      .createQueryBuilder()
      .delete()
      .where('"userId" = :id', { id: superAdmin.userId })
      .execute()
      .catch(() => undefined);
    await ds.getRepository(User).delete({ id: superAdmin.userId });
    await e2e.app.close();
  }, 30_000);

  const EXPECTED_KEYS = [
    'id',
    'name',
    'slug',
    'commercial_registration_number',
    'legal_name',
    'contact_email',
    'contact_phone',
    'logo_url',
    'country_id',
    'default_currency',
    'default_timezone',
    'approval_status',
    'is_active',
    'created_at',
    'updated_at',
    'deleted_at',
  ].sort();

  describe('GET /tenants/me', () => {
    it("returns the caller's own tenant with the settings sub-object dropped", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(res.body.id).toBe(ownerA.tenantId);
      expect(res.body).not.toHaveProperty('settings');
      expect(Object.keys(res.body).sort()).toEqual(EXPECTED_KEYS);
    });

    it('is scoped to the caller — owner B never receives owner A tenant data', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me`)
        .set(...authHeader(ownerB.token))
        .expect(200);

      expect(res.body.id).toBe(ownerB.tenantId);
      expect(res.body.id).not.toBe(ownerA.tenantId);
    });
  });

  describe('GET /tenants/:id (super_admin)', () => {
    it('returns the requested tenant with the settings sub-object dropped', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/${ownerA.tenantId}`)
        .set(...authHeader(superAdmin.token))
        .expect(200);

      expect(res.body.id).toBe(ownerA.tenantId);
      expect(res.body).not.toHaveProperty('settings');
      expect(Object.keys(res.body).sort()).toEqual(EXPECTED_KEYS);
    });

    it('a clinic owner cannot call it (SUPER_ADMIN only, unchanged)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/${ownerB.tenantId}`)
        .set(...authHeader(ownerA.token))
        .expect(403);
    });
  });

  describe('round-trip count', () => {
    it('TenantService.findById issues exactly one SQL statement', async () => {
      const tenantService = e2e.app.get(TenantService);
      const counter = new QueryCounterLogger();
      const original = e2e.dataSource.logger;
      e2e.dataSource.logger = counter;
      try {
        const tenant = await tenantService.findById(ownerA.tenantId);
        expect(tenant.id).toBe(ownerA.tenantId);
      } finally {
        e2e.dataSource.logger = original;
      }

      expect(counter.count).toBe(1);
    });
  });
});
