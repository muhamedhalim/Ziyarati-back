/**
 * ============================================================================
 *  SUPPORT OPERATIONS CONSOLE — HTTP security e2e
 * ============================================================================
 *
 * The authorization half of this feature, proven against the REAL guard chain
 * (`createE2eApp` boots the actual AppModule) rather than against mocks. Unit
 * tests already prove each Support DTO omits the right fields; what THIS suite
 * proves is the part a projection test cannot: that a `platform_support`
 * principal is admitted to exactly the diagnostic routes it should be, and
 * refused everywhere else, with no frontend involved.
 *
 * Every "cannot" assertion below is a direct HTTP request with a real
 * platform_support bearer token. Frontend hiding is explicitly NOT a security
 * boundary here — none of these tests render anything.
 *
 * REQUIRES: the RBAC seed plus BOTH data migrations
 * (`PlatformSupportRoleAndPermissions` 1730034000000 and
 * `PlatformSupportDiagnosticPermissions` 1730036000000) applied to the target
 * database — this suite creates neither the role nor its grants.
 *
 * DATABASE ISOLATION: every fixture is scoped under a freshly created Tenant
 * or a dedicated platform user; `afterAll` removes every row this suite
 * created, in FK-safe order.
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
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';

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

/** A platform-scope user (tenantId = NULL) holding a seeded global system role. */
async function createPlatformActor(e2e: E2eApp, roleSlug: string, label: string) {
  const users = e2e.dataSource.getRepository(User);
  const roles = e2e.dataSource.getRepository(Role);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: roleSlug })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) {
    throw new Error(
      `Seeded platform role "${roleSlug}" not found — run the RBAC migrations first.`,
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
    userRoles.create({ user: { id: user.id } as User, role: { id: role.id } as Role }),
  );

  return { userId: user.id, token: await mintTokenFor(e2e, user.id, null) };
}

