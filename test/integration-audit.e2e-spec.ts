/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * INTEGRATION API — E2E AUDIT SPEC (2026-10-12).
 *
 * Audits the published Integration API contract (docs/PARTNER_INTEGRATION_GUIDE.md,
 * generated from src/config/integration-api-guide.ts) against the running
 * implementation. It deliberately asserts the DOCUMENTED behaviour: where the
 * code deviates the test FAILS and the observed values are preserved through
 * test/utils/audit-evidence.ts, so a failure here is a finding, not a flake.
 *
 * Targets what the existing suites do not already prove (see the audit report's
 * traceability table). Test titles begin with a matrix ID (A-01, B-02, …) so
 * jest's JSON output can be joined to the recorded observations.
 *
 * SAFETY: isolated migrations-built DB (ziyarati_e2e), disposable Redis,
 * EMAIL_ENABLED=false, Meta clients mocked, synthetic tenants only, bounded
 * concurrency (<= 10 parallel), no request ever leaves loopback. The SSRF guard
 * is relaxed for 127.0.0.1 ONLY while E2E_ALLOW_SIM_LOOPBACK=1 (same pattern as
 * integration-outbound-simulation.e2e-spec.ts) and is switched off for every
 * validation test.
 */
jest.mock('../src/modules/platform/webhook-url-guard', () => {
  const actual = jest.requireActual(
    '../src/modules/platform/webhook-url-guard',
  );
  const isSimLoopback = (raw: string): boolean => {
    if (process.env.E2E_ALLOW_SIM_LOOPBACK !== '1') return false;
    try {
      return new URL(raw).hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };
  return {
    ...actual,
    assertSafeWebhookUrl: (raw: string) => {
      if (!isSimLoopback(raw)) actual.assertSafeWebhookUrl(raw);
    },
    resolveSafeWebhookTarget: async (url: URL) =>
      isSimLoopback(url.toString())
        ? { address: '127.0.0.1', family: 4 }
        : actual.resolveSafeWebhookTarget(url),
  };
});

import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import {
  PartnerReceiver,
  nowSeconds,
  signInboundV1,
  v2Headers,
} from './utils/partner-simulator';
import { waitForRedisReady } from './utils/docker-redis-control';
import { note, flush } from './utils/audit-evidence';

import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Service } from '../src/entities/Services/Service';
import { WebhookDelivery } from '../src/entities/System/WebhookDelivery';
import { IntegrationInboundEvent } from '../src/entities/Integration/IntegrationInboundEvent';
import { IntegrationModule } from '../src/modules/integration/integration.module';
import { IntegrationInboundService } from '../src/modules/integration-platform/inbound/integration-inbound.service';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../src/queue/worker-authorization.service';
import { runInTenantContext } from '../src/queue/tenant-context.runner';
import { QueueService } from '../src/queue/queue.service';
import { JOB } from '../src/queue/queue.constants';
import { WebhookDeliveryProcessor } from '../src/worker/processors/webhook-delivery.processor';
import { WebhookDeliveryService } from '../src/modules/platform/webhook-delivery.service';
import { WebhookEndpointService } from '../src/modules/platform/webhook-endpoint.service';
import {
  AppointmentCreatedEvent,
  APPOINTMENT_EVENT,
} from '../src/events/appointment.events';

const API = '/api/v1';
type Res = request.Response;
const uniq = () => randomUUID().slice(0, 8);
let phoneSeq = 0;
const phoneBase = 500_000_000 + Math.floor(Math.random() * 90_000_000);
const phone = () =>
  `+966${String(phoneBase + ++phoneSeq).padStart(9, '0')}`;
const email = () => `audit-${uniq()}@example.test`;
const rid = (...rs: Res[]) =>
  rs.map((r) => r.headers['x-request-id'] as string).filter(Boolean);

const KEY_SCOPES_READ = [
  'integration.services.read',
  'integration.staff.read',
  'integration.availability.read',
  'integration.customers.read',
  'integration.appointments.read',
];
const KEY_SCOPES_WRITE = [
  'integration.customers.write',
  'integration.services.write',
  'integration.staff.write',
  'integration.appointments.write',
];

const EXPECTED_ROUTES = [
  'GET /integrations/me',
  'GET /integrations/services',
  'GET /integrations/services/{id}',
  'GET /integrations/staff',
  'GET /integrations/staff/{id}',
  'GET /integrations/customers',
  'GET /integrations/customers/{id}',
  'GET /integrations/appointments',
  'GET /integrations/appointments/{id}',
  'GET /integrations/availability',
  // F05 (remediation): read-only branch discovery
  'GET /integrations/branches',
  'GET /integrations/branches/{id}',
  'POST /integrations/customers/upsert',
  'POST /integrations/services/upsert',
  'POST /integrations/staff/upsert',
  'POST /integrations/appointments/upsert',
].sort();

async function cleanupAuditTenant(e2e: E2eApp, tenantId: string) {
  const q = async (sql: string) => {
    try {
      await e2e.dataSource.query(sql, [tenantId]);
    } catch {
      /* table may not exist / nothing to delete — cleanup is best-effort */
    }
  };
  await q(`DELETE FROM outbox_jobs WHERE dedupe_key IN (
    SELECT 'integration-inbound-' || id FROM integration_inbound_events WHERE "tenantId" = $1
    UNION SELECT 'webhook-delivery-' || id FROM webhook_deliveries WHERE "tenantId" = $1)`);
  await q(`DELETE FROM webhook_deliveries WHERE "tenantId" = $1`);
  await q(`DELETE FROM webhook_endpoints WHERE "tenantId" = $1`);
  await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_inbound_events WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_webhook_endpoints WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_staff_provisioning WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_conflicts WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_id_map WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_idempotency_keys WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_connections WHERE "tenantId" = $1`);
  await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`);
  await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
  await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`);
  await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
  await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`);
  await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
  await q(`DELETE FROM branch_users WHERE "tenantId" = $1`);
  await q(`DELETE FROM branches WHERE "tenantId" = $1`);
  await q(`DELETE FROM services WHERE "tenantId" = $1`);
  await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM api_keys WHERE "tenantId" = $1`);
  await q(
    `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
  );
  await q(`DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`);
  await q(`DELETE FROM roles WHERE "tenantId" = $1`);
  await cleanupTenant(e2e, tenantId);
}

