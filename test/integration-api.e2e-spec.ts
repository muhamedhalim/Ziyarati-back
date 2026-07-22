/**
 * HTTP e2e for Phase 1 of the external integration API + the hardened API-key
 * flow. Boots the REAL AppModule (see whatsapp-e2e-app.ts's createE2eApp) so
 * the guard chain (ThrottlerGuard -> JwtAuthGuard -> CsrfGuard ->
 * MaintenanceGuard -> ... -> ActiveTenantGuard -> IntegrationScopeGuard) runs
 * exactly as it does in production.
 *
 * DATABASE ISOLATION: every fixture is scoped under a freshly-created Tenant
 * (unique per test), and cleanupIntegrationTenant deletes every row it
 * created, in FK-safe order, in afterAll.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Permission } from '../src/entities/Auth&RBAC/Permission';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../src/entities/Auth&RBAC/RolePermission';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { AuditLog } from '../src/entities/Auth&RBAC/AuditLog';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Service } from '../src/entities/Services/Service';
import { Customer } from '../src/entities/CRM/Customer';
import { PERMISSION } from '../src/rbac/rbac.constants';
import { TenantApprovalStatus } from '../src/entities/enums';
import { SystemSettingService } from '../src/modules/platform/system-setting.service';
import { SettingKey } from '../src/modules/platform/settings.registry';

const API = '/api/v1';

interface ActorFixture {
  userId: string;
  token: string;
}

/** A tenant-scoped user whose role carries EXACTLY the given permission slugs. */
async function createLimitedActor(
  e2e: E2eApp,
  tenantId: string,
  slugs: string[],
  label: string,
): Promise<ActorFixture> {
  const permissions = e2e.dataSource.getRepository(Permission);
  const roles = e2e.dataSource.getRepository(Role);
  const rolePermissions = e2e.dataSource.getRepository(RolePermission);
  const users = e2e.dataSource.getRepository(User);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const perms = await permissions
    .createQueryBuilder('p')
    .where('p.slug IN (:...slugs)', { slugs })
    .getMany();
  if (perms.length !== slugs.length) {
    throw new Error(`Seeded permissions missing for: ${slugs.join(', ')} — run the RBAC seed first.`);
  }

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const role = await roles.save(
    roles.create({ tenant: { id: tenantId } as Tenant, name: `Limited ${suffix}`, slug: `limited-${suffix}`, is_system: false }),
  );
  await rolePermissions.save(perms.map((p) => rolePermissions.create({ role, permission: p })));

  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as Tenant,
      email: `${suffix}@example.test`,
      full_name: `Limited ${suffix}`,
      is_active: true,
    }),
  );
  await userRoles.save(userRoles.create({ user: { id: user.id } as User, role: { id: role.id } as Role }));

  const token = await e2e.jwt.signAsync(
    { sub: user.id, tenantId, type: 'access' },
    { secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'), expiresIn: '15m' },
  );
  return { userId: user.id, token };
}