describe('Support Operations Console — diagnostics authorization (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let otherOwner: OwnerFixture;
  let superAdmin: { userId: string; token: string };
  let support: { userId: string; token: string };
  const createdUserIds: string[] = [];

  /** Every diagnostic READ route, as `[label, path]`. */
  let readRoutes: [string, string][];

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'soc-owner');
    otherOwner = await createOwnerFixture(e2e, 'soc-other');
    superAdmin = await createPlatformActor(e2e, ROLE.SUPER_ADMIN, 'soc-sa');
    support = await createPlatformActor(e2e, ROLE.PLATFORM_SUPPORT, 'soc-cs');
    createdUserIds.push(superAdmin.userId, support.userId);

    const base = `${API}/platform/support/clinics/${owner.tenantId}`;
    readRoutes = [
      ['clinic directory', `${API}/platform/support/clinics`],
      ['profile', base],
      ['subscription', `${base}/subscription`],
      ['features', `${base}/features`],
      ['configuration', `${base}/configuration`],
      ['integrations', `${base}/integrations`],
      ['emails', `${base}/emails`],
      ['notifications', `${base}/notifications`],
      ['activity', `${base}/activity`],
      ['appointments', `${base}/appointments`],
      ['payments', `${base}/payments`],
      ['ai', `${base}/ai`],
      ['whatsapp', `${base}/whatsapp`],
      ['jobs health', `${API}/platform/support/jobs/health`],
    ];
  }, 90_000);

  afterAll(async () => {
    for (const tenantId of [owner.tenantId, otherOwner.tenantId]) {
      const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
      await q(
        `DELETE FROM refresh_tokens WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(
        `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
      await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`);
      await q(`DELETE FROM users WHERE "tenantId" = $1`);
      await q(`DELETE FROM tenants WHERE id = $1`);
    }
    if (createdUserIds.length) {
      const ids = [createdUserIds];
      await e2e.dataSource.query(
        `DELETE FROM audit_logs WHERE "userId" = ANY($1::uuid[])`,
        ids,
      );
      await e2e.dataSource.query(
        `DELETE FROM refresh_tokens WHERE "userId" = ANY($1::uuid[])`,
        ids,
      );
      await e2e.dataSource.query(
        `DELETE FROM user_roles WHERE "userId" = ANY($1::uuid[])`,
        ids,
      );
      await e2e.dataSource.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, ids);
    }
    await e2e.app.close();
  }, 30_000);

  // ── What Platform Support CAN read ──────────────────────────────────────

  describe('Platform Support reads every approved diagnostic', () => {
    it('reaches all 14 diagnostic read routes with 200', async () => {
      for (const [label, path] of readRoutes) {
        const res = await request(e2e.app.getHttpServer())
          .get(path)
          .set(...authHeader(support.token));
        expect([label, res.status]).toEqual([label, 200]);
      }
    });

    it('returns ONLY the expected clinic-profile keys — no verification, registration or branding data', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support/clinics/${owner.tenantId}`)
        .set(...authHeader(support.token))
        .expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['clinic', 'structure']);
      expect(Object.keys(res.body.clinic).sort()).toEqual(
        [
          'approvalStatus',
          'contactEmail',
          'contactPhone',
          'createdAt',
          'currency',
          'id',
          'isActive',
          'name',
          'slug',
          'timezone',
        ].sort(),
      );
    });

    it('never leaks a raw entity field carrying a secret, a credential or platform economics', async () => {
      const forbidden = [
        'access_token',
        'accessToken',
        'api_key',
        'apiKey',
        'ciphertext',
        'client_secret',
        'webhook_secret',
        'link_token',
        'iban',
        'platform_fee',
        'platformFee',
        'gateway_fee',
        'net_amount',
        'settlement_status',
        'cost_usd',
        'cost_microusd',
        'commercial_registration_number',
      ];

      for (const [label, path] of readRoutes) {
        const res = await request(e2e.app.getHttpServer())
          .get(path)
          .set(...authHeader(support.token))
          .expect(200);
        const body = JSON.stringify(res.body);
        for (const key of forbidden) {
          expect([label, key, body.includes(key)]).toEqual([label, key, false]);
        }
      }
    });

    it('404s a clinic that does not exist rather than returning an empty diagnostic', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support/clinics/${randomUUID()}`)
        .set(...authHeader(support.token))
        .expect(404);
    });

    it('Super Admin reaches the same routes unchanged (the wildcard still applies)', async () => {
      for (const [label, path] of readRoutes) {
        const res = await request(e2e.app.getHttpServer())
          .get(path)
          .set(...authHeader(superAdmin.token));
        expect([label, res.status]).toEqual([label, 200]);
      }
    });
  });

  // ── The clinic directory: diagnostics WITHOUT a ticket ──────────────────

  /**
   * The directory is the console's proactive entry point — the only route
   * that answers "which clinic is this?" before a ticket exists. It is also
   * the one most at risk of quietly becoming the Super Admin tenant directory,
   * so its response shape is asserted exactly rather than sampled.
   */
  describe('Clinic directory', () => {
    const directory = `${API}/platform/support/clinics`;
    /** The tenant's OWN slug and contact details — not the owner user's. */
    let clinic: { slug: string; contact_email: string };

    beforeAll(async () => {
      [clinic] = await e2e.dataSource.query(
        `SELECT slug, contact_email FROM tenants WHERE id = $1`,
        [owner.tenantId],
      );
    });

    it('finds a clinic with no ticket in existence', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(directory)
        .query({ search: clinic.slug })
        .set(...authHeader(support.token))
        .expect(200);

      expect(res.body.data.map((c: { id: string }) => c.id)).toContain(owner.tenantId);
    });

    it('returns EXACTLY the allow-listed row keys', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(directory)
        .query({ search: clinic.slug })
        .set(...authHeader(support.token))
        .expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['data', 'limit', 'page', 'total']);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(
        [
          'approvalStatus',
          'branchesActive',
          'branchesTotal',
          'contactEmail',
          'contactPhone',
          'createdAt',
          'id',
          'isActive',
          'lastTicketActivityAt',
          'name',
          'openTicketCount',
          'planName',
          'slug',
          'subscriptionStatus',
          'totalTicketCount',
        ].sort(),
      );
    });

    it('is NOT the Super Admin tenant directory — no verification or legal identity', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(directory)
        .set(...authHeader(support.token))
        .expect(200);

      const body = JSON.stringify(res.body);
      for (const key of [
        'commercial_registration_number',
        'commercialRegistrationNumber',
        'legal_name',
        'legalName',
        'verification',
        'rejection_reason',
        'rejectionReason',
        'logo_url',
        'price',
        'monthly_price',
      ]) {
        expect([key, body.includes(key)]).toEqual([key, false]);
      }
    });

    /**
     * The reason search covers contact details at all: a clinic that PHONES
     * support identifies itself by the address or number it contacted from,
     * not by its tenant slug.
     */
    it('finds the clinic by its contact email, not only by name or slug', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(directory)
        .query({ search: clinic.contact_email })
        .set(...authHeader(support.token))
        .expect(200);

      expect(res.body.data.map((c: { id: string }) => c.id)).toContain(owner.tenantId);
    });

    it('returns an empty page — not an error — for a term nothing matches', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(directory)
        .query({ search: 'zzz-no-such-clinic-zzz' })
        .set(...authHeader(support.token))
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it('paginates, and honours the page-size ceiling', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(directory)
        .query({ page: 1, limit: 1 })
        .set(...authHeader(support.token))
        .expect(200);

      expect(res.body.limit).toBe(1);
      expect(res.body.data.length).toBeLessThanOrEqual(1);

      await request(e2e.app.getHttpServer())
        .get(directory)
        .query({ limit: 5000 })
        .set(...authHeader(support.token))
        .expect(400);
    });

    it('rejects an unknown approval state rather than ignoring the filter', async () => {
      await request(e2e.app.getHttpServer())
        .get(directory)
        .query({ approvalStatus: 'NOT_A_STATE' })
        .set(...authHeader(support.token))
        .expect(400);
    });

    it('exposes no mutation on the directory — approve, suspend and delete do not exist', async () => {
      const server = e2e.app.getHttpServer();
      for (const [method, path] of [
        ['post', directory],
        ['patch', `${directory}/${owner.tenantId}`],
        ['put', `${directory}/${owner.tenantId}`],
        ['delete', `${directory}/${owner.tenantId}`],
        ['patch', `${directory}/${owner.tenantId}/approve`],
        ['patch', `${directory}/${owner.tenantId}/suspend`],
      ] as const) {
        const res = await request(server)[method](path)
          .set(...authHeader(support.token))
          .send({});
        expect([method, path, res.status >= 400]).toEqual([method, path, true]);
      }
    });

    it('refuses a clinic Owner outright', async () => {
      await request(e2e.app.getHttpServer())
        .get(directory)
        .set(...authHeader(owner.token))
        .expect(403);
    });
  });

  // ── What Platform Support CANNOT do ─────────────────────────────────────

  describe('Platform Support is refused everything outside the diagnostic surface', () => {
    const denied = (
      label: string,
      method: 'get' | 'post' | 'patch' | 'put' | 'delete',
      path: () => string,
      body?: Record<string, unknown>,
    ) => [label, method, path, body] as const;

    it('cannot reach Super Admin financial, AI-cost, subscription-admin or platform-config surfaces', async () => {
      const routes = [
        denied('platform finance', 'get', () => `${API}/platform/finance/overview`),
        denied('AI monitoring (costs)', 'get', () => `${API}/platform/ai-monitoring/overview`),
        denied('platform billing admin', 'get', () => `${API}/platform/billing/plans`),
        denied('platform feature flags', 'get', () => `${API}/platform/feature-flags`),
        denied('platform settings', 'get', () => `${API}/platform/settings`),
        denied('platform monitoring', 'get', () => `${API}/platform/monitoring/overview`),
        denied('platform email logs', 'get', () => `${API}/platform/email-logs`),
        denied('platform API keys', 'get', () => `${API}/platform/api-keys`),
        denied('RBAC audit centre', 'get', () => `${API}/platform/rbac/permissions`),
        denied('platform staff management', 'get', () => `${API}/platform/staff`),
        denied('tenant directory', 'get', () => `${API}/tenants`),
        denied('payment gateways', 'get', () => `${API}/payment-gateways`),
        denied('payment merchants', 'get', () => `${API}/payment-merchants`),
      ];

      for (const [label, method, path] of routes) {
        const res = await request(e2e.app.getHttpServer())
          [method](path())
          .set(...authHeader(support.token));
        // 403 is the expected refusal; a 404 (route absent in this build) is
        // equally not-a-leak. Anything 2xx is a real finding.
        expect([label, res.status < 400]).toEqual([label, false]);
      }
    });

    it('cannot reach any tenant-scoped clinic API — requireTenantId() refuses a platform principal', async () => {
      const routes = [
        `${API}/appointments`,
        `${API}/crm/customers`,
        `${API}/payments`,
        `${API}/invoices`,
        `${API}/refunds`,
        `${API}/staff`,
        `${API}/services`,
        `${API}/subscriptions/current`,
        `${API}/usage/summary`,
        `${API}/feature-flags`,
      ];

      for (const path of routes) {
        const res = await request(e2e.app.getHttpServer())
          .get(path)
          .set(...authHeader(support.token));
        expect([path, res.status < 400]).toEqual([path, false]);
      }
    });

    it('cannot escalate by SUPPLYING another tenantId to a tenant API', async () => {
      // The tenant id lives in the JWT and is read from TenantContextService,
      // never from a query param — so this must fail exactly like the bare
      // call above, not succeed with the supplied tenant's data.
      for (const path of [
        `${API}/crm/customers?tenantId=${owner.tenantId}`,
        `${API}/appointments?tenantId=${owner.tenantId}`,
        `${API}/payments?tenantId=${owner.tenantId}`,
      ]) {
        const res = await request(e2e.app.getHttpServer())
          .get(path)
          .set(...authHeader(support.token));
        expect([path, res.status < 400]).toEqual([path, false]);
      }
    });

    it('cannot change a subscription, plan, usage or feature flag', async () => {
      const writes: [string, 'post' | 'patch' | 'put', string, Record<string, unknown>][] = [
        ['create plan', 'post', `${API}/platform/billing/plans`, { name: 'Hacked' }],
        ['billing mode', 'put', `${API}/platform/billing/mode`, { mode: 'FREE' }],
        [
          'feature flag',
          'put',
          `${API}/platform/feature-flags/${owner.tenantId}/ai_assistant`,
          { isEnabled: true },
        ],
      ];

      for (const [label, method, path, body] of writes) {
        const res = await request(e2e.app.getHttpServer())
          [method](path)
          .set(...authHeader(support.token))
          .send(body);
        expect([label, res.status < 400]).toEqual([label, false]);
      }
    });

    it('cannot approve, reject or suspend a clinic', async () => {
      for (const [label, path] of [
        ['approve', `${API}/tenants/${owner.tenantId}/approve`],
        ['reject', `${API}/tenants/${owner.tenantId}/reject`],
        ['suspend', `${API}/tenants/${owner.tenantId}/suspend`],
      ]) {
        const res = await request(e2e.app.getHttpServer())
          .patch(path)
          .set(...authHeader(support.token))
          .send({ reason: 'e2e' });
        expect([label, res.status < 400]).toEqual([label, false]);
      }
    });

    it('cannot refund, modify a payment, or modify an appointment', async () => {
      const writes: [string, 'post' | 'patch', string][] = [
        ['refund', 'post', `${API}/refunds`],
        ['payment update', 'patch', `${API}/payments/${randomUUID()}`],
        ['appointment update', 'patch', `${API}/appointments/${randomUUID()}`],
        ['appointment cancel', 'patch', `${API}/appointments/${randomUUID()}/cancel`],
      ];

      for (const [label, method, path] of writes) {
        const res = await request(e2e.app.getHttpServer())
          [method](path)
          .set(...authHeader(support.token))
          .send({});
        expect([label, res.status < 400]).toEqual([label, false]);
      }
    });

    it('cannot manage roles, permissions or users', async () => {
      const writes: [string, 'post' | 'get', string][] = [
        ['list roles', 'get', `${API}/roles`],
        ['create role', 'post', `${API}/roles`],
        ['register user', 'post', `${API}/auth/register-user`],
      ];

      for (const [label, method, path] of writes) {
        const res = await request(e2e.app.getHttpServer())
          [method](path)
          .set(...authHeader(support.token))
          .send({ name: 'x', slug: 'x' });
        expect([label, res.status < 400]).toEqual([label, false]);
      }
    });

    it('still cannot CLOSE a support ticket — the pre-existing boundary is unchanged', async () => {
      // Proven in detail by platform-support-tickets.e2e-spec; re-asserted here
      // so a regression in the diagnostics work cannot silently widen it.
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/support-tickets/${randomUUID()}/status`)
        .set(...authHeader(support.token))
        .send({ status: 'closed' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ── Who else can reach the diagnostics (nobody) ─────────────────────────

  describe('No tenant principal can reach a Support diagnostic endpoint', () => {
    it('a clinic Owner is refused on every diagnostic route — including for their OWN clinic', async () => {
      for (const [label, path] of readRoutes) {
        const res = await request(e2e.app.getHttpServer())
          .get(path)
          .set(...authHeader(owner.token));
        expect([label, res.status < 400]).toEqual([label, false]);
      }
    });

    it("a clinic Owner from ANOTHER clinic is refused too — this is not an ownership check, it is a role boundary", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support/clinics/${owner.tenantId}`)
        .set(...authHeader(otherOwner.token));
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('an unauthenticated request is refused', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support/clinics/${owner.tenantId}`)
        .expect(401);
    });
  });

  // ── Safe actions ────────────────────────────────────────────────────────

  describe('Safe actions', () => {
    it('rejects a resend for an email record that does not belong to the clinic (404, never a confirmation)', async () => {
      await request(e2e.app.getHttpServer())
        .post(
          `${API}/platform/support/clinics/${owner.tenantId}/emails/${randomUUID()}/resend`,
        )
        .set(...authHeader(support.token))
        .expect(404);
    });

    it('accepts NO request body on any action route — there is nothing to construct', async () => {
      // A rogue body is stripped by the global ValidationPipe rather than
      // reaching a DTO, because these routes declare none. The request still
      // fails on the (nonexistent) record, proving the body changed nothing.
      const res = await request(e2e.app.getHttpServer())
        .post(
          `${API}/platform/support/clinics/${owner.tenantId}/emails/${randomUUID()}/resend`,
        )
        .set(...authHeader(support.token))
        .send({ to: 'attacker@example.test', template: 'password_reset' });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('attacker@example.test');
    });

    it('refuses to retry a notification that does not belong to the clinic', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(
          `${API}/platform/support/clinics/${owner.tenantId}/notifications/${randomUUID()}/retry`,
        )
        .set(...authHeader(support.token));
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('performs an integration recheck that mutates nothing and records who triggered it', async () => {
      const before = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM audit_logs
          WHERE action = 'platform_support.integration_rechecked' AND "tenantId" = $1`,
        [owner.tenantId],
      );

      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/support/clinics/${owner.tenantId}/integrations/recheck`)
        .set(...authHeader(support.token))
        .expect(201);

      expect(res.body).toHaveProperty('recheckedAt');
      expect(res.body).toHaveProperty('queueBackend');
      // Health verdicts only — never a credential.
      expect(JSON.stringify(res.body)).not.toContain('access_token');

      const after = await e2e.dataSource.query(
        `SELECT "userId", new_values FROM audit_logs
          WHERE action = 'platform_support.integration_rechecked' AND "tenantId" = $1
          ORDER BY created_at DESC LIMIT 1`,
        [owner.tenantId],
      );
      expect(after.length).toBe(1);
      expect(after[0].userId).toBe(support.userId);

      const countAfter = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM audit_logs
          WHERE action = 'platform_support.integration_rechecked' AND "tenantId" = $1`,
        [owner.tenantId],
      );
      expect(countAfter[0].n).toBe(before[0].n + 1);
    });

    it('a clinic Owner cannot trigger any Support safe action', async () => {
      for (const path of [
        `${API}/platform/support/clinics/${owner.tenantId}/integrations/recheck`,
        `${API}/platform/support/clinics/${owner.tenantId}/emails/${randomUUID()}/resend`,
        `${API}/platform/support/clinics/${owner.tenantId}/notifications/${randomUUID()}/retry`,
      ]) {
        const res = await request(e2e.app.getHttpServer())
          .post(path)
          .set(...authHeader(owner.token));
        expect([path, res.status < 400]).toEqual([path, false]);
      }
    });
  });

  // ── Queue health carries no tenant data and no Redis internals ──────────

  describe('Queue/worker health', () => {
    it('returns health only — no Redis keys, no connection string, no job payloads', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support/jobs/health`)
        .set(...authHeader(support.token))
        .expect(200);

      expect(Object.keys(res.body).sort()).toEqual(
        ['collectedAt', 'email', 'queues', 'redis', 'worker'].sort(),
      );
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('redis://');
      expect(body).not.toContain('bull:');
      // The Redis KEY must not leak. `heartbeatAgeSeconds` is a derived field
      // name and is fine — asserting on the bare word "heartbeat" would forbid
      // the very signal this endpoint exists to report.
      expect(body).not.toContain('payments:reaper:heartbeat');
      expect(body).not.toMatch(/"[^"]*:[^"]*:[^"]*"\s*:\s*\{/); // no colon-shaped Redis key as an object key
    });

    it('exposes only the allow-listed queues', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support/jobs/health`)
        .set(...authHeader(support.token))
        .expect(200);

      expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual([
        'email',
        'notifications',
        'whatsapp',
      ]);
    });
  });
});
