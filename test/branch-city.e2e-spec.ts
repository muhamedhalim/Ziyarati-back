/**
 * Branch city / location — over real HTTP against real Postgres.
 *
 * WHAT THIS PINS
 *  1. `city` (free text, any language) is find-or-created in the shared
 *     `cities` lookup and persisted as the branch's EXISTING `city_id` — no
 *     parallel column, no duplicate city row per spelling.
 *  2. The same data the admin writes is what the PUBLIC booking site reads
 *     (`/public/discovery/cities` and the marketplace clinic projection), so
 *     the booking frontend needs no city list of its own.
 *  3. Validation (trim / empty / length / ambiguous / unknown id), authorization
 *     (`branches.update` / `branches.create`), and tenant isolation (clinic B can
 *     neither read nor change clinic A's branch, and cannot pick the tenant).
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

import { Role } from '../src/entities/Auth&RBAC/Role';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';
const SUITE = randomUUID().slice(0, 8);

describe('Branch city / location (e2e)', () => {
  let e2e: E2eApp;
  let ownerA: OwnerFixture;
  let ownerB: OwnerFixture;
  let receptionistToken: string;
  let mainBranchId: string;
  const cityNames = {
    en: `E2E Cityville ${SUITE}`,
    edited: `E2E Otherton ${SUITE}`,
    ar: `مدينة الاختبار ${SUITE}`,
  };

  const q = (sql: string, params: unknown[] = []) =>
    e2e.dataSource.query(sql, params);

  beforeAll(async () => {
    e2e = await createE2eApp();
    ownerA = await createOwnerFixture(e2e, 'citya');
    ownerB = await createOwnerFixture(e2e, 'cityb');

    // Clinic A: publicly bookable (so the marketplace can see it) and with a
    // non-default timezone, to prove new branches inherit it.
    await e2e.dataSource.getRepository(TenantSetting).save(
      e2e.dataSource.getRepository(TenantSetting).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        public_booking_enabled: true,
      }),
    );
    await q(`UPDATE tenants SET default_timezone = 'Africa/Cairo' WHERE id = $1`, [
      ownerA.tenantId,
    ]);

    const role = await e2e.dataSource
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.RECEPTIONIST })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error('Seeded receptionist role not found');
    const user = await e2e.dataSource.getRepository(User).save(
      e2e.dataSource.getRepository(User).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        email: `recep-${SUITE}@example.test`,
        full_name: 'Receptionist',
        is_active: true,
      }),
    );
    await e2e.dataSource.getRepository(UserRole).save(
      e2e.dataSource.getRepository(UserRole).create({
        user: { id: user.id } as User,
        role: { id: role.id } as Role,
      }),
    );
    receptionistToken = await e2e.jwt.signAsync(
      { sub: user.id, tenantId: ownerA.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
        expiresIn: '15m',
      },
    );
  }, 60_000);

  afterAll(async () => {
    for (const o of [ownerA, ownerB]) {
      if (!o) continue;
      await q(`DELETE FROM branches WHERE "tenantId" = $1`, [o.tenantId]);
      await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [o.tenantId]);
      await cleanupTenant(e2e, o.tenantId);
    }
    await q(`DELETE FROM cities WHERE name_en = ANY($1) OR name_ar = ANY($1)`, [
      Object.values(cityNames),
    ]);
    await e2e?.app.close();
  });

  const post = (token: string, body: object) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/branches`)
      .set(...authHeader(token))
      .send(body);
  const patch = (token: string, id: string, body: object) =>
    request(e2e.app.getHttpServer())
      .patch(`${API}/branches/${id}`)
      .set(...authHeader(token))
      .send(body);
  const list = (token: string) =>
    request(e2e.app.getHttpServer())
      .get(`${API}/branches`)
      .set(...authHeader(token));

  describe('create', () => {
    it('persists the typed city as the branch city_id and returns it resolved', async () => {
      const res = await post(ownerA.token, {
        name: 'Main Branch',
        city: `  ${cityNames.en}  `,
      }).expect(201);
      mainBranchId = res.body.id;

      expect(res.body.city).toMatchObject({ name_en: cityNames.en, name_ar: null });
      expect(res.body.city_id).toBe(res.body.city.id);
      // Inherits the clinic's own timezone now that the form no longer asks.
      expect(res.body.timezone).toBe('Africa/Cairo');
      const [row] = await q(`SELECT city_id FROM branches WHERE id = $1`, [mainBranchId]);
      expect(row.city_id).toBe(res.body.city.id);
    });

    it('reuses the same city row for the same name in any case — one city, not one per spelling', async () => {
      const first = await list(ownerA.token).expect(200);
      const cityId = first.body[0].city_id;
      const res = await post(ownerA.token, {
        name: 'Second',
        city: cityNames.en.toUpperCase(),
      }).expect(201);
      expect(res.body.city_id).toBe(cityId);
      const rows = await q(`SELECT id FROM cities WHERE LOWER(name_en) = LOWER($1)`, [
        cityNames.en,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('stores an Arabic city in name_ar', async () => {
      const res = await post(ownerA.token, { name: 'Arabic', city: cityNames.ar }).expect(201);
      expect(res.body.city).toMatchObject({ name_ar: cityNames.ar, name_en: null });
    });

    it('still accepts a branch with no city (API back-compat: city is optional there)', async () => {
      const res = await post(ownerA.token, { name: 'No city' }).expect(201);
      expect(res.body.city).toBeNull();
    });

    it.each([
      ['blank', { city: '   ' }],
      ['empty', { city: '' }],
      ['over 100 characters', { city: 'x'.repeat(101) }],
      ['both city and cityId', { city: 'Riyadh', cityId: randomUUID() }],
      ['an unknown cityId', { cityId: randomUUID() }],
      ['a tenantId (never client-selectable)', { city: 'Riyadh', tenantId: randomUUID() }],
    ])('rejects %s with 400 and creates nothing', async (_label, extra) => {
      const before = (await list(ownerA.token)).body.length;
      await post(ownerA.token, { name: 'Bad', ...extra }).expect(400);
      expect((await list(ownerA.token)).body.length).toBe(before);
    });
  });

  describe('update location', () => {
    it('changes only the city and keeps every other field', async () => {
      const res = await patch(ownerA.token, mainBranchId, { city: cityNames.edited }).expect(200);
      expect(res.body.name).toBe('Main Branch');
      expect(res.body.timezone).toBe('Africa/Cairo');
      expect(res.body.city.name_en).toBe(cityNames.edited);
    });

    it('a partial update without a city leaves the city alone', async () => {
      const res = await patch(ownerA.token, mainBranchId, { isActive: true }).expect(200);
      expect(res.body.city.name_en).toBe(cityNames.edited);
    });

    it('rejects a blank city instead of clearing it', async () => {
      await patch(ownerA.token, mainBranchId, { city: '  ' }).expect(400);
      const after = await list(ownerA.token).expect(200);
      expect(after.body.find((b: { id: string }) => b.id === mainBranchId).city.name_en).toBe(
        cityNames.edited,
      );
    });
  });

  describe('authorization', () => {
    it('a receptionist (no branches.update) cannot change a location — 403', async () => {
      await patch(receptionistToken, mainBranchId, { city: 'Hacked' }).expect(403);
      const [row] = await q(
        `SELECT c.name_en FROM branches b JOIN cities c ON c.id = b.city_id WHERE b.id = $1`,
        [mainBranchId],
      );
      expect(row.name_en).toBe(cityNames.edited);
    });

    it('a receptionist cannot create a branch — 403', async () => {
      await post(receptionistToken, { name: 'X', city: 'Y' }).expect(403);
    });

    it('unauthenticated callers are rejected — 401', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/branches/${mainBranchId}`)
        .send({ city: 'Z' })
        .expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("clinic B cannot change clinic A's branch location (404, nothing written)", async () => {
      await patch(ownerB.token, mainBranchId, { city: 'Stolen' }).expect(404);
      const [row] = await q(
        `SELECT c.name_en FROM branches b JOIN cities c ON c.id = b.city_id WHERE b.id = $1`,
        [mainBranchId],
      );
      expect(row.name_en).toBe(cityNames.edited);
    });

    it("clinic B cannot read clinic A's branch, and its own list never contains it", async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/branches/${mainBranchId}`)
        .set(...authHeader(ownerB.token))
        .expect(404);
      const mine = await list(ownerB.token).expect(200);
      expect(mine.body.map((b: { id: string }) => b.id)).not.toContain(mainBranchId);
    });

    it('a branch created by clinic B belongs to clinic B regardless of what it sends', async () => {
      const res = await post(ownerB.token, { name: 'B Branch', city: cityNames.en }).expect(201);
      const [row] = await q(`SELECT "tenantId" FROM branches WHERE id = $1`, [res.body.id]);
      expect(row.tenantId).toBe(ownerB.tenantId);
    });
  });

  describe('booking-site synchronisation (source of truth = the same branches.city_id)', () => {
    it('the new city appears in /public/discovery/cities with no separate list to maintain', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/cities`)
        .expect(200);
      const names = res.body.map((c: { nameEn: string | null }) => c.nameEn);
      expect(names).toContain(cityNames.edited);
      // The "Second" branch still sits in the original city, so it stays listed —
      // exactly once: one city row per city, however many branches or spellings.
      expect(names.filter((n: string | null) => n === cityNames.en)).toHaveLength(1);
    });

    it('the marketplace clinic projection carries each branch city; an edit shows on the next read', async () => {
      const [{ slug }] = await q(`SELECT slug FROM tenants WHERE id = $1`, [ownerA.tenantId]);
      const read = () =>
        request(e2e.app.getHttpServer())
          .get(`${API}/public/discovery/marketplace/clinics/${slug}`)
          .expect(200);

      const before = await read();
      const main = before.body.branches.items.find((b: { id: string }) => b.id === mainBranchId);
      expect(main.city.nameEn).toBe(cityNames.edited);
      expect(
        before.body.branches.items.some(
          (b: { city: { nameAr: string | null } | null }) => b.city?.nameAr === cityNames.ar,
        ),
      ).toBe(true);

      await patch(ownerA.token, mainBranchId, { city: cityNames.en }).expect(200);
      const after = await read();
      expect(
        after.body.branches.items.find((b: { id: string }) => b.id === mainBranchId).city.nameEn,
      ).toBe(cityNames.en);
    });
  });
});