describe('Integration API — E2E audit (documented contract vs implementation)', () => {
  let e2e: E2eApp;
  let A: OwnerFixture;
  let B: OwnerFixture;
  let serviceId = '';
  let branchId = '';
  let bServiceId = '';
  let staffId = '';
  const staffEmail = `audit-staff-${uniq()}@example.test`;
  let connDefault = ''; // default policy (reject_and_report)
  let connExt = ''; // external_wins
  let connPlat = ''; // platform_wins
  let connB = '';
  let fullKey = '';
  let bKey = '';
  let custExt = '';
  let staffExt = '';
  let inbound: IntegrationInboundService;
  let ctx: TenantContextService;
  let authz: WorkerAuthorizationService;
  let receiver: PartnerReceiver;
  let processor: WebhookDeliveryProcessor;
  const server = () => e2e.app.getHttpServer();
  const secrets: string[] = [];
  const responses: string[] = [];
  let dayCursor = 4;

  async function call(
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    o: {
      jwt?: string;
      key?: string;
      headers?: Record<string, string>;
      body?: unknown;
      raw?: string;
    } = {},
  ): Promise<Res> {
    let r = (
      request(server()) as unknown as Record<
        string,
        (u: string) => request.Test
      >
    )[method](`${API}${url}`);
    if (o.jwt) r = r.set(...authHeader(o.jwt));
    if (o.key) r = r.set('X-API-Key', o.key);
    if (o.headers) r = r.set(o.headers);
    if (o.raw !== undefined)
      r = r.set('Content-Type', 'application/json').send(o.raw);
    else if (o.body !== undefined) r = r.send(o.body as object);
    const res = await r;
    responses.push(res.text ?? '');
    return res;
  }

  async function newKey(
    jwt: string,
    permissions: string[] | undefined,
    name = `audit-${uniq()}`,
  ) {
    const res = await call('post', '/platform/api-keys', {
      jwt,
      body: permissions ? { name, permissions } : { name },
    });
    expect(res.status).toBe(201);
    secrets.push(res.body.apiKey);
    return { key: res.body.apiKey as string, id: res.body.id as string };
  }

  async function newConnection(
    jwt: string,
    policy?: 'external_wins' | 'platform_wins' | 'reject_and_report',
  ) {
    const res = await call('post', '/platform/integrations/connections', {
      jwt,
      body: {
        name: `Audit PMS ${uniq()}`,
        provider: 'custom',
        authType: 'none',
        ...(policy ? { defaultConflictPolicy: policy } : {}),
      },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  const upsert = (
    resource: 'customers' | 'services' | 'staff' | 'appointments',
    key: string,
    connectionId: string,
    externalId: string,
    data: Record<string, unknown>,
    headers?: Record<string, string>,
  ) =>
    call('post', `/integrations/${resource}/upsert`, {
      key,
      headers,
      body: { connectionId, externalId, data },
    });

  const goodCustomer = () => ({
    full_name: `Audit ${uniq()}`,
    phone: phone(),
    email: email(),
  });

  const sql = async (text: string, params: unknown[] = []) =>
    e2e.dataSource.query(text, params);

  const slot = (minutes = 30, hourUtc = 10) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + dayCursor++);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return {
      startAt: d.toISOString(),
      endAt: new Date(d.getTime() + minutes * 60_000).toISOString(),
      date: d.toISOString().slice(0, 10),
      ms: d.getTime(),
    };
  };
  const apptData = (s: { startAt: string; endAt: string }, extra = {}) => ({
    startAt: s.startAt,
    endAt: s.endAt,
    branchId,
    customerExternalId: custExt,
    staffExternalId: staffExt,
    serviceIds: [serviceId],
    ...extra,
  });
  const drain = <T>(tenantId: string, fn: () => Promise<T>, job = JOB.INTEGRATION_INBOUND) =>
    runInTenantContext(ctx, authz, job, { tenantId } as never, fn);

  beforeAll(async () => {
    if (process.env.EMAIL_ENABLED !== 'false') {
      throw new Error(
        'Refusing to run: EMAIL_ENABLED must be false (the e2e env file forces it).',
      );
    }
    delete process.env.E2E_ALLOW_SIM_LOOPBACK;
    await waitForRedisReady();
    receiver = new PartnerReceiver();
    await receiver.start();

    e2e = await createE2eApp();
    A = await createOwnerFixture(e2e, 'audit-a');
    B = await createOwnerFixture(e2e, 'audit-b');
    inbound = e2e.app.get(IntegrationInboundService);
    ctx = e2e.app.get(TenantContextService);
    authz = e2e.app.get(WorkerAuthorizationService);
    processor = new WebhookDeliveryProcessor(
      e2e.app.get(WebhookDeliveryService),
      e2e.app.get(WebhookEndpointService),
      e2e.app.get(TenantContextService),
      e2e.app.get(QueueService),
      e2e.app.get(WorkerAuthorizationService),
      e2e.config,
    );

    // Domain fixtures (synthetic). Direct inserts mirror the existing suites.
    const services = e2e.dataSource.getRepository(Service);
    serviceId = (
      await services.save(
        services.create({
          tenant: { id: A.tenantId } as Tenant,
          name: `Audit Consult ${uniq()}`,
          public_slug: `audit-consult-${uniq()}`,
          duration_minutes: 30,
          is_active: true,
        }),
      )
    ).id;
    bServiceId = (
      await services.save(
        services.create({
          tenant: { id: B.tenantId } as Tenant,
          name: `B Audit Service ${uniq()}`,
          public_slug: `b-audit-${uniq()}`,
          duration_minutes: 30,
          is_active: true,
        }),
      )
    ).id;
    const branches = e2e.dataSource.getRepository(Branch);
    branchId = (
      await branches.save(
        branches.create({
          tenant: { id: A.tenantId } as Tenant,
          name: `Audit Main ${uniq()}`,
          timezone: 'Asia/Riyadh',
          is_active: true,
        }),
      )
    ).id;

    connDefault = await newConnection(A.token);
    connExt = await newConnection(A.token, 'external_wins');
    connPlat = await newConnection(A.token, 'platform_wins');
    connB = await newConnection(B.token, 'external_wins');

    const fk = await newKey(
      A.token,
      [...KEY_SCOPES_READ, ...KEY_SCOPES_WRITE],
      'audit full',
    );
    fullKey = fk.key;
    bKey = (
      await newKey(B.token, [...KEY_SCOPES_READ, ...KEY_SCOPES_WRITE], 'B full')
    ).key;

    // Staff through the DOMAIN flow, a weekly schedule, then link by e-mail.
    const staffRes = await call('post', '/staff/from-new-user', {
      jwt: A.token,
      body: {
        email: staffEmail,
        fullName: 'Audit Dentist',
        title: 'Audit Dentist',
        roleSlug: 'receptionist',
        branchIds: [branchId],
        primaryBranchId: branchId,
      },
    });
    if (staffRes.status >= 400)
      throw new Error(`staff fixture failed: ${staffRes.status}`);
    const staffList = await call('get', '/integrations/staff?limit=100', {
      key: fullKey,
    });
    staffId = staffList.body.data.find(
      (s: any) => s.title === 'Audit Dentist',
    ).id;
    for (let d = 0; d <= 6; d++) {
      const sch = await call('post', `/staff/${staffId}/schedules`, {
        jwt: A.token,
        body: { branchId, dayOfWeek: d, startTime: '08:00', endTime: '20:00' },
      });
      expect(sch.status).toBeLessThan(300);
    }
    staffExt = `AUD-STAFF-${uniq()}`;
    const link = await upsert('staff', fullKey, connExt, staffExt, {
      title: 'Audit Dentist',
      matchEmail: staffEmail,
    });
    expect(link.status).toBe(200);
    custExt = `AUD-CUST-${uniq()}`;
    const c = await upsert('customers', fullKey, connExt, custExt, goodCustomer());
    expect(c.body.outcome).toBe('created');
  }, 180_000);

  afterAll(async () => {
    process.env.E2E_ALLOW_SIM_LOOPBACK = '0';
    try {
      flush();
    } catch {
      /* never fail teardown on evidence write */
    }
    await receiver?.stop();
    await cleanupAuditTenant(e2e, A.tenantId).catch(() => undefined);
    await cleanupAuditTenant(e2e, B.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 90_000);

  // ══ A. availability & contract ═══════════════════════════════════════════

  describe('A — contract', () => {
    it('A-01 route registration: the Integration doc holds exactly the 16 documented routes under /api/v1 (14 + branch discovery)', async () => {
      const doc = SwaggerModule.createDocument(
        e2e.app,
        new DocumentBuilder().setTitle('audit').build(),
        { include: [IntegrationModule] },
      );
      const got: string[] = [];
      for (const [p, ops] of Object.entries(doc.paths))
        for (const m of Object.keys(ops as object))
          got.push(`${m.toUpperCase()} ${p.replace(/^\/api\/v1/, '')}`);
      got.sort();
      note({
        id: 'A-01',
        category: 'A',
        title: 'Route registration',
        route: 'OpenAPI /docs/integrations',
        expected: '16 documented routes (14 audited + GET /integrations/branches[/{id}])',
        actual: { count: got.length, routes: got },
      });
      expect(got).toEqual(EXPECTED_ROUTES);
    });

    it('A-02 both documented key header forms work; Bearer is not accepted', async () => {
      const a = await call('get', '/integrations/me', { key: fullKey });
      const b = await call('get', '/integrations/me', {
        headers: { Authorization: `ApiKey ${fullKey}` },
      });
      const c = await call('get', '/integrations/me', {
        headers: { Authorization: `Bearer ${fullKey}` },
      });
      note({
        id: 'A-02',
        category: 'A',
        title: 'Auth header formats',
        route: 'GET /integrations/me',
        expected: 'X-API-Key 200, Authorization: ApiKey 200, Bearer 401',
        actual: { xApiKey: a.status, apiKeyScheme: b.status, bearer: c.status },
        requestIds: rid(a, b, c),
      });
      expect([a.status, b.status, c.status]).toEqual([200, 200, 401]);
    });

    it('A-03 JSON content type; error body carries the documented fields and X-Request-Id matches requestId', async () => {
      const ok = await call('get', '/integrations/me', { key: fullKey });
      const err = await call('get', '/integrations/customers', {});
      const keys = Object.keys(err.body).sort();
      note({
        id: 'A-03',
        category: 'A',
        title: 'Response format / error shape',
        route: 'GET /integrations/customers (no key)',
        expected:
          'application/json; error has statusCode, code, message, path, timestamp, requestId',
        actual: {
          okContentType: ok.headers['content-type'],
          errContentType: err.headers['content-type'],
          errorKeys: keys,
          headerEqualsBody: err.headers['x-request-id'] === err.body.requestId,
        },
        requestIds: rid(ok, err),
      });
      expect(ok.headers['content-type']).toMatch(/application\/json/);
      expect(err.headers['content-type']).toMatch(/application\/json/);
      for (const k of ['statusCode', 'code', 'message', 'path', 'timestamp', 'requestId'])
        expect(err.body).toHaveProperty(k);
      expect(err.headers['x-request-id']).toBe(err.body.requestId);
    });

    it('A-04 a caller-supplied X-Request-Id is honoured only when short and boring; otherwise replaced', async () => {
      const long = 'x'.repeat(2000);
      const r = await call('get', '/integrations/me', {
        key: fullKey,
        headers: { 'X-Request-Id': long },
      });
      const good = await call('get', '/integrations/me', {
        key: fullKey,
        headers: { 'X-Request-Id': 'pms-req_42.abc:1' },
      });
      const odd = await call('get', '/integrations/me', {
        key: fullKey,
        headers: { 'X-Request-Id': 'has spaces <b>' },
      });
      note({
        id: 'A-04',
        category: 'A',
        title: 'Request-id echo bounds',
        route: 'GET /integrations/me',
        expected: '1-128 chars of [A-Za-z0-9._:-] echoed; anything else replaced by a generated id',
        actual: {
          status: r.status,
          oversizedEchoedLength: String(r.headers['x-request-id'] ?? '').length,
          goodEchoed: good.headers['x-request-id'],
          oddEchoed: odd.headers['x-request-id'],
        },
        finding: 'C11',
      });
      expect(r.status).toBe(200);
      expect(String(r.headers['x-request-id']).length).toBeLessThanOrEqual(128);
      expect(r.headers['x-request-id']).not.toBe(long);
      expect(good.headers['x-request-id']).toBe('pms-req_42.abc:1');
      expect(odd.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('A-06 build identity: X-App-Revision carries a validated commit id only when configured; nothing else leaks', async () => {
      const prev = process.env.APP_REVISION;
      try {
        process.env.APP_REVISION = '4ce6770';
        const withRev = await call('get', '/integrations/me', { key: fullKey });
        const live = await call('get', '/system/health/liveness');
        process.env.APP_REVISION = 'not-a-sha; SECRET=abc';
        const bad = await call('get', '/integrations/me', { key: fullKey });
        const badLive = await call('get', '/system/health/liveness');
        delete process.env.APP_REVISION;
        const none = await call('get', '/integrations/me', { key: fullKey });
        note({
          id: 'A-06',
          category: 'A',
          title: 'Build identity',
          route: 'GET /system/health/liveness + X-App-Revision',
          expected: 'revision = validated hex commit id; invalid → "unknown"/no header; no other build data',
          actual: {
            header: withRev.headers['x-app-revision'],
            liveness: live.body.revision,
            invalidHeader: bad.headers['x-app-revision'] ?? null,
            invalidLiveness: badLive.body.revision,
            unsetHeader: none.headers['x-app-revision'] ?? null,
          },
          finding: 'BL-02',
        });
        expect(withRev.headers['x-app-revision']).toBe('4ce6770');
        expect(live.body.revision).toBe('4ce6770');
        expect(bad.headers['x-app-revision']).toBeUndefined();
        expect(badLive.body.revision).toBe('unknown');
        expect(none.headers['x-app-revision']).toBeUndefined();
        expect(JSON.stringify(live.body)).not.toMatch(/SECRET|env|host|branch/i);
      } finally {
        if (prev === undefined) delete process.env.APP_REVISION;
        else process.env.APP_REVISION = prev;
      }
    });

    it('A-05 Swagger declares error responses for the documented error codes (observation)', async () => {
      const doc = SwaggerModule.createDocument(
        e2e.app,
        new DocumentBuilder().setTitle('audit').build(),
        { include: [IntegrationModule] },
      );
      const table: Record<string, string[]> = {};
      for (const [p, ops] of Object.entries(doc.paths))
        for (const [m, op] of Object.entries(ops as Record<string, any>))
          table[`${m.toUpperCase()} ${p}`] = Object.keys(op.responses ?? {}).sort();
      const without401 = Object.entries(table)
        .filter(([, codes]) => !codes.includes('401'))
        .map(([k]) => k);
      note({
        id: 'A-05',
        category: 'A',
        title: 'Swagger response declarations',
        route: 'OpenAPI /docs/integrations',
        expected:
          'every operation declares 401/403/429/503 and upserts declare 400/409/413/422',
        actual: { operationsWithout401: without401.length, declared: table },
        finding: 'C12',
      });
      expect(Object.keys(table)).toHaveLength(16);
      for (const [op, codes] of Object.entries(table)) {
        for (const c of ['401', '403', '429', '503']) expect([op, codes]).toEqual([op, expect.arrayContaining([c])]);
        if (op.startsWith('POST')) {
          for (const c of ['200', '400', '409', '413', '422'])
            expect([op, codes]).toEqual([op, expect.arrayContaining([c])]);
        }
      }
    });
  });

  // ══ B. keys & scopes ═════════════════════════════════════════════════════

  describe('B — API keys and scopes', () => {
    it('B-01 missing / unknown / revoked / deactivated / expired keys return an indistinguishable 401 body (documented)', async () => {
      const mk = async (perm = ['integration.services.read']) =>
        newKey(A.token, perm, `b01-${uniq()}`);
      const revoked = await mk();
      await call('post', `/platform/api-keys/${revoked.id}/revoke`, { jwt: A.token, body: {} });
      const deactivated = await mk();
      await call('post', `/platform/api-keys/${deactivated.id}/deactivate`, { jwt: A.token, body: {} });
      const expired = await mk();
      await sql(
        `UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE id = $1 AND "tenantId" = $2`,
        [expired.id, A.tenantId],
      );
      const cases: Record<string, Res> = {
        missing: await call('get', '/integrations/services'),
        unknown: await call('get', '/integrations/services', { key: 'zk_' + 'q'.repeat(43) }),
        revoked: await call('get', '/integrations/services', { key: revoked.key }),
        deactivated: await call('get', '/integrations/services', { key: deactivated.key }),
        expired: await call('get', '/integrations/services', { key: expired.key }),
      };
      const shape = (r: Res) => ({
        status: r.status,
        code: r.body.code,
        message: r.body.message,
      });
      const observed = Object.fromEntries(
        Object.entries(cases).map(([k, v]) => [k, shape(v)]),
      );
      const messages = new Set(
        Object.entries(cases)
          .filter(([k]) => k !== 'missing')
          .map(([, v]) => v.body.message),
      );
      note({
        id: 'B-01',
        category: 'B',
        title: '401 uniformity',
        route: 'GET /integrations/services',
        expected:
          'guide: missing/unknown/expired/revoked → 401 UNAUTHORIZED with the same body (reason not disclosed)',
        actual: observed,
        requestIds: rid(...Object.values(cases)),
        finding: 'C3',
      });
      for (const r of Object.values(cases)) expect(r.status).toBe(401);
      expect(messages.size).toBe(1);
    });

    it('B-02 every data route refuses a key without the exact scope (403, before body validation); /me needs no scope', async () => {
      const zero = await newKey(A.token, undefined, 'b02-zero');
      const ro = await newKey(A.token, ['integration.customers.read'], 'b02-ro');
      const uuid = randomUUID();
      const routes: [string, string, string | null, unknown?][] = [
        ['get', '/integrations/services', 'integration.services.read'],
        ['get', `/integrations/services/${uuid}`, 'integration.services.read'],
        ['get', '/integrations/staff', 'integration.staff.read'],
        ['get', `/integrations/staff/${uuid}`, 'integration.staff.read'],
        ['get', '/integrations/customers', 'integration.customers.read'],
        ['get', `/integrations/customers/${uuid}`, 'integration.customers.read'],
        ['get', '/integrations/appointments', 'integration.appointments.read'],
        ['get', `/integrations/appointments/${uuid}`, 'integration.appointments.read'],
        ['get', '/integrations/availability', 'integration.availability.read'],
        ['post', '/integrations/customers/upsert', 'integration.customers.write', {}],
        ['post', '/integrations/services/upsert', 'integration.services.write', {}],
        ['post', '/integrations/staff/upsert', 'integration.staff.write', {}],
        ['post', '/integrations/appointments/upsert', 'integration.appointments.write', {}],
      ];
      const failures: string[] = [];
      const rows: Record<string, number[]> = {};
      for (const [m, url, scope, body] of routes) {
        const z = await call(m as any, url, { key: zero.key, body });
        const r = await call(m as any, url, { key: ro.key, body });
        rows[`${m.toUpperCase()} ${url.replace(uuid, ':id')}`] = [z.status, r.status];
        if (z.status !== 403) failures.push(`zero-scope ${m} ${url} → ${z.status}`);
        if (scope !== 'integration.customers.read' && r.status !== 403)
          failures.push(`customers.read-only ${m} ${url} → ${r.status}`);
      }
      const me = await call('get', '/integrations/me', { key: zero.key });
      note({
        id: 'B-02',
        category: 'B',
        title: 'Scope enforcement matrix',
        route: '13 data routes + /me',
        expected: 'wrong/no scope → 403 on all 13; /me → 200 with zero scopes',
        actual: { statusPairs_zero_ro: rows, me: me.status, failures },
      });
      expect(failures).toEqual([]);
      expect(me.status).toBe(200);
    });

    it('B-03 /me never discloses the secret, hash or tenant id', async () => {
      const me = await call('get', '/integrations/me', { key: fullKey });
      note({
        id: 'B-03',
        category: 'B',
        title: '/me disclosure',
        route: 'GET /integrations/me',
        expected: 'keyId, keyPrefix, name, scopes, expiresAt, lastUsedAt, tenantName only',
        actual: { keys: Object.keys(me.body).sort() },
        requestIds: rid(me),
      });
      expect(me.status).toBe(200);
      expect(me.text).not.toContain(fullKey);
      expect(me.text).not.toContain(A.tenantId);
      expect(me.text.toLowerCase()).not.toMatch(/key_hash|"hash"|tenantid/);
    });

    it('B-04 rotation is immediate: the old key is dead on the next request, the new key works', async () => {
      const k = await newKey(A.token, ['integration.services.read'], 'b04');
      const rot = await call('post', `/platform/api-keys/${k.id}/rotate`, { jwt: A.token, body: {} });
      secrets.push(rot.body.apiKey);
      const old = await call('get', '/integrations/services', { key: k.key });
      const fresh = await call('get', '/integrations/services', { key: rot.body.apiKey });
      note({
        id: 'B-04',
        category: 'B',
        title: 'Rotation / revocation immediacy',
        route: 'POST /platform/api-keys/:id/rotate',
        expected: 'old 401, new 200, no grace period',
        actual: { rotate: rot.status, old: old.status, fresh: fresh.status },
        requestIds: rid(old, fresh),
      });
      expect([old.status, fresh.status]).toEqual([401, 200]);
    });

    it("B-05 the tenant comes only from the key: a forged tenant header/query/body never widens access", async () => {
      const bCust = await upsert('customers', bKey, connB, `B-${uniq()}`, goodCustomer());
      const baseline = await call('get', '/integrations/customers?limit=100', { key: fullKey });
      const forgedHeader = await call('get', '/integrations/customers?limit=100', {
        key: fullKey,
        headers: { 'X-Tenant-Id': B.tenantId, 'X-Tenant': B.tenantId },
      });
      const forgedQuery = await call('get', `/integrations/customers?tenantId=${B.tenantId}`, {
        key: fullKey,
      });
      const forgedBody = await call('post', '/integrations/customers/upsert', {
        key: fullKey,
        body: {
          connectionId: connExt,
          externalId: `F-${uniq()}`,
          tenantId: B.tenantId,
          data: goodCustomer(),
        },
      });
      const ids = (r: Res) => (r.body.data ?? []).map((c: any) => c.id);
      note({
        id: 'B-05',
        category: 'B',
        title: 'Tenant resolution',
        route: 'GET/POST /integrations/customers*',
        expected: 'forged tenant ignored/rejected; B data never returned',
        actual: {
          baselineTotal: baseline.body.total,
          headerTotal: forgedHeader.body.total,
          queryStatus: forgedQuery.status,
          bodyStatus: forgedBody.status,
        },
        requestIds: rid(baseline, forgedHeader, forgedQuery, forgedBody),
      });
      expect(forgedHeader.status).toBe(200);
      expect(ids(forgedHeader)).toEqual(ids(baseline));
      expect(forgedHeader.text).not.toContain(bCust.body.internalId);
      expect(forgedQuery.status).toBe(400);
      expect(forgedBody.status).toBe(400);
    });

    it('B-06 no plaintext key or secret appears in api_logs or any captured response after creation', async () => {
      const rows = await sql(
        `SELECT row_to_json(a)::text AS t FROM api_logs a WHERE a."tenantId" = $1`,
        [A.tenantId],
      );
      const blob = rows.map((r: any) => r.t).join('\n');
      const leaksInLogs = secrets.filter((s) => s && blob.includes(s)).length;
      note({
        id: 'B-06',
        category: 'B',
        title: 'Secret leakage in api_logs',
        route: 'api_logs table',
        expected: 'no plaintext key in logs',
        actual: { logRows: rows.length, secretsChecked: secrets.length, leaksInLogs },
      });
      expect(leaksInLogs).toBe(0);
    });
  });

  // ══ C. reads ═════════════════════════════════════════════════════════════

  describe('C — read endpoints', () => {
    beforeAll(async () => {
      for (let i = 0; i < 7; i++)
        await upsert('customers', fullKey, connExt, `C-${uniq()}`, goodCustomer());
    }, 60_000);

    it('C-01 pagination boundaries: limit 1/100 ok; 0, 101, -1, abc and page 0 are 400; a page past the end is an empty 200', async () => {
      const q = async (qs: string) => call('get', `/integrations/customers?${qs}`, { key: fullKey });
      const r: Record<string, Res> = {
        limit1: await q('limit=1'),
        limit100: await q('limit=100'),
        limit101: await q('limit=101'),
        limit0: await q('limit=0'),
        limitNeg: await q('limit=-1'),
        limitAbc: await q('limit=abc'),
        page0: await q('page=0'),
        pageBeyond: await q('page=9999&limit=10'),
      };
      note({
        id: 'C-01',
        category: 'C',
        title: 'Pagination boundaries',
        route: 'GET /integrations/customers',
        expected: 'max limit 100; invalid → 400; beyond last page → 200 with empty data',
        actual: Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, { status: v.status, code: v.body.code, count: v.body.data?.length }]),
        ),
        requestIds: rid(...Object.values(r)),
      });
      expect(r.limit1.status).toBe(200);
      expect(r.limit1.body.data).toHaveLength(1);
      expect(r.limit100.status).toBe(200);
      for (const k of ['limit101', 'limit0', 'limitNeg', 'limitAbc', 'page0'])
        expect(r[k].status).toBe(400);
      expect(r.pageBeyond.status).toBe(200);
      expect(r.pageBeyond.body.data).toEqual([]);
      expect(r.pageBeyond.body.total).toBeGreaterThan(0);
    });

    it('C-02 a full walk in pages of 3 yields every record exactly once, in a stable order', async () => {
      const seen: string[] = [];
      let total = 0;
      for (let page = 1; page < 20; page++) {
        const res = await call('get', `/integrations/customers?limit=3&page=${page}`, { key: fullKey });
        total = res.body.total;
        if (!res.body.data.length) break;
        seen.push(...res.body.data.map((c: any) => c.id));
      }
      note({
        id: 'C-02',
        category: 'C',
        title: 'Stable ordering across pages',
        route: 'GET /integrations/customers',
        expected: 'no repeats / skips',
        actual: { total, seen: seen.length, unique: new Set(seen).size },
      });
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(total);
    });

    it('C-03 detail endpoints: nonexistent → 404, cross-tenant → 404, malformed id → 400, for all four resources', async () => {
      const aCust = (await call('get', '/integrations/customers?limit=1', { key: fullKey })).body.data[0].id;
      const aSvc = (await call('get', '/integrations/services?limit=1', { key: fullKey })).body.data[0].id;
      const aAppt = await upsert('appointments', fullKey, connExt, `C03-${uniq()}`, apptData(slot()));
      expect(aAppt.status).toBe(200);
      const out: Record<string, number[]> = {};
      const bad: string[] = [];
      for (const [res, id] of [
        ['customers', aCust],
        ['services', aSvc],
        ['staff', staffId],
        ['appointments', aAppt.body.internalId],
      ] as const) {
        const none = await call('get', `/integrations/${res}/${randomUUID()}`, { key: fullKey });
        const cross = await call('get', `/integrations/${res}/${id}`, { key: bKey });
        const malformed = await call('get', `/integrations/${res}/not-a-uuid`, { key: fullKey });
        const own = await call('get', `/integrations/${res}/${id}`, { key: fullKey });
        out[res] = [none.status, cross.status, malformed.status, own.status];
        if (none.status !== 404) bad.push(`${res} nonexistent ${none.status}`);
        if (cross.status !== 404) bad.push(`${res} cross-tenant ${cross.status}`);
        if (malformed.status !== 400) bad.push(`${res} malformed ${malformed.status}`);
        if (own.status !== 200) bad.push(`${res} own ${own.status}`);
      }
      note({
        id: 'C-03',
        category: 'C',
        title: 'Detail lookups and IDOR',
        route: 'GET /integrations/{res}/:id',
        expected: '[nonexistent,cross-tenant,malformed,own] = [404,404,400,200]',
        actual: out,
      });
      expect(bad).toEqual([]);
    });

    it('C-04 response projections are the documented allow-lists (no tenant ids, amounts, notes or internals)', async () => {
      const want: Record<string, string[]> = {
        customers: ['createdAt', 'email', 'fullName', 'id', 'isActive', 'phone', 'updatedAt'],
        appointments: ['branchId', 'createdAt', 'customerId', 'endAt', 'id', 'source', 'staffId', 'startAt', 'status', 'updatedAt'],
      };
      const got: Record<string, string[]> = {};
      for (const res of ['customers', 'services', 'staff', 'appointments']) {
        const r = await call('get', `/integrations/${res}?limit=1`, { key: fullKey });
        got[res] = r.body.data[0] ? Object.keys(r.body.data[0]).sort() : [];
        expect(r.text.toLowerCase()).not.toMatch(/tenantid|tenant_id|password|key_hash|deleted_at/);
      }
      note({
        id: 'C-04',
        category: 'C',
        title: 'Field allow-lists',
        route: 'GET /integrations/{res}',
        expected: 'documented projection',
        actual: got,
      });
      expect(got.customers).toEqual(want.customers);
      expect(got.appointments).toEqual(want.appointments);
    });

    it('C-05 availability honours branch, staff, schedule and duration; missing/unknown/cross-tenant inputs are refused', async () => {
      const s = slot(30);
      const ok = await call('get', `/integrations/availability?branchId=${branchId}&staffId=${staffId}&date=${s.date}`, { key: fullKey });
      const missing = await call('get', `/integrations/availability?branchId=${branchId}&date=${s.date}`, { key: fullKey });
      const unknownStaff = await call('get', `/integrations/availability?branchId=${branchId}&staffId=${randomUUID()}&date=${s.date}`, { key: fullKey });
      const crossTenant = await call('get', `/integrations/availability?branchId=${branchId}&staffId=${staffId}&date=${s.date}`, { key: bKey });
      note({
        id: 'C-05',
        category: 'C',
        title: 'Availability',
        route: 'GET /integrations/availability',
        expected:
          '200 with windows inside the 08:00–20:00 (Asia/Riyadh) schedule; missing params 400; unknown/cross-tenant 404',
        actual: {
          ok: { status: ok.status, available: ok.body.available, timezone: ok.body.timezone, windows: (ok.body.windows ?? []).slice(0, 3), reason: ok.body.reason },
          missing: missing.status,
          unknownStaff: unknownStaff.status,
          crossTenant: crossTenant.status,
        },
        requestIds: rid(ok, missing, unknownStaff, crossTenant),
      });
      expect(ok.status).toBe(200);
      expect(ok.body.available).toBe(true);
      expect(ok.body.timezone).toBe('Asia/Riyadh');
      expect(missing.status).toBe(400);
      expect(unknownStaff.status).toBe(404);
      expect([404, 403]).toContain(crossTenant.status);
    });

    it('C-06 unknown query parameters are rejected (400) on every list endpoint', async () => {
      const out: Record<string, number> = {};
      for (const res of ['services', 'staff', 'customers', 'appointments']) {
        const r = await call('get', `/integrations/${res}?bogusParam=1`, { key: fullKey });
        out[res] = r.status;
      }
      note({
        id: 'C-06',
        category: 'C',
        title: 'Unknown query params',
        route: 'GET /integrations/{res}',
        expected: '400 (forbidNonWhitelisted)',
        actual: out,
      });
      expect(Object.values(out)).toEqual([400, 400, 400, 400]);
    });

    it("C-07 clinic B's key sees none of clinic A's services, staff or customers in lists", async () => {
      const svc = await call('get', '/integrations/services?limit=100', { key: bKey });
      const stf = await call('get', '/integrations/staff?limit=100', { key: bKey });
      const cus = await call('get', '/integrations/customers?limit=100', { key: bKey });
      note({
        id: 'C-07',
        category: 'C',
        title: 'List isolation',
        route: 'GET /integrations/{res}',
        expected: "only B's records",
        actual: { services: svc.body.total, staff: stf.body.total, customers: cus.body.total },
      });
      expect(svc.text).not.toContain(serviceId);
      expect(stf.text).not.toContain(staffId);
      expect((cus.body.data as any[]).every((c) => c.fullName)).toBe(true);
      expect(svc.text).toContain(bServiceId);
    });
  });

  // ══ D. upserts ═══════════════════════════════════════════════════════════

  describe('D — upserts', () => {
    it('D-01 under the DEFAULT conflict policy a partner can update the record it created (documented: create / update)', async () => {
      const ext = `D01-${uniq()}`;
      const base = goodCustomer();
      const created = await upsert('customers', fullKey, connDefault, ext, base);
      const updated = await upsert('customers', fullKey, connDefault, ext, {
        ...base,
        full_name: base.full_name + ' (edited)',
      });
      const row = await sql(`SELECT full_name FROM customers WHERE id = $1`, [created.body.internalId]);
      const conflicts = await sql(`SELECT count(*)::int n FROM integration_conflicts WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'D-01',
        category: 'D',
        title: 'Default policy: partner updates its own record',
        route: 'POST /integrations/customers/upsert',
        expected: 'second call outcome "updated" and the name changes (guide: create/update via upsert)',
        actual: {
          created: created.body.outcome,
          secondStatus: updated.status,
          secondOutcome: updated.body.outcome,
          changedFields: updated.body.changedFields,
          dbName: row[0]?.full_name,
          conflictRowsForTenant: conflicts[0].n,
        },
        requestIds: rid(created, updated),
        finding: 'C2',
      });
      expect(created.body.outcome).toBe('created');
      expect(updated.body.outcome).toBe('updated');
      expect(row[0].full_name).toBe(base.full_name + ' (edited)');
    });

    it('D-02 conflict policies: external_wins updates, platform_wins skips (state unchanged), reject_and_report reports', async () => {
      const out: Record<string, any> = {};
      for (const [label, conn] of [
        ['external_wins', connExt],
        ['platform_wins', connPlat],
        ['reject_and_report', connDefault],
      ] as const) {
        const ext = `D02-${label}-${uniq()}`;
        const base = goodCustomer();
        const c = await upsert('customers', fullKey, conn, ext, base);
        const u = await upsert('customers', fullKey, conn, ext, { ...base, full_name: `${base.full_name} v2` });
        const row = await sql(`SELECT full_name FROM customers WHERE id = $1`, [c.body.internalId]);
        out[label] = {
          second: u.body.outcome,
          status: u.status,
          nameChanged: row[0].full_name !== base.full_name,
        };
      }
      note({
        id: 'D-02',
        category: 'D',
        title: 'Conflict policy behaviour',
        route: 'POST /integrations/customers/upsert',
        expected:
          'external_wins→updated; platform_wins→skipped(not applied); reject_and_report (default) → updated while the clinic has not touched the record',
        actual: out,
        finding: 'C2',
      });
      expect(out.external_wins).toMatchObject({ second: 'updated', nameChanged: true });
      expect(out.platform_wins).toMatchObject({ second: 'skipped', nameChanged: false });
      expect(out.reject_and_report).toMatchObject({ second: 'updated', status: 200, nameChanged: true });
    });

    it('D-03 an unmatched staff record is not created: it is reported, not silently accepted as success', async () => {
      const before = await sql(`SELECT count(*)::int n FROM staff_profiles WHERE "tenantId" = $1`, [A.tenantId]);
      const r = await upsert('staff', fullKey, connExt, `D03-${uniq()}`, { title: 'Ghost Doctor' });
      const after = await sql(`SELECT count(*)::int n FROM staff_profiles WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'D-03',
        category: 'D',
        title: 'Staff is update/link only',
        route: 'POST /integrations/staff/upsert',
        expected:
          'no staff row created; guide: "queued for the clinic to review"; documented outcomes do not include a bare success',
        actual: { status: r.status, body: r.body, staffBefore: before[0].n, staffAfter: after[0].n },
        requestIds: rid(r),
        finding: 'C2',
        needsReview: true,
      });
      expect(after[0].n).toBe(before[0].n);
      expect(r.body.internalId ?? null).toBeNull();
    });

    it('D-04 connection checks: unknown / other-tenant → 404; deactivated and disconnected → 422', async () => {
      const tmp = await newConnection(A.token, 'external_wins');
      await call('post', `/platform/integrations/connections/${tmp}/deactivate`, { jwt: A.token, body: {} });
      const tmp2 = await newConnection(A.token, 'external_wins');
      await call('post', `/platform/integrations/connections/${tmp2}/disconnect`, { jwt: A.token, body: {} });
      const r = {
        unknown: await upsert('customers', fullKey, randomUUID(), `D04-${uniq()}`, goodCustomer()),
        otherTenant: await upsert('customers', fullKey, connB, `D04-${uniq()}`, goodCustomer()),
        inactive: await upsert('customers', fullKey, tmp, `D04-${uniq()}`, goodCustomer()),
        disconnected: await upsert('customers', fullKey, tmp2, `D04-${uniq()}`, goodCustomer()),
      };
      note({
        id: 'D-04',
        category: 'D',
        title: 'Connection ownership / state',
        route: 'POST /integrations/customers/upsert',
        expected: 'unknown 404, other tenant 404, inactive 422, disconnected 422',
        actual: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])),
        requestIds: rid(...Object.values(r)),
      });
      expect([r.unknown.status, r.otherTenant.status, r.inactive.status, r.disconnected.status]).toEqual([404, 404, 422, 422]);
    });

    it('D-05 malformed envelopes are refused with 400 and nothing is written', async () => {
      const before = await sql(`SELECT count(*)::int n FROM customers WHERE "tenantId" = $1`, [A.tenantId]);
      const bodies: Record<string, unknown> = {
        badConnectionId: { connectionId: 'abc', externalId: 'x', data: goodCustomer() },
        emptyExternalId: { connectionId: connExt, externalId: '', data: goodCustomer() },
        longExternalId: { connectionId: connExt, externalId: 'x'.repeat(256), data: goodCustomer() },
        dataArray: { connectionId: connExt, externalId: 'x', data: [] },
        dataString: { connectionId: connExt, externalId: 'x', data: 'nope' },
        missingData: { connectionId: connExt, externalId: 'x' },
        extraTopLevel: { connectionId: connExt, externalId: 'x', data: goodCustomer(), isAdmin: true },
      };
      const out: Record<string, number> = {};
      for (const [k, b] of Object.entries(bodies))
        out[k] = (await call('post', '/integrations/customers/upsert', { key: fullKey, body: b })).status;
      const after = await sql(`SELECT count(*)::int n FROM customers WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'D-05',
        category: 'D',
        title: 'Malformed payloads',
        route: 'POST /integrations/customers/upsert',
        expected: 'all 400; no rows',
        actual: out,
      });
      expect(Object.values(out).every((s) => s === 400)).toBe(true);
      expect(after[0].n).toBe(before[0].n);
    });

    it('D-06 platform-owned fields are rejected with 422 + context.protectedFields, per resource, and nothing is written', async () => {
      const cases: [string, 'customers' | 'services' | 'staff', Record<string, unknown>][] = [
        ['customer id', 'customers', { ...goodCustomer(), id: randomUUID() }],
        ['customer created_at', 'customers', { ...goodCustomer(), created_at: '2020-01-01T00:00:00Z' }],
        ['service id', 'services', { name: `S ${uniq()}`, durationMinutes: 30, id: randomUUID() }],
        ['staff roles', 'staff', { title: 'x', roles: ['owner'] }],
      ];
      const before = await sql(`SELECT count(*)::int n FROM customers WHERE "tenantId" = $1`, [A.tenantId]);
      const out: Record<string, any> = {};
      for (const [label, res, data] of cases) {
        const r = await upsert(res, fullKey, connExt, `D06-${uniq()}`, data);
        out[label] = { status: r.status, protectedFields: r.body.context?.protectedFields };
      }
      const after = await sql(`SELECT count(*)::int n FROM customers WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'D-06',
        category: 'D',
        title: 'Protected fields (customers, services, staff)',
        route: 'POST /integrations/{res}/upsert',
        expected: '422 with protectedFields; DB unchanged',
        actual: out,
      });
      for (const v of Object.values(out)) expect(v.status).toBe(422);
      expect(after[0].n).toBe(before[0].n);
    });

    it('D-07 injection strings are stored inert; nested tenant ids cannot redirect a write', async () => {
      const evil = `x'; DROP TABLE customers; --`;
      const ext = `D07-${uniq()}`;
      const r = await upsert('customers', fullKey, connExt, ext, {
        ...goodCustomer(),
        full_name: evil,
        address: { tenant_id: B.tenantId, tenantId: B.tenantId },
      });
      const tbl = await sql(`SELECT to_regclass('public.customers') AS t`);
      const row = r.body.internalId
        ? await sql(`SELECT full_name, "tenantId" FROM customers WHERE id = $1`, [r.body.internalId])
        : [];
      const readBack = r.body.internalId
        ? await call('get', `/integrations/customers/${r.body.internalId}`, { key: fullKey })
        : undefined;
      note({
        id: 'D-07',
        category: 'D',
        title: 'Injection / nested tenant id',
        route: 'POST /integrations/customers/upsert',
        expected: 'table intact; stored literally; row belongs to tenant A',
        actual: { status: r.status, tableExists: !!tbl[0].t, stored: row[0]?.full_name, tenantIsA: row[0]?.tenantId === A.tenantId },
        requestIds: rid(r),
      });
      expect(tbl[0].t).toBeTruthy();
      if (r.status === 200) {
        expect(row[0].tenantId).toBe(A.tenantId);
        expect(readBack?.body.fullName).toBe(evil);
      } else {
        expect([400, 422]).toContain(r.status);
      }
    });

    it('D-08 documented unsupported capabilities stay unsupported (no bulk, no lookup by externalId)', async () => {
      const r = {
        bulk: await call('post', '/integrations/customers/bulk', { key: fullKey, body: { records: [] } }),
        batch: await call('post', '/integrations/customers/batch', { key: fullKey, body: {} }),
        byExternal: await call('get', '/integrations/customers/by-external/abc', { key: fullKey }),
        queryExternal: await call('get', '/integrations/customers?externalId=abc', { key: fullKey }),
        deleteHard: await call('delete', `/integrations/customers/${randomUUID()}`, { key: fullKey }),
      };
      note({
        id: 'D-08',
        category: 'D',
        title: 'Unsupported capabilities',
        route: 'various',
        expected: 'no 2xx on any of them',
        actual: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])),
      });
      for (const v of Object.values(r)) expect(v.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ══ E. idempotency ═══════════════════════════════════════════════════════

  describe('E — idempotency and concurrency', () => {
    it('E-01 same key + same body replays the original outcome (one record)', async () => {
      const ext = `E01-${uniq()}`;
      const body = goodCustomer();
      const key = `idem-${uniq()}`;
      const a = await upsert('customers', fullKey, connExt, ext, body, { 'Idempotency-Key': key });
      const b = await upsert('customers', fullKey, connExt, ext, body, { 'Idempotency-Key': key });
      const n = await sql(`SELECT count(*)::int n FROM customers WHERE "tenantId" = $1 AND phone = $2`, [A.tenantId, body.phone]);
      note({
        id: 'E-01',
        category: 'E',
        title: 'Idempotent replay',
        route: 'POST /integrations/customers/upsert',
        expected: 'identical response, one record',
        actual: { first: a.body, second: b.body, rows: n[0].n },
        requestIds: rid(a, b),
      });
      expect(b.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(n[0].n).toBe(1);
    });

    it('E-02 same key + different body → 422', async () => {
      const key = `idem-${uniq()}`;
      const ext = `E02-${uniq()}`;
      await upsert('customers', fullKey, connExt, ext, goodCustomer(), { 'Idempotency-Key': key });
      const r = await upsert('customers', fullKey, connExt, ext, goodCustomer(), { 'Idempotency-Key': key });
      note({
        id: 'E-02',
        category: 'E',
        title: 'Key reuse with different body',
        route: 'POST /integrations/customers/upsert',
        expected: '422 UNPROCESSABLE_ENTITY',
        actual: { status: r.status, code: r.body.code },
        requestIds: rid(r),
      });
      expect(r.status).toBe(422);
    });

    it('E-03 10 simultaneous identical requests with one key create exactly one record; the rest are replay or 409', async () => {
      const key = `idem-${uniq()}`;
      const ext = `E03-${uniq()}`;
      const body = goodCustomer();
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          upsert('customers', fullKey, connExt, ext, body, { 'Idempotency-Key': key }),
        ),
      );
      const n = await sql(`SELECT count(*)::int n FROM customers WHERE "tenantId" = $1 AND phone = $2`, [A.tenantId, body.phone]);
      const m = await sql(`SELECT count(*)::int n FROM integration_id_map WHERE "tenantId" = $1 AND external_id = $2`, [A.tenantId, ext]);
      const statuses = rs.map((r) => r.status).sort();
      note({
        id: 'E-03',
        category: 'E',
        title: 'Concurrent same key',
        route: 'POST /integrations/customers/upsert',
        expected: 'statuses ⊆ {200,409}; 1 customer; 1 mapping; no 5xx',
        actual: { statuses, customers: n[0].n, mappings: m[0].n },
      });
      expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
      expect(statuses).toContain(200);
      expect(n[0].n).toBe(1);
      expect(m[0].n).toBe(1);
    });

    it('E-04 10 simultaneous requests WITHOUT a key for one externalId still yield one record and one mapping', async () => {
      const ext = `E04-${uniq()}`;
      const body = goodCustomer();
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => upsert('customers', fullKey, connExt, ext, body)),
      );
      const n = await sql(`SELECT count(*)::int n FROM customers WHERE "tenantId" = $1 AND phone = $2`, [A.tenantId, body.phone]);
      const m = await sql(`SELECT count(*)::int n FROM integration_id_map WHERE "tenantId" = $1 AND external_id = $2 AND unlinked_at IS NULL`, [A.tenantId, ext]);
      const statuses = rs.map((r) => r.status);
      note({
        id: 'E-04',
        category: 'E',
        title: 'Concurrent without key (race on mapping)',
        route: 'POST /integrations/customers/upsert',
        expected: 'one customer, one mapping, no 5xx',
        actual: { statuses: [...statuses].sort(), customers: n[0].n, mappings: m[0].n },
      });
      expect(statuses.every((s) => s < 500)).toBe(true);
      expect(n[0].n).toBe(1);
      expect(m[0].n).toBe(1);
    });

    it('E-05 an idempotency key is scoped per clinic: clinic B can use the same string with a different body', async () => {
      const key = `shared-${uniq()}`;
      await upsert('customers', fullKey, connExt, `E05-${uniq()}`, goodCustomer(), { 'Idempotency-Key': key });
      const b = await upsert('customers', bKey, connB, `E05-${uniq()}`, goodCustomer(), { 'Idempotency-Key': key });
      note({
        id: 'E-05',
        category: 'E',
        title: 'Key scope',
        route: 'POST /integrations/customers/upsert',
        expected: '200 for B',
        actual: { status: b.status },
        requestIds: rid(b),
      });
      expect(b.status).toBe(200);
    });

    it('E-06 a failed request releases its key: retrying the corrected body with the same key succeeds', async () => {
      const key = `idem-${uniq()}`;
      const ext = `E06-${uniq()}`;
      const bad = await upsert('customers', fullKey, connExt, ext, { ...goodCustomer(), id: randomUUID() }, { 'Idempotency-Key': key });
      const good = await upsert('customers', fullKey, connExt, ext, goodCustomer(), { 'Idempotency-Key': key });
      note({
        id: 'E-06',
        category: 'E',
        title: 'Retry after failure',
        route: 'POST /integrations/customers/upsert',
        expected: 'first 422, retry 200 created',
        actual: { first: bad.status, retry: good.status, outcome: good.body.outcome },
      });
      expect(bad.status).toBe(422);
      expect(good.status).toBe(200);
      expect(good.body.outcome).toBe('created');
    });

    it('E-07 a key older than its 24 h window is treated as new (documented retention)', async () => {
      const key = `idem-${uniq()}`;
      const ext = `E07-${uniq()}`;
      await upsert('customers', fullKey, connExt, ext, goodCustomer(), { 'Idempotency-Key': key });
      await sql(
        `UPDATE integration_idempotency_keys SET expires_at = now() - interval '1 hour' WHERE "tenantId" = $1 AND idempotency_key = $2`,
        [A.tenantId, key],
      );
      const after = await upsert('customers', fullKey, connExt, ext, goodCustomer(), { 'Idempotency-Key': key });
      note({
        id: 'E-07',
        category: 'E',
        title: 'Idempotency expiry',
        route: 'POST /integrations/customers/upsert',
        expected: 'expired key ignored → 200 (not 422/409)',
        actual: { status: after.status, code: after.body.code, outcome: after.body.outcome },
        requestIds: rid(after),
        finding: 'C7',
      });
      expect(after.status).toBe(200);
    });

    it('E-08 an over-long Idempotency-Key is refused cleanly (never a 5xx)', async () => {
      const r = await upsert('customers', fullKey, connExt, `E08-${uniq()}`, goodCustomer(), {
        'Idempotency-Key': 'k'.repeat(300),
      });
      note({
        id: 'E-08',
        category: 'E',
        title: 'Over-long idempotency key',
        route: 'POST /integrations/customers/upsert',
        expected: '4xx',
        actual: { status: r.status, code: r.body.code },
        requestIds: rid(r),
      });
      expect(r.status).toBeLessThan(500);
    });

    it('E-09 idempotency state is persisted in the database (restart survival not exercised)', async () => {
      const key = `idem-${uniq()}`;
      await upsert('customers', fullKey, connExt, `E09-${uniq()}`, goodCustomer(), { 'Idempotency-Key': key });
      const row = await sql(
        `SELECT expires_at > now() AS live FROM integration_idempotency_keys WHERE "tenantId" = $1 AND idempotency_key = $2`,
        [A.tenantId, key],
      );
      note({
        id: 'E-09',
        category: 'E',
        title: 'Idempotency persistence',
        route: 'integration_idempotency_keys',
        expected: 'durable row with future expiry',
        actual: { rows: row.length, live: row[0]?.live },
        needsReview: true,
        remark: 'A process restart was not simulated; durability is shown at the storage layer only.',
      });
      expect(row).toHaveLength(1);
      expect(row[0].live).toBe(true);
    });
  });

  // ══ F. appointments ══════════════════════════════════════════════════════

  describe('F — appointment safety', () => {
    let fk = '';
    beforeEach(async () => {
      // a fresh key per test: the per-key bucket (120/min) is shared by every call a key makes
      fk = (await newKey(A.token, [...KEY_SCOPES_READ, ...KEY_SCOPES_WRITE], `f-${uniq()}`)).key;
    });
    it('F-01 a valid appointment is created; server-derived fields are not caller-controlled', async () => {
      const s = slot();
      const r = await upsert('appointments', fk, connExt, `F01-${uniq()}`, apptData(s));
      const row = r.body.internalId
        ? await sql(`SELECT status, source, currency, booked_timezone FROM appointments WHERE id = $1`, [r.body.internalId])
        : [];
      note({
        id: 'F-01',
        category: 'F',
        title: 'Valid create',
        route: 'POST /integrations/appointments/upsert',
        expected: '200 created; status/source/currency server-derived',
        actual: { status: r.status, outcome: r.body.outcome, row: row[0] },
        requestIds: rid(r),
      });
      expect(r.status).toBe(200);
      expect(r.body.outcome).toBe('created');
    });

    it('F-02 each missing dependency → 422 context.reason=missing_dependency and nothing is written', async () => {
      const before = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);
      const s = slot();
      const base = apptData(s);
      const variants: Record<string, Record<string, unknown>> = {
        customer: { ...base, customerExternalId: 'NOPE' },
        staff: { ...base, staffExternalId: 'NOPE' },
        service: { ...base, serviceIds: undefined, serviceExternalIds: ['NOPE'] },
        branch: { ...base, branchId: undefined },
      };
      const out: Record<string, any> = {};
      for (const [k, data] of Object.entries(variants)) {
        const r = await upsert('appointments', fk, connExt, `F02-${uniq()}`, data);
        out[k] = { status: r.status, reason: r.body.context?.reason, message: r.body.message };
      }
      const after = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'F-02',
        category: 'F',
        title: 'Missing dependencies',
        route: 'POST /integrations/appointments/upsert',
        expected: '422 missing_dependency each',
        actual: out,
      });
      for (const v of Object.values(out)) expect(v.status).toBe(422);
      expect(after[0].n).toBe(before[0].n);
    });

    it('F-03 branchExternalId is not supported: a missing branchId is a clear 422 pointing at /integrations/branches', async () => {
      const s = slot();
      const r = await upsert('appointments', fk, connExt, `F03-${uniq()}`, {
        ...apptData(s),
        branchId: undefined,
        branchExternalId: 'BR-1',
      });
      note({
        id: 'F-03',
        category: 'F',
        title: 'branchExternalId',
        route: 'POST /integrations/appointments/upsert',
        expected: 'branchId is required; 422 missing_dependency whose message points at GET /integrations/branches',
        actual: { status: r.status, reason: r.body.context?.reason, message: r.body.message },
        finding: 'C8',
      });
      expect(r.status).toBe(422);
      expect(r.body.context?.reason).toBe('missing_dependency');
      expect(String(r.body.message)).toContain('/integrations/branches');
    });

    it('F-12 branch discovery: own branches only, minimal projection, any-of scopes, 404 for foreign/unknown ids', async () => {
      const branchesRepo = e2e.dataSource.getRepository(Branch);
      const bBranch = await branchesRepo.save(
        branchesRepo.create({
          tenant: { id: B.tenantId } as Tenant,
          name: `B-only ${uniq()}`,
          timezone: 'Asia/Dubai',
          is_active: true,
        }),
      );
      const list = await call('get', '/integrations/branches', { key: fk });
      const own = (list.body.data ?? []).find((b: any) => b.id === branchId);
      const detail = await call('get', `/integrations/branches/${branchId}`, { key: fk });
      const foreign = await call('get', `/integrations/branches/${bBranch.id}`, { key: fk });
      const unknown = await call('get', `/integrations/branches/${randomUUID()}`, { key: fk });
      const malformed = await call('get', '/integrations/branches/not-a-uuid', { key: fk });
      const paged = await call('get', '/integrations/branches?limit=1&page=1', { key: fk });
      const badLimit = await call('get', '/integrations/branches?limit=101', { key: fk });
      const availOnly = await newKey(A.token, ['integration.availability.read']);
      const noScope = await newKey(A.token, ['integration.services.read']);
      const apptWriteOnly = await newKey(A.token, ['integration.appointments.write']);
      const okAvail = await call('get', '/integrations/branches', { key: availOnly.key });
      const denied = await call('get', '/integrations/branches', { key: noScope.key });
      const okWrite = await call('get', '/integrations/branches', { key: apptWriteOnly.key });
      const unauth = await call('get', '/integrations/branches');
      // The discovered id is directly usable for an availability query.
      const s = slot();
      const avail = await call(
        'get',
        `/integrations/availability?branchId=${own?.id}&staffId=${staffId}&date=${s.date}`,
        { key: fk },
      );
      note({
        id: 'F-12',
        category: 'F',
        title: 'Branch discovery',
        route: 'GET /integrations/branches[/:id]',
        expected: 'own branches only {id,name,timezone,isActive}; any-of scopes; foreign/unknown 404; malformed 400',
        actual: {
          list: list.status,
          ownKeys: own ? Object.keys(own).sort() : null,
          containsForeign: (list.body.data ?? []).some((b: any) => b.id === bBranch.id),
          detail: detail.status,
          foreign: foreign.status,
          unknown: unknown.status,
          malformed: malformed.status,
          paged: paged.body.data?.length,
          badLimit: badLimit.status,
          availOnly: okAvail.status,
          noScope: denied.status,
          apptWriteOnly: okWrite.status,
          unauth: unauth.status,
          availability: avail.status,
        },
        finding: 'C8',
      });
      expect(list.status).toBe(200);
      expect(Object.keys(own).sort()).toEqual(['id', 'isActive', 'name', 'timezone']);
      expect((list.body.data as any[]).some((b) => b.id === bBranch.id)).toBe(false);
      expect(detail.status).toBe(200);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(malformed.status).toBe(400);
      expect(paged.body.data).toHaveLength(1);
      expect(badLimit.status).toBe(400);
      expect(okAvail.status).toBe(200);
      expect(okWrite.status).toBe(200);
      expect(denied.status).toBe(403);
      expect(unauth.status).toBe(401);
      expect(avail.status).toBe(200);
    });

    it('F-04 an overlapping booking for the same staff member is refused with 409', async () => {
      const s = slot(30);
      const first = await upsert('appointments', fk, connExt, `F04-${uniq()}`, apptData(s));
      const clash = await upsert('appointments', fk, connExt, `F04-${uniq()}`, apptData(s));
      note({
        id: 'F-04',
        category: 'F',
        title: 'Double booking (sequential)',
        route: 'POST /integrations/appointments/upsert',
        expected: 'first 200, second 409',
        actual: { first: first.status, clash: clash.status, code: clash.body.code },
        requestIds: rid(first, clash),
      });
      expect(first.status).toBe(200);
      expect(clash.status).toBe(409);
    });

    it('F-05 10 simultaneous bookings of one slot produce exactly one appointment (DB-verified)', async () => {
      const s = slot(30);
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          upsert('appointments', fk, connExt, `F05-${uniq()}`, apptData(s)),
        ),
      );
      const active = await sql(
        `SELECT count(*)::int n FROM appointments
          WHERE "tenantId" = $1 AND "staffId" = $2 AND start_at = $3
            AND status NOT IN ('CANCELLED','NO_SHOW') AND deleted_at IS NULL`,
        [A.tenantId, staffId, s.startAt],
      );
      const statuses = rs.map((r) => r.status).sort();
      note({
        id: 'F-05',
        category: 'F',
        title: 'Double booking (concurrent)',
        route: 'POST /integrations/appointments/upsert',
        expected: 'exactly one 200; rest 409; one active row; no 5xx',
        actual: { statuses, activeRows: active[0].n },
      });
      expect(statuses.filter((x) => x === 200)).toHaveLength(1);
      expect(statuses.every((x) => x === 200 || x === 409)).toBe(true);
      expect(active[0].n).toBe(1);
    });

    it('F-06 reschedule and cancel work; further changes to a cancelled appointment are refused as a "forbidden lifecycle transition" (409 per the aligned guide)', async () => {
      const s = slot(30);
      const ext = `F06-${uniq()}`;
      const c = await upsert('appointments', fk, connExt, ext, apptData(s));
      const moved = slot(30, 12);
      const rs = await upsert('appointments', fk, connExt, ext, {
        action: 'reschedule',
        startAt: moved.startAt,
        endAt: moved.endAt,
        reason: 'audit',
      });
      const cancel = await upsert('appointments', fk, connExt, ext, { action: 'cancel', reason: 'audit' });
      const again = await upsert('appointments', fk, connExt, ext, { action: 'cancel', reason: 'audit again' });
      const resched = await upsert('appointments', fk, connExt, ext, {
        action: 'reschedule',
        startAt: slot(30, 14).startAt,
        endAt: slot(30, 14).endAt,
      });
      const row = await sql(`SELECT status FROM appointments WHERE id = $1`, [c.body.internalId]);
      note({
        id: 'F-06',
        category: 'F',
        title: 'Lifecycle transitions',
        route: 'POST /integrations/appointments/upsert',
        expected:
          'reschedule 200, cancel 200, repeat cancel / reschedule-after-cancel → 409 (guide table: forbidden lifecycle transition is 409)',
        actual: {
          create: c.status,
          reschedule: rs.status,
          cancel: cancel.status,
          cancelAgain: { status: again.status, code: again.body.code },
          rescheduleCancelled: { status: resched.status, code: resched.body.code },
          dbStatus: row[0]?.status,
        },
        requestIds: rid(rs, cancel, again, resched),
      });
      expect([rs.status, cancel.status]).toEqual([200, 200]);
      expect(String(row[0].status).toLowerCase()).toContain('cancel');
      expect(again.status).toBe(409);
      expect(resched.status).toBe(409);
    });

    it('F-07 start/end values: invalid or inconsistent timestamps are 4xx (never 5xx) and write nothing', async () => {
      const before = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);
      const s = slot(30);
      const variants: Record<string, Record<string, unknown>> = {
        notADate: { ...apptData(s), startAt: 'not-a-date' },
        number: { ...apptData(s), startAt: 1700000000000 },
        endBeforeStart: { ...apptData(s), endAt: new Date(s.ms - 3_600_000).toISOString() },
        zeroLength: { ...apptData(s), endAt: s.startAt },
        // Remediation F10 — the documented contract is "ISO-8601 with an explicit offset".
        noOffset: { ...apptData(s), startAt: s.startAt.replace('Z', ''), endAt: s.endAt.replace('Z', '') },
        dateOnly: { ...apptData(s), startAt: s.date, endAt: undefined },
        impossibleDate: { ...apptData(s), startAt: '2026-02-30T10:00:00+03:00' },
        offsetWithoutColon: { ...apptData(s), startAt: s.startAt.replace('Z', '+0000') },
      };
      const out: Record<string, number> = {};
      for (const [k, d] of Object.entries(variants))
        out[k] = (await upsert('appointments', fk, connExt, `F07-${uniq()}`, d)).status;
      const after = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'F-07',
        category: 'F',
        title: 'Timestamp validation',
        route: 'POST /integrations/appointments/upsert',
        expected: 'all 400 (controlled validation error); none persisted',
        actual: { statuses: out, rowsCreated: after[0].n - before[0].n },
        finding: 'C6',
      });
      for (const [k, v] of Object.entries(out)) expect([k, v]).toEqual([k, 400]);
      expect(after[0].n).toBe(before[0].n);
    });

    it('F-08 an offset-less startAt is refused (400, nothing stored); Z and ±hh:mm forms store the same UTC instant', async () => {
      const d = slot(30);
      const naive = d.startAt.replace('Z', '');
      const naiveEnd = d.endAt.replace('Z', '');
      const before = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);
      const refused = await upsert('appointments', fk, connExt, `F08-${uniq()}`, apptData({ startAt: naive, endAt: naiveEnd }));
      const after = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);

      // The same instant written with a +03:00 offset must be stored as the same UTC time.
      const e = slot(30);
      const plus3 = (ms: number) => {
        const t = new Date(ms + 3 * 3_600_000).toISOString().replace('Z', '+03:00');
        return t;
      };
      const ok = await upsert(
        'appointments', fk, connExt, `F08-${uniq()}`,
        apptData({ startAt: plus3(e.ms), endAt: plus3(e.ms + 30 * 60_000) }),
      );
      const row = ok.body.internalId
        ? await sql(`SELECT start_at FROM appointments WHERE id = $1`, [ok.body.internalId])
        : [];
      note({
        id: 'F-08',
        category: 'F',
        title: 'Offset-less timestamp',
        route: 'POST /integrations/appointments/upsert',
        expected: 'offset-less → 400 and not stored; +03:00 form stored as the identical UTC instant',
        actual: {
          offsetLess: { status: refused.status, sent: naive, rowsCreated: after[0].n - before[0].n },
          plus03: { status: ok.status, sent: plus3(e.ms), storedUtc: row[0] ? new Date(row[0].start_at).toISOString() : null, expectedUtc: e.startAt },
          processTimezoneOffsetMinutes: new Date().getTimezoneOffset(),
        },
        finding: 'C6',
      });
      expect(refused.status).toBe(400);
      expect(after[0].n).toBe(before[0].n);
      expect(ok.status).toBe(200);
      expect(new Date(row[0].start_at).toISOString()).toBe(e.startAt);
    });

    it('F-09 re-sending an unchanged appointment is a no-op (skipped), not a reschedule', async () => {
      const s = slot(30);
      const ext = `F09-${uniq()}`;
      const data = apptData(s);
      const a = await upsert('appointments', fk, connExt, ext, data);
      const b = await upsert('appointments', fk, connExt, ext, data);
      note({
        id: 'F-09',
        category: 'F',
        title: 'Unchanged re-upsert',
        route: 'POST /integrations/appointments/upsert',
        expected: 'second outcome skipped',
        actual: { first: a.body.outcome, second: b.body.outcome, changed: b.body.changedFields },
        requestIds: rid(a, b),
        finding: 'C6',
      });
      expect(b.body.outcome).toBe('skipped');
    });

    it('F-10 financial / lifecycle fields on an appointment are refused (422) and nothing is created', async () => {
      const before = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);
      const out: Record<string, number> = {};
      for (const f of ['status', 'payment_status', 'currency', 'platform_fee', 'total_amount', 'settlement_status', 'source']) {
        const r = await upsert('appointments', fk, connExt, `F10-${uniq()}`, { ...apptData(slot()), [f]: 'x' });
        out[f] = r.status;
      }
      const after = await sql(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'F-10',
        category: 'F',
        title: 'Protected appointment fields',
        route: 'POST /integrations/appointments/upsert',
        expected: '422 each; DB unchanged',
        actual: out,
      });
      for (const v of Object.values(out)) expect(v).toBe(422);
      expect(after[0].n).toBe(before[0].n);
    });

    it('F-11 integration bookings send no patient notifications in the isolated stack (no rules / WhatsApp account / provider noop)', async () => {
      await new Promise((r) => setTimeout(r, 500));
      const logs = await sql(`SELECT count(*)::int n FROM notification_logs WHERE "tenantId" = $1`, [A.tenantId]);
      const sched = await sql(`SELECT count(*)::int n FROM scheduled_notifications WHERE "tenantId" = $1`, [A.tenantId]);
      note({
        id: 'F-11',
        category: 'F',
        title: 'Side effects',
        route: 'notification_logs / scheduled_notifications',
        expected: '0 rows for the test tenant',
        actual: { notificationLogs: logs[0].n, scheduledNotifications: sched[0].n, emailEnabled: process.env.EMAIL_ENABLED },
      });
      expect(logs[0].n).toBe(0);
      expect(sched[0].n).toBe(0);
    });
  });

  // ══ G. inbound webhooks ══════════════════════════════════════════════════

  describe('G — inbound webhooks', () => {
    interface Ep { connectionId: string; endpointId: string; secret: string; scheme: string }
    async function mkInbound(events: string[], scheme?: string): Promise<Ep> {
      const connectionId = await newConnection(A.token, 'external_wins');
      const ep = await call('post', '/platform/integrations/webhooks/endpoints', {
        jwt: A.token,
        body: { connectionId, allowedEvents: events, ...(scheme ? { signatureScheme: scheme } : {}) },
      });
      expect(ep.status).toBe(201);
      secrets.push(ep.body.secret);
      return { connectionId, endpointId: ep.body.id, secret: ep.body.secret, scheme: ep.body.signatureScheme };
    }
    const send = (ep: Ep, raw: string, headers: Record<string, string>) =>
      call('post', `/integrations/inbound/${ep.connectionId}`, { raw, headers });
    const events = (tenantId: string, eventId: string) =>
      e2e.dataSource.getRepository(IntegrationInboundEvent).find({
        where: { tenant: { id: tenantId }, provider_event_id: eventId },
      });
    const custEvent = (ext = `G-${uniq()}`) => JSON.stringify({ externalId: ext, data: goodCustomer() });

    let v2: Ep;
    beforeAll(async () => {
      v2 = await mkInbound(['customer.upserted', 'appointment.created']);
    }, 60_000);

    it('G-01 a correctly signed v2 event is accepted (202), queued with an outbox job, and applied asynchronously', async () => {
      const ext = `G01-${uniq()}`;
      const body = custEvent(ext);
      const evt = `evt-${randomUUID()}`;
      const r = await send(v2, body, v2Headers(v2.secret, evt, body));
      const [row] = await events(A.tenantId, evt);
      const outbox = await sql(`SELECT count(*)::int n FROM outbox_jobs WHERE dedupe_key = $1`, [`integration-inbound-${row?.id}`]);
      const mapBefore = await sql(`SELECT count(*)::int n FROM integration_id_map WHERE "tenantId" = $1 AND external_id = $2`, [A.tenantId, ext]);
      await drain(A.tenantId, () => inbound.process(row.id));
      const after = (await events(A.tenantId, evt))[0];
      const mapAfter = await sql(`SELECT count(*)::int n FROM integration_id_map WHERE "tenantId" = $1 AND external_id = $2`, [A.tenantId, ext]);
      note({
        id: 'G-01',
        category: 'G',
        title: 'Valid v2 event, async processing',
        route: 'POST /integrations/inbound/:connectionId',
        expected: '202 accepted; row accepted + outbox job; mapping only after processing',
        actual: {
          status: r.status,
          body: r.body,
          rowStatus: row?.status,
          outboxJobs: outbox[0].n,
          mappingBeforeProcess: mapBefore[0].n,
          rowStatusAfter: after?.status,
          mappingAfter: mapAfter[0].n,
        },
        requestIds: rid(r),
      });
      expect(r.status).toBe(202);
      expect(outbox[0].n).toBe(1);
      expect(mapBefore[0].n).toBe(0);
      expect(String(after.status).toLowerCase()).toBe('processed');
      expect(mapAfter[0].n).toBe(1);
    }, 60_000);

    it('G-02 signature covers the exact raw bytes: re-serialised JSON is rejected, identical bytes accepted', async () => {
      const spaced = `{ "externalId": "G02-${uniq()}",   "data": ${JSON.stringify(goodCustomer())} }`;
      const compact = JSON.stringify(JSON.parse(spaced));
      const evt1 = `evt-${randomUUID()}`;
      const evt2 = `evt-${randomUUID()}`;
      const okSpaced = await send(v2, spaced, v2Headers(v2.secret, evt1, spaced));
      const mismatched = await send(v2, spaced, v2Headers(v2.secret, evt2, compact));
      note({
        id: 'G-02',
        category: 'G',
        title: 'Raw-body signature',
        route: 'POST /integrations/inbound/:connectionId',
        expected: 'exact bytes 202; signature over re-serialised body 403 invalid_signature',
        actual: { exact: okSpaced.status, reserialised: mismatched.status, reason: mismatched.body.context?.reason },
        requestIds: rid(okSpaced, mismatched),
      });
      expect(okSpaced.status).toBe(202);
      expect(mismatched.status).toBe(403);
    });

    it('G-03 each missing header is refused with a named reason and leaves no event row', async () => {
      const body = custEvent();
      const evt = `evt-${randomUUID()}`;
      const full = v2Headers(v2.secret, evt, body);
      const out: Record<string, any> = {};
      for (const h of Object.keys(full)) {
        const { [h]: _dropped, ...rest } = full;
        const r = await send(v2, body, rest);
        out[h] = { status: r.status, reason: r.body.context?.reason };
      }
      const rows = await events(A.tenantId, evt);
      note({
        id: 'G-03',
        category: 'G',
        title: 'Missing headers',
        route: 'POST /integrations/inbound/:connectionId',
        expected: '403 each; no event row',
        actual: out,
      });
      for (const v of Object.values(out)) expect(v.status).toBe(403);
      expect(rows).toHaveLength(0);
    });

    it('G-04 stale, future and non-numeric timestamps are refused even when correctly signed', async () => {
      const body = custEvent();
      const now = Math.floor(Date.now() / 1000);
      const out: Record<string, any> = {};
      for (const [k, ts] of [
        ['stale', String(now - 900)],
        ['future', String(now + 900)],
        ['nonNumeric', 'yesterday'],
        ['millis', String(Date.now())],
      ] as const) {
        const r = await send(v2, body, v2Headers(v2.secret, `evt-${randomUUID()}`, body, 'customer.upserted', ts));
        out[k] = { status: r.status, reason: r.body.context?.reason };
      }
      note({
        id: 'G-04',
        category: 'G',
        title: 'Timestamp validation',
        route: 'POST /integrations/inbound/:connectionId',
        expected: '403 each',
        actual: out,
      });
      for (const v of Object.values(out)) expect(v.status).toBe(403);
    });

    it('G-05 a duplicate event id is a 200 duplicate acknowledgement with one stored row', async () => {
      const body = custEvent();
      const evt = `evt-${randomUUID()}`;
      const h = v2Headers(v2.secret, evt, body);
      const a = await send(v2, body, h);
      const b = await send(v2, body, h);
      const rows = await events(A.tenantId, evt);
      note({
        id: 'G-05',
        category: 'G',
        title: 'Replay guard',
        route: 'POST /integrations/inbound/:connectionId',
        expected: '202 then 200 duplicate, one row',
        actual: { first: a.status, second: b.status, body: b.body, rows: rows.length },
        requestIds: rid(a, b),
      });
      expect([a.status, b.status]).toEqual([202, 200]);
      expect(rows).toHaveLength(1);
    });

    it('G-06 unsupported, not-allowed, mismatched, protected and id-less events are 422 with the documented reasons', async () => {
      const mk = (evtType: string, body: string, extra: Record<string, string> = {}) =>
        send(v2, body, { ...v2Headers(v2.secret, `evt-${randomUUID()}`, body, evtType), ...extra });
      const unsupported = await mk('patient.deleted', custEvent());
      const notAllowed = await mk('service.upserted', JSON.stringify({ externalId: 'x', data: { name: 'S', durationMinutes: 30 } }));
      const protectedF = await mk('customer.upserted', JSON.stringify({ externalId: `G06-${uniq()}`, data: { ...goodCustomer(), id: randomUUID() } }));
      const noExt = await mk('customer.upserted', JSON.stringify({ data: goodCustomer() }));
      const mismatchBody = JSON.stringify({ externalId: `G06-${uniq()}`, event: 'appointment.cancelled', data: goodCustomer() });
      const mismatch = await mk('customer.upserted', mismatchBody);
      const out = {
        unsupported: [unsupported.status, unsupported.body.context?.reason],
        notAllowed: [notAllowed.status, notAllowed.body.context?.reason],
        protectedFields: [protectedF.status, protectedF.body.context?.reason],
        missingExternalId: [noExt.status, noExt.body.context?.reason],
        headerBodyMismatch: [mismatch.status, mismatch.body.context?.reason],
      };
      note({
        id: 'G-06',
        category: 'G',
        title: 'Event validation reasons',
        route: 'POST /integrations/inbound/:connectionId',
        expected:
          '422: unsupported_event, event_not_allowed, protected_fields, missing_external_id, header_body_mismatch',
        actual: out,
      });
      expect(out.unsupported).toEqual([422, 'unsupported_event']);
      expect(out.notAllowed).toEqual([422, 'event_not_allowed']);
      expect(out.protectedFields).toEqual([422, 'protected_fields']);
      expect(out.missingExternalId[0]).toBe(422);
      expect(out.headerBodyMismatch).toEqual([422, 'header_body_mismatch']);
    });

    it('G-07 a rejected event keeps its id; re-sending the same id after the fix is a 200 duplicate (documented trap)', async () => {
      const evt = `evt-${randomUUID()}`;
      const bad = custEvent();
      const rejected = await send(v2, bad, v2Headers(v2.secret, evt, bad, 'service.upserted'));
      const rows = await events(A.tenantId, evt);
      const retry = await send(v2, bad, v2Headers(v2.secret, evt, bad, 'customer.upserted'));
      note({
        id: 'G-07',
        category: 'G',
        title: 'Replay after rejection',
        route: 'POST /integrations/inbound/:connectionId',
        expected: 'rejected 422 with recorded reason; same id again → 200 duplicate (guide)',
        actual: { rejected: rejected.status, recordedReason: (rows[0] as any)?.rejection_reason, retry: retry.status, retryBody: retry.body },
        requestIds: rid(rejected, retry),
        needsReview: true,
        remark: 'Documented, but a partner that fixes its event-type header and re-sends the same id is silently dropped.',
      });
      expect(rejected.status).toBe(422);
      expect((rows[0] as any).rejection_reason).toBeTruthy();
      expect(retry.status).toBe(200);
    });

    it('G-08 /ping answers ok for a syntactically valid id without authentication (observation)', async () => {
      const real = await call('post', `/integrations/inbound/${v2.connectionId}/ping`, { body: {} });
      const fake = await call('post', `/integrations/inbound/${randomUUID()}/ping`, { body: {} });
      note({
        id: 'G-08',
        category: 'G',
        title: 'Ping semantics',
        route: 'POST /integrations/inbound/:connectionId/ping',
        expected: 'guide: only checks reachability, not configuration',
        actual: { real: [real.status, real.body], nonexistent: [fake.status, fake.body] },
        needsReview: true,
        remark: 'Ping cannot be used to enumerate connection ids (both answer ok).',
      });
      expect(real.status).toBeLessThan(300);
      expect(fake.status).toBe(real.status);
    });

    it('G-09 legacy schemes stay replayable under a new event id (documented, deprecated); a v2 endpoint can NOT be downgraded, a legacy one can be upgraded', async () => {
      const legacy = await mkInbound(['customer.upserted'], 'hmac_sha256_body');
      const body = custEvent(`G09-${uniq()}`);
      const sig = `sha256=${createHmac('sha256', legacy.secret).update(body).digest('hex')}`;
      const hdr = (id: string) => ({
        'X-Ziyarati-Signature': sig,
        'X-Ziyarati-Event-Id': id,
        'X-Ziyarati-Event': 'customer.upserted',
      });
      const first = await send(legacy, body, hdr(`evt-${randomUUID()}`));
      const replayNewId = await send(legacy, body, hdr(`evt-${randomUUID()}`));
      const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
      const hdrOld = { ...hdr(`evt-${randomUUID()}`), 'X-Ziyarati-Timestamp': oldTs };
      const hourOld = await send(legacy, body, hdrOld);

      const ep = await mkInbound(['customer.upserted']); // v2 default
      const patch = await call('patch', `/platform/integrations/webhooks/endpoints/${ep.endpointId}`, {
        jwt: A.token,
        body: { signatureScheme: 'hmac_sha256_body' },
      });
      const patch2 = await call('patch', `/platform/integrations/webhooks/endpoints/${ep.endpointId}`, {
        jwt: A.token,
        body: { signatureScheme: 'hmac_sha256_timestamped' },
      });
      const stillV2 = await call('get', `/platform/integrations/webhooks/endpoints/${ep.endpointId}`, { jwt: A.token });
      // …and the legacy endpoint can be moved UP to v2, after which a body-only signature no longer verifies.
      const up = await call('patch', `/platform/integrations/webhooks/endpoints/${legacy.endpointId}`, {
        jwt: A.token,
        body: { signatureScheme: 'hmac_sha256_timestamped_v2' },
      });
      const afterUp = await send(legacy, body, hdr(`evt-${randomUUID()}`));
      note({
        id: 'G-09',
        category: 'G',
        title: 'Legacy signature schemes',
        route: 'POST /integrations/inbound/:connectionId',
        expected:
          'guide: legacy schemes "still work but do not sign the event id/type" (replayable). A v2 endpoint downgrade is not mentioned.',
        actual: {
          first: first.status,
          replayUnderNewId: replayNewId.status,
          oneHourOldTimestampBodyOnly: hourOld.status,
          downgradePatch: patch.status,
          downgradeToTimestamped: patch2.status,
          schemeAfterAttempts: stillV2.body.signatureScheme,
          upgradePatch: up.status,
          legacySignatureAfterUpgrade: afterUp.status,
          deprecatedFlag: up.body.signatureSchemeDeprecated,
        },
        finding: 'C4',
      });
      expect(first.status).toBe(202);
      expect(replayNewId.status).toBe(202); // documented legacy weakness, unchanged
      expect(patch.status).toBe(400);
      expect(patch2.status).toBe(400);
      expect(stillV2.body.signatureScheme).toBe('hmac_sha256_timestamped_v2');
      expect(up.status).toBe(200);
      expect(up.body.signatureScheme).toBe('hmac_sha256_timestamped_v2');
      expect(up.body.signatureSchemeDeprecated).toBe(false);
      expect(afterUp.status).toBe(403);
    }, 60_000);

    it('G-10 an inbound appointment.created event cannot cancel an appointment: lifecycle is decided by the event type', async () => {
      const ep = await mkInbound(['customer.upserted', 'appointment.created']);
      const cext = `G10-C-${uniq()}`;
      const sext = `G10-S-${uniq()}`;
      await upsert('customers', fullKey, ep.connectionId, cext, goodCustomer());
      const linked = await upsert('staff', fullKey, ep.connectionId, sext, { title: 'Audit Dentist', matchEmail: staffEmail });
      expect(linked.status).toBe(200);
      const aext = `G10-A-${uniq()}`;
      const s = slot(30);
      const mkBody = (data: object) => JSON.stringify({ externalId: aext, data });
      const createBody = mkBody({
        startAt: s.startAt,
        endAt: s.endAt,
        branchId,
        customerExternalId: cext,
        staffExternalId: sext,
        serviceIds: [serviceId],
      });
      const e1 = `evt-${randomUUID()}`;
      const r1 = await send(ep, createBody, v2Headers(ep.secret, e1, createBody, 'appointment.created'));
      const [row1] = await events(A.tenantId, e1);
      await drain(A.tenantId, () => inbound.process(row1.id));
      const mapped = await sql(
        `SELECT internal_resource_id FROM integration_id_map WHERE "tenantId" = $1 AND external_id = $2 AND unlinked_at IS NULL`,
        [A.tenantId, aext],
      );
      const apptId = mapped[0]?.internal_resource_id;

      const cancelBody = mkBody({ action: 'cancel', reason: 'smuggled through appointment.created' });
      const e2 = `evt-${randomUUID()}`;
      const r2 = await send(ep, cancelBody, v2Headers(ep.secret, e2, cancelBody, 'appointment.created'));
      const [row2] = await events(A.tenantId, e2);
      if (row2) await drain(A.tenantId, () => inbound.process(row2.id)).catch(() => undefined);
      const st = apptId ? await sql(`SELECT status FROM appointments WHERE id = $1`, [apptId]) : [];

      const e3 = `evt-${randomUUID()}`;
      const direct = await send(ep, cancelBody, v2Headers(ep.secret, e3, cancelBody, 'appointment.cancelled'));
      note({
        id: 'G-10',
        category: 'G',
        title: 'Lifecycle smuggling via event type',
        route: 'POST /integrations/inbound/:connectionId',
        expected:
          'appointment.cancelled is not allowed on this endpoint (422); an appointment.created event must not cancel',
        actual: {
          create: r1.status,
          smuggled: r2.status,
          dbStatusAfterSmuggle: st[0]?.status,
          directCancelEvent: [direct.status, direct.body.context?.reason],
        },
        requestIds: rid(r1, r2, direct),
        finding: 'C1',
      });
      expect(direct.status).toBe(422);
      expect(apptId).toBeTruthy();
      expect(String(st[0].status).toLowerCase()).not.toContain('cancel');
    }, 90_000);

    it('G-11 a processing failure is retried a bounded number of times and ends failed with a summary (never silently dropped)', async () => {
      const ep = await mkInbound(['appointment.created']);
      const s = slot(30);
      const body = JSON.stringify({
        externalId: `G11-${uniq()}`,
        data: { startAt: s.startAt, endAt: s.endAt, branchId, customerExternalId: 'NOPE', staffExternalId: 'NOPE', serviceIds: [serviceId] },
      });
      const evt = `evt-${randomUUID()}`;
      const r = await send(ep, body, v2Headers(ep.secret, evt, body, 'appointment.created'));
      const [row] = await events(A.tenantId, evt);
      const thrown: string[] = [];
      for (let i = 0; i < 6; i++) {
        try {
          await drain(A.tenantId, () => inbound.process(row.id));
          break;
        } catch (e: any) {
          thrown.push(String(e?.message ?? e).slice(0, 80));
        }
      }
      const final = (await events(A.tenantId, evt))[0] as any;
      note({
        id: 'G-11',
        category: 'G',
        title: 'Worker failure handling',
        route: 'integration.inbound processor',
        expected: 'bounded retries then status failed with error_summary',
        actual: { accept: r.status, attemptsThrown: thrown.length, finalStatus: final?.status, summary: final?.error_summary },
        remark: 'Permanent errors (missing dependency) are retried like transient ones.',
      });
      expect(r.status).toBe(202);
      expect(thrown.length).toBeLessThanOrEqual(5);
      expect(String(final.status).toLowerCase()).toBe('failed');
    }, 90_000);
  });

  // ══ H. outbound webhooks ═════════════════════════════════════════════════

  describe('H — outbound webhooks', () => {
    const create = async (url: string, events = ['appointment.created']) =>
      call('post', '/platform/webhooks/endpoints', {
        jwt: A.token,
        body: { name: `audit ${uniq()}`, url, events },
      });
    const del = (id: string) => call('delete', `/platform/webhooks/endpoints/${id}`, { jwt: A.token });
    const fire = async () => {
      await e2e.app.get(EventEmitter2).emitAsync(
        APPOINTMENT_EVENT.CREATED,
        new AppointmentCreatedEvent(A.tenantId, `apt-${uniq()}`, 'cust-1', 'staff-1', 'branch-1', new Date()),
      );
      await new Promise((r) => setTimeout(r, 300));
    };
    const deliveries = (endpointId: string) =>
      e2e.dataSource.getRepository(WebhookDelivery).find({
        where: { webhook_endpoint: { id: endpointId } },
        order: { created_at: 'ASC' },
      });
    const attempt = (id: string, attemptsMade = 0) =>
      processor.process({
        name: JOB.WEBHOOKS_DELIVER,
        data: { tenantId: A.tenantId, webhookDeliveryId: id, correlationId: 'audit' },
        attemptsMade,
      } as unknown as Job);

    it('H-01 the signing secret is returned once at creation and never by read endpoints', async () => {
      const c = await create('https://example.com/hooks/h01');
      if (c.status === 201) secrets.push(c.body.secret);
      const get = await call('get', `/platform/webhooks/endpoints/${c.body.id}`, { jwt: A.token });
      const list = await call('get', '/platform/webhooks/endpoints', { jwt: A.token });
      note({
        id: 'H-01',
        category: 'H',
        title: 'Secret handling',
        route: 'POST /platform/webhooks/endpoints',
        expected: 'secret (whsec_…) once; absent from GET/list',
        actual: { create: c.status, hasSecret: !!c.body.secret, prefix: String(c.body.secret ?? '').slice(0, 6), inGet: get.text.includes(c.body.secret), inList: list.text.includes(c.body.secret) },
      });
      expect(c.status).toBe(201);
      expect(String(c.body.secret)).toMatch(/^whsec_/);
      expect(get.text).not.toContain(c.body.secret);
      expect(list.text).not.toContain(c.body.secret);
      await del(c.body.id);
    });

    it('H-02 destination validation refuses loopback, private, link-local/metadata, credentials, dangerous ports and IPv6 translation forms (no connection is attempted)', async () => {
      const urls = [
        'https://127.0.0.1/h',
        'https://localhost/h',
        'https://10.0.0.5/h',
        'https://192.168.1.10/h',
        'https://172.16.0.1/h',
        'https://169.254.169.254/latest/meta-data',
        'https://100.64.0.1/h',
        'https://[::1]/h',
        'https://[::ffff:7f00:1]/h',
        'https://user:pass@example.com/h',
        'https://example.com:22/h',
        'https://metadata.google.internal/h',
        'https://printer.local/h',
        'https://[64:ff9b::7f00:1]/h',
        'https://[64:ff9b::a9fe:a9fe]/h',
        'https://[2002:7f00:1::]/h',
      ];
      const accepted: string[] = [];
      const out: Record<string, number> = {};
      for (const u of urls) {
        const r = await create(u);
        out[u] = r.status;
        if (r.status === 201) {
          accepted.push(u);
          await del(r.body.id);
        }
      }
      note({
        id: 'H-02',
        category: 'H',
        title: 'SSRF destination validation',
        route: 'POST /platform/webhooks/endpoints',
        expected: '400 for every internal / translated address',
        actual: { accepted, statuses: out },
        finding: 'C10',
      });
      expect(accepted).toEqual([]);
    });

    it('H-03 the guide says "HTTPS receiver": a plain http:// destination is refused', async () => {
      const prev = process.env.WEBHOOK_ALLOW_INSECURE_HTTP;
      process.env.WEBHOOK_ALLOW_INSECURE_HTTP = 'false'; // production semantics, without NODE_ENV=production
      let r: Awaited<ReturnType<typeof create>>;
      try {
        r = await create('http://example.com/hooks/h03');
      } finally {
        if (prev === undefined) delete process.env.WEBHOOK_ALLOW_INSECURE_HTTP;
        else process.env.WEBHOOK_ALLOW_INSECURE_HTTP = prev;
      }
      note({
        id: 'H-03',
        category: 'H',
        title: 'HTTPS enforcement',
        route: 'POST /platform/webhooks/endpoints',
        expected: '400 for http://',
        actual: { status: r.status },
        finding: 'C5',
      });
      if (r.status === 201) await del(r.body.id);
      expect(r.status).toBe(400);
    });

    it('H-04 v1 signature is HMAC(secret, "{timestamp}.{rawBody}"); the additive v2 signature also covers X-Webhook-Id and X-Webhook-Event', async () => {
      process.env.E2E_ALLOW_SIM_LOOPBACK = '1';
      const path = `/h04-${uniq()}`;
      const c = await create(`${receiver.baseUrl}${path}`);
      receiver.setSecret(path, c.body.secret);
      await fire();
      const [d] = await deliveries(c.body.id);
      await attempt(d.id);
      const h = receiver.hooksFor(path)[0];
      const recomputed = `sha256=${createHmac('sha256', c.body.secret).update(`${h.timestamp}.${h.rawBody}`).digest('hex')}`;
      process.env.E2E_ALLOW_SIM_LOOPBACK = '0';
      note({
        id: 'H-04',
        category: 'H',
        title: 'Outbound signature scope',
        route: 'webhooks.deliver',
        expected: 'documented signing string verifies; id/event headers outside the MAC',
        actual: { verdict: h.verdict, matchesRecomputed: recomputed === h.signature, signedParts: ['timestamp', 'rawBody'], unsignedHeaders: ['X-Webhook-Id', 'X-Webhook-Event'] },
        finding: 'C10',
        needsReview: true,
      });
      expect(h.verdict).toBe('valid');
      expect(recomputed).toBe(h.signature);
      // Remediation (observation 6): v2 binds timestamp, delivery id, event and body.
      const v2 = `sha256=${createHmac('sha256', c.body.secret).update(`${h.timestamp}\n${h.id}\n${h.event}\n${h.rawBody}`).digest('hex')}`;
      expect(h.signatureV2).toBe(v2);
      // …so tampering with the id or event header breaks it, while v1 is blind to that.
      const tampered = `sha256=${createHmac('sha256', c.body.secret).update(`${h.timestamp}\nOTHER\n${h.event}\n${h.rawBody}`).digest('hex')}`;
      expect(tampered).not.toBe(h.signatureV2);
    }, 60_000);

    it('H-05 a manual replay is a new delivery (new X-Webhook-Id) but carries the SAME X-Webhook-Original-Id, so partners have one stable key per event', async () => {
      process.env.E2E_ALLOW_SIM_LOOPBACK = '1';
      const path = `/h05-${uniq()}`;
      const c = await create(`${receiver.baseUrl}${path}`);
      receiver.setSecret(path, c.body.secret);
      receiver.reply(path, { status: 400 }, { status: 200 });
      await fire();
      const [d] = await deliveries(c.body.id);
      await attempt(d.id);
      const rep = await call('post', `/platform/webhooks/deliveries/${d.id}/replay`, { jwt: A.token, body: {} });
      const all = await deliveries(c.body.id);
      const latest = all[all.length - 1];
      if (latest && latest.id !== d.id) await attempt(latest.id);
      process.env.E2E_ALLOW_SIM_LOOPBACK = '0';
      const hooks = receiver.hooksFor(path);
      note({
        id: 'H-05',
        category: 'H',
        title: 'Replay delivery id',
        route: 'POST /platform/webhooks/deliveries/:id/replay',
        expected: 'guide: X-Webhook-Id stable across retries (replay is not an automatic retry)',
        actual: { replayStatus: rep.status, deliveryRows: all.length, idsSeenByPartner: hooks.map((x) => x.id), sameId: hooks.length > 1 && hooks[0].id === hooks[1]?.id },
        finding: 'C10',
        needsReview: true,
      });
      expect(rep.status).toBeLessThan(300);
      expect(hooks.length).toBe(2);
      expect(hooks[0].id).not.toBe(hooks[1].id);
      expect(hooks[0].originalId).toBe(d.id);
      expect(hooks[1].originalId).toBe(d.id);
    }, 60_000);

    it('H-06 editing an endpoint URL does NOT redirect deliveries that were already queued — they fail permanently and can be replayed deliberately', async () => {
      process.env.E2E_ALLOW_SIM_LOOPBACK = '1';
      const pa = `/h06a-${uniq()}`;
      const pb = `/h06b-${uniq()}`;
      const c = await create(`${receiver.baseUrl}${pa}`);
      receiver.setSecret(pa, c.body.secret);
      receiver.setSecret(pb, c.body.secret);
      await fire();
      const [d] = await deliveries(c.body.id);
      const patch = await call('patch', `/platform/webhooks/endpoints/${c.body.id}`, {
        jwt: A.token,
        body: { url: `${receiver.baseUrl}${pb}` },
      });
      await attempt(d.id);
      process.env.E2E_ALLOW_SIM_LOOPBACK = '0';
      note({
        id: 'H-06',
        category: 'H',
        title: 'Queued delivery vs URL edit',
        route: 'PATCH /platform/webhooks/endpoints/:id',
        expected: 'queued delivery is bound to the URL snapshot: neither receiver is hit; the delivery is FAILED (endpoint_url_changed)',
        actual: { patch: patch.status, hitOriginal: receiver.hooksFor(pa).length, hitEdited: receiver.hooksFor(pb).length },
        finding: 'C10',
      });
      expect(patch.status).toBeLessThan(300);
      expect(receiver.hooksFor(pa).length).toBe(0);
      expect(receiver.hooksFor(pb).length).toBe(0);
      const after = await deliveries(c.body.id);
      expect(after.find((x: any) => x.id === d.id)?.status).toBe('FAILED');
    }, 60_000);

    it('H-07 the test-event endpoint is limited to 5 per minute per endpoint', async () => {
      const c = await create('https://example.com/hooks/h07');
      const rs: number[] = [];
      for (let i = 0; i < 6; i++) {
        rs.push((await call('post', `/platform/webhooks/endpoints/${c.body.id}/test`, { jwt: A.token, body: {} })).status);
      }
      note({
        id: 'H-07',
        category: 'H',
        title: 'Test-event rate limit',
        route: 'POST /platform/webhooks/endpoints/:id/test',
        expected: '202 x5 then 429',
        actual: rs,
      });
      expect(rs.slice(0, 5).every((s) => s === 202)).toBe(true);
      expect(rs[5]).toBe(429);
      await del(c.body.id);
    });
  });

  // ══ I / J. security & reliability extras ═════════════════════════════════

  describe('I/J — security and reliability extras', () => {
    it('I-01 dashboard management routes reject API keys (the key is not a dashboard credential)', async () => {
      const targets: [string, string][] = [
        ['get', '/platform/api-keys'],
        ['get', '/platform/integrations/connections'],
        ['get', '/platform/webhooks/endpoints'],
        ['get', '/platform/integrations/webhooks/endpoints'],
      ];
      const out: Record<string, number> = {};
      for (const [m, u] of targets) out[u] = (await call(m as any, u, { key: fullKey })).status;
      note({
        id: 'I-01',
        category: 'I',
        title: 'API key vs dashboard routes',
        route: '/platform/*',
        expected: '401/403',
        actual: out,
      });
      for (const v of Object.values(out)) expect([401, 403]).toContain(v);
    });

    it('I-02 a dashboard JWT is not accepted on integration routes', async () => {
      const r = await call('get', '/integrations/customers', { jwt: A.token });
      note({
        id: 'I-02',
        category: 'I',
        title: 'JWT vs integration routes',
        route: 'GET /integrations/customers',
        expected: '401',
        actual: { status: r.status },
      });
      expect(r.status).toBe(401);
    });

    it('I-03 body cap: a 150 KB upsert is 413 and writes nothing', async () => {
      const r = await upsert('customers', fullKey, connExt, `I03-${uniq()}`, { ...goodCustomer(), full_name: 'x'.repeat(150_000) });
      note({
        id: 'I-03',
        category: 'I',
        title: 'Request-size limit',
        route: 'POST /integrations/customers/upsert',
        expected: '413 (guide: 100 KB cap)',
        actual: { status: r.status, code: r.body.code },
      });
      expect(r.status).toBe(413);
    });

    it('I-04 the whole run leaked no plaintext key or secret into any response or api_logs row', async () => {
      const blob = responses.join('\n');
      // creation responses legitimately carry the secret ONCE; count responses other than those
      const leaks = secrets.filter((s) => s && blob.split(s).length - 1 > 1);
      note({
        id: 'I-04',
        category: 'I',
        title: 'Secret-leak sweep',
        route: 'all captured responses',
        expected: 'each secret appears at most once (its creation response)',
        actual: { secrets: secrets.length, responses: responses.length, secretsSeenMoreThanOnce: leaks.length },
      });
      expect(leaks).toEqual([]);
    });

    it('J-01 every response, success or error, carries X-Request-Id', async () => {
      const rs = [
        await call('get', '/integrations/me', { key: fullKey }),
        await call('get', '/integrations/customers'),
        await call('get', `/integrations/customers/${randomUUID()}`, { key: fullKey }),
        await call('post', '/integrations/customers/upsert', { key: fullKey, body: {} }),
      ];
      note({
        id: 'J-01',
        category: 'J',
        title: 'Request id on every response',
        route: 'various',
        expected: 'present',
        actual: rs.map((r) => [r.status, !!r.headers['x-request-id']]),
      });
      for (const r of rs) expect(r.headers['x-request-id']).toBeTruthy();
    });
  });

  // keep the unused import referenced for type-checking helper reuse
  void nowSeconds;
  void signInboundV1;
});