/** FK-safe cleanup for everything this suite creates, before handing off to the shared tenant cleanup. */
async function cleanupIntegrationTenant(e2e: E2eApp, tenantId: string): Promise<void> {
  const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
  await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM api_keys WHERE "tenantId" = $1`);
  await q(`DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`);
  await q(`DELETE FROM roles WHERE "tenantId" = $1`);
  await q(`DELETE FROM services WHERE "tenantId" = $1`);
  await cleanupTenant(e2e, tenantId);
}

describe('Integration API + API-key hardening — HTTP e2e', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let serviceId: string;
  let customerId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'integration');

    const services = e2e.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({
        tenant: { id: owner.tenantId } as Tenant,
        name: `Cleaning ${randomUUID().slice(0, 6)}`,
        duration_minutes: 30,
        is_active: true,
      }),
    );
    serviceId = service.id;

    const customers = e2e.dataSource.getRepository(Customer);
    const customer = await customers.save(
      customers.create({
        tenant: { id: owner.tenantId } as Tenant,
        full_name: 'Sensitive Field Test',
        phone: `05${randomUUID().replace(/\D/g, '').slice(0, 8)}`,
        email: `cust-${randomUUID().slice(0, 8)}@example.test`,
        whatsapp_id: 'wa-should-not-leak',
        gender: 'female',
        date_of_birth: new Date('1990-01-01'),
        source: 'referral',
        marketing_opt_in: true,
        is_active: true,
      }),
    );
    customerId = customer.id;
  }, 60_000);

  afterAll(async () => {
    await cleanupIntegrationTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ── API-key lifecycle (JWT-authenticated dashboard flow) ────────────────

  describe('API key lifecycle', () => {
    it('create returns the plaintext ONCE, a key_prefix, and never the hash', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ name: 'lifecycle-key', permissions: ['integration.services.read'] })
        .expect(201);

      expect(res.body.apiKey).toEqual(expect.stringMatching(/^zk_/));
      expect(res.body.key_prefix).toEqual(expect.any(String));
      expect(res.body.apiKey.startsWith(res.body.key_prefix)).toBe(true);
      expect(res.body.key_hash).toBeUndefined();
      expect(res.body.permissions).toEqual(['integration.services.read']);
    });

    it('list returns the {data,total,page,limit} envelope — never the secret', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({ data: expect.any(Array), total: expect.any(Number), page: 1, limit: expect.any(Number) }),
      );
      for (const row of res.body.data) {
        expect(row.key_hash).toBeUndefined();
        expect(row.apiKey).toBeUndefined();
        expect(row).toHaveProperty('key_prefix');
      }
    });

    it('rejects a page size above the max (pagination validation)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/api-keys?limit=500`)
        .set(...authHeader(owner.token))
        .expect(400);
    });

    it('rotate issues a new plaintext + prefix; the previous secret stops working', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);
      const oldKey = created.body.apiKey as string;
      const id = created.body.id as string;

      const rotated = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys/${id}/rotate`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(rotated.body.apiKey).not.toBe(oldKey);
      expect(rotated.body.key_prefix).not.toBe(created.body.key_prefix);

      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services`)
        .set('X-API-Key', oldKey)
        .expect(401);
      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services`)
        .set('X-API-Key', rotated.body.apiKey)
        .expect(200);
    });

    it('revoke permanently disables the key', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);

      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys/${created.body.id}/revoke`)
        .set(...authHeader(owner.token))
        .expect(200);

      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services`)
        .set('X-API-Key', created.body.apiKey)
        .expect(401);
    });

    it('deactivate disables the key; activate restores it', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);
      const key = created.body.apiKey as string;
      const id = created.body.id as string;

      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys/${id}/deactivate`)
        .set(...authHeader(owner.token))
        .expect(200);
      await request(e2e.app.getHttpServer()).get(`${API}/integrations/services`).set('X-API-Key', key).expect(401);

      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys/${id}/activate`)
        .set(...authHeader(owner.token))
        .expect(200);
      await request(e2e.app.getHttpServer()).get(`${API}/integrations/services`).set('X-API-Key', key).expect(200);
    });

    it('rejects granting a scope the caller does not hold the underlying permission for', async () => {
      const limited = await createLimitedActor(
        e2e,
        owner.tenantId,
        [PERMISSION.PLATFORM_API_KEYS_MANAGE, PERMISSION.PLATFORM_API_KEYS_READ, PERMISSION.SERVICES_READ],
        'scope-check',
      );

      // Holds the underlying permission for this one -> allowed.
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(limited.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);

      // Does NOT hold crm.customers.read -> rejected.
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(limited.token))
        .send({ permissions: ['integration.customers.read'] })
        .expect(403);
    });

    it('rejects an unrecognised/legacy scope string outright (DTO allowlist)', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['services.read'] }) // raw internal slug, not a scope
        .expect(400);
    });

    it('records an audit row for create/rotate/revoke/activate/deactivate, never containing the plaintext', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ name: 'audited-key', permissions: ['integration.services.read'] })
        .expect(201);
      const id = created.body.id as string;
      const plaintext = created.body.apiKey as string;

      await request(e2e.app.getHttpServer()).post(`${API}/platform/api-keys/${id}/rotate`).set(...authHeader(owner.token)).expect(200);
      await request(e2e.app.getHttpServer()).post(`${API}/platform/api-keys/${id}/deactivate`).set(...authHeader(owner.token)).expect(200);
      await request(e2e.app.getHttpServer()).post(`${API}/platform/api-keys/${id}/activate`).set(...authHeader(owner.token)).expect(200);
      await request(e2e.app.getHttpServer()).post(`${API}/platform/api-keys/${id}/revoke`).set(...authHeader(owner.token)).expect(200);

      const audits = e2e.dataSource.getRepository(AuditLog);
      const rows = await audits.find({ where: { entity_type: 'ApiKey', entity_id: id } });
      const actions = rows.map((r) => r.action).sort();
      expect(actions).toEqual(
        ['api_key.activate', 'api_key.create', 'api_key.deactivate', 'api_key.revoke', 'api_key.rotate'].sort(),
      );
      for (const row of rows) {
        expect(JSON.stringify(row.new_values ?? {})).not.toContain(plaintext);
      }
    });
  });

  // ── External integration API ─────────────────────────────────────────────

  describe('External integration API', () => {
    let primaryKey: string;

    beforeAll(async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ name: 'primary', permissions: ['integration.services.read', 'integration.customers.read'] })
        .expect(201);
      primaryKey = res.body.apiKey;
    });

    it('valid key access: returns the tenant\'s services', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services`)
        .set('X-API-Key', primaryKey)
        .expect(200);
      expect(res.body.data.map((s: { id: string }) => s.id)).toContain(serviceId);
    });

    it('invalid key is rejected', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services`)
        .set('X-API-Key', 'zk_totally-made-up')
        .expect(401);
    });

    it('expired key is rejected', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({
          permissions: ['integration.services.read'],
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
        .expect(201);

      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services`)
        .set('X-API-Key', created.body.apiKey)
        .expect(401);
    });

    it('missing scope is rejected (key lacks integration.customers.read)', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);

      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/customers`)
        .set('X-API-Key', created.body.apiKey)
        .expect(403);
    });

    it('rejects a page size above the max on an integration list endpoint', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services?limit=1000`)
        .set('X-API-Key', primaryKey)
        .expect(400);
    });

    it('excludes sensitive/internal customer fields from the response', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/customers/${customerId}`)
        .set('X-API-Key', primaryKey)
        .expect(200);
      expect(res.body).toEqual(
        expect.objectContaining({ id: customerId, phone: expect.any(String) }),
      );
      const json = JSON.stringify(res.body);
      expect(json).not.toMatch(/whatsapp|gender|date_of_birth|dateOfBirth|marketing|referral/i);
    });

    it('cross-tenant access returns 404, not another clinic\'s data', async () => {
      const other = await createOwnerFixture(e2e, 'integration-other');
      try {
        const services = e2e.dataSource.getRepository(Service);
        const otherService = await services.save(
          services.create({
            tenant: { id: other.tenantId } as Tenant,
            name: 'Other clinic service',
            duration_minutes: 15,
            is_active: true,
          }),
        );

        await request(e2e.app.getHttpServer())
          .get(`${API}/integrations/services/${otherService.id}`)
          .set('X-API-Key', primaryKey)
          .expect(404);
      } finally {
        await e2e.dataSource.query(`DELETE FROM services WHERE "tenantId" = $1`, [other.tenantId]);
        await cleanupTenant(e2e, other.tenantId);
      }
    });

    it('a suspended tenant\'s previously-valid key is rejected (guard-order fix)', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);
      const key = created.body.apiKey as string;

      // Sanity: works while the tenant is active.
      await request(e2e.app.getHttpServer()).get(`${API}/integrations/services`).set('X-API-Key', key).expect(200);

      const tenants = e2e.dataSource.getRepository(Tenant);
      await tenants.update({ id: owner.tenantId }, { is_active: false });
      try {
        // MaintenanceGuard/ActiveTenantGuard must see the API-key principal
        // (populated by JwtAuthGuard's API-key delegation) and reject it —
        // this is the exact guard-order gap the audit found.
        await request(e2e.app.getHttpServer())
          .get(`${API}/integrations/services`)
          .set('X-API-Key', key)
          .expect(403);
      } finally {
        await tenants.update({ id: owner.tenantId }, { is_active: true });
      }
    });

    it('an unapproved tenant\'s previously-valid key is rejected', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);
      const key = created.body.apiKey as string;

      const tenants = e2e.dataSource.getRepository(Tenant);
      await tenants.update({ id: owner.tenantId }, { approval_status: TenantApprovalStatus.SUSPENDED });
      try {
        await request(e2e.app.getHttpServer())
          .get(`${API}/integrations/services`)
          .set('X-API-Key', key)
          .expect(403);
      } finally {
        await tenants.update({ id: owner.tenantId }, { approval_status: TenantApprovalStatus.APPROVED });
      }
    });

    it('platform maintenance mode blocks API-key requests (no super-admin bypass for a tenant key)', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);
      const key = created.body.apiKey as string;

      const settings = e2e.app.get(SystemSettingService);
      await settings.upsertByKey(SettingKey.MAINTENANCE_MODE, true);
      try {
        await request(e2e.app.getHttpServer())
          .get(`${API}/integrations/services`)
          .set('X-API-Key', key)
          .expect(503);
      } finally {
        await settings.upsertByKey(SettingKey.MAINTENANCE_MODE, false);
      }

      // Sanity: works again once maintenance mode is lifted.
      await request(e2e.app.getHttpServer()).get(`${API}/integrations/services`).set('X-API-Key', key).expect(200);
    });

    it('an API key cannot authenticate a normal JWT-protected (internal dashboard) route', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(owner.token))
        .send({ permissions: ['integration.services.read'] })
        .expect(201);

      // The internal dashboard route is JWT-only; presenting an API key
      // (with no Bearer/cookie) must NOT authenticate it.
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/api-keys`)
        .set('X-API-Key', created.body.apiKey)
        .expect(401);
    });

    it('a JWT bearer token cannot authenticate an external integration route', async () => {
      // The integration route only recognises X-API-Key / Authorization: ApiKey.
      // A dashboard user's Bearer JWT must be rejected, not silently accepted.
      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/services`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(401);
    });

    it('routes for staff/appointments/availability are wired and scope-enforced', async () => {
      // The primary key was never granted these scopes -> 403, not 404/500.
      // Proves the routes, DI wiring, and scope guard all work end-to-end for
      // every Phase 1 resource without needing Branch/Staff/Appointment fixtures.
      await request(e2e.app.getHttpServer()).get(`${API}/integrations/staff`).set('X-API-Key', primaryKey).expect(403);
      await request(e2e.app.getHttpServer()).get(`${API}/integrations/appointments`).set('X-API-Key', primaryKey).expect(403);
      await request(e2e.app.getHttpServer())
        .get(`${API}/integrations/availability?branchId=${randomUUID()}&staffId=${randomUUID()}&date=2026-01-01`)
        .set('X-API-Key', primaryKey)
        .expect(403);
    });
  });
  // Per-key rate limiting is covered in its own file (integration-api-rate-
  // limit.e2e-spec.ts) — it needs a LOW limit set via an env-setup module
  // imported before AppModule ever loads, which would otherwise apply (or
  // fail to apply) to every app instance built in THIS file too. See that
  // file's docstring / integration-rate-limit-env.setup.ts for why.
});
