/**
 * A SIMULATED EXTERNAL CLINIC SYSTEM integrating with ZiyaraTech through the
 * documented API only — no database access, no internal knowledge (matrix rows
 * 1–32 and 45–54 of the Developer Portal hardening plan; the outbound half,
 * rows 33–38, is integration-outbound-simulation.e2e-spec.ts).
 *
 * The "partner" is driven strictly over HTTP with what the docs promise: an
 * `X-API-Key`, `/integrations/*` routes, `Idempotency-Key`, and signed inbound
 * deliveries built by test/utils/partner-simulator.ts (which shares no code with
 * the platform's verifier). The clinic OWNER acts through the dashboard API.
 * The DB is read only to ASSERT what the platform did, never to arrange the
 * partner's calls (bulk pagination rows are the one deliberate seed).
 *
 * ATTACK CASES are in-line with the feature they attack: credential misuse,
 * mass assignment, prototype pollution, injection strings, oversized bodies,
 * cross-tenant / IDOR / tenant-header manipulation, forged, tampered, stale and
 * future signatures, a Redis outage (fail-closed), and finally a SECRET-LEAK
 * SWEEP over every response captured and every table the run touched.
 *
 * Requires the isolated migrations-built e2e DB (see test/setup-e2e-db.js) and,
 * for the Redis-outage case, the DISPOSABLE `zt-e2e-redis` container.
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
import { createLimitedActor } from './utils/limited-actor';
import {
  PartnerReceiver,
  nowSeconds,
  signInboundV1,
  v2Headers,
} from './utils/partner-simulator';
import {
  dockerStart,
  dockerStop,
  safely,
  sleep,
  waitForRedisReady,
} from './utils/docker-redis-control';

import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Service } from '../src/entities/Services/Service';
import { Customer } from '../src/entities/CRM/Customer';
import { IntegrationIdMap } from '../src/entities/Integration/IntegrationIdMap';
import { IntegrationInboundEvent } from '../src/entities/Integration/IntegrationInboundEvent';
import { PERMISSION } from '../src/rbac/rbac.constants';
import { IntegrationImportJobService } from '../src/modules/integration-platform/imports/integration-import-job.service';
import { IntegrationInboundService } from '../src/modules/integration-platform/inbound/integration-inbound.service';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../src/queue/worker-authorization.service';
import { runInTenantContext } from '../src/queue/tenant-context.runner';
import { JOB } from '../src/queue/queue.constants';

const API = '/api/v1';
const uniq = () => randomUUID().slice(0, 8);
const phone = (n: number) =>
  `+9665${String((Date.now() + n) % 100000000).padStart(8, '0')}`;
const email = () => `sim-${uniq()}@example.test`;

async function cleanupSimTenant(e2e: E2eApp, tenantId: string): Promise<void> {
  const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
  await q(`DELETE FROM outbox_jobs WHERE dedupe_key IN (
    SELECT 'integration-inbound-' || id FROM integration_inbound_events WHERE "tenantId" = $1
    UNION SELECT 'integration-import-' || id FROM integration_import_jobs WHERE "tenantId" = $1)`);
  await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_inbound_events WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_webhook_endpoints WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_conflicts WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_id_map WHERE "tenantId" = $1`);
  await q(
    `DELETE FROM integration_import_items WHERE "jobId" IN (SELECT id FROM integration_import_jobs WHERE "tenantId" = $1)`,
  );
  await q(`DELETE FROM integration_import_jobs WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_sync_jobs WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_idempotency_keys WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_connections WHERE "tenantId" = $1`);
  await q(`DELETE FROM services WHERE "tenantId" = $1`);
  await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM api_keys WHERE "tenantId" = $1`);
  await q(
    `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
  );
  await q(`DELETE FROM roles WHERE "tenantId" = $1`);
  await cleanupTenant(e2e, tenantId);
}

describe('External clinic system ↔ ZiyaraTech — simulated partner over the documented API', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture; // clinic A
  let other: OwnerFixture; // clinic B — the neighbour
  let writeKey: string;
  let writeKeyId: string;
  let readKey: string;
  let connectionId: string;
  const ownerKeyIds: string[] = [];
  let inboundSecretShared = '';
  let inboundConnShared = '';
  let importJobs: IntegrationImportJobService;
  let inbound: IntegrationInboundService;
  let ctx: TenantContextService;
  let authz: WorkerAuthorizationService;

  const server = () => e2e.app.getHttpServer();
  /** Every response body seen — swept for secrets at the end (row 53). */
  const captured: string[] = [];
  /** Plaintext secrets that must NEVER appear in a log, audit row or later response. */
  const secrets: string[] = [];

  interface Opts {
    jwt?: string;
    key?: string;
    headers?: Record<string, string>;
    body?: unknown;
    raw?: string;
  }
  async function call(
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    o: Opts = {},
  ) {
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
    captured.push(res.text ?? '');
    return res;
  }

  const drain = <T>(
    tenantId: string,
    fn: () => Promise<T>,
    jobName: string = JOB.INTEGRATION_IMPORT,
  ) => runInTenantContext(ctx, authz, jobName, { tenantId } as never, fn);

  const upsertCustomer = (
    key: string,
    externalId: string,
    data: Record<string, unknown>,
    headers?: Record<string, string>,
  ) =>
    call('post', '/integrations/customers/upsert', {
      key,
      headers,
      body: { connectionId, externalId, data },
    });

  const goodCustomer = () => ({
    full_name: `Sim ${uniq()}`,
    phone: phone(Math.floor(Math.random() * 1e6)),
    email: email(),
  });

  beforeAll(async () => {
    await waitForRedisReady();
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'extsim');
    other = await createOwnerFixture(e2e, 'extsim-other');
    importJobs = e2e.app.get(IntegrationImportJobService);
    inbound = e2e.app.get(IntegrationInboundService);
    ctx = e2e.app.get(TenantContextService);
    authz = e2e.app.get(WorkerAuthorizationService);

    const conn = await call('post', '/platform/integrations/connections', {
      jwt: owner.token,
      body: {
        name: 'Sim PMS',
        provider: 'custom',
        authType: 'none',
        defaultConflictPolicy: 'external_wins',
      },
    });
    expect(conn.status).toBe(201);
    connectionId = conn.body.id;
  }, 120_000);

  afterAll(async () => {
    safely(dockerStart);
    await sleep(300);
    await cleanupSimTenant(e2e, owner.tenantId).catch(() => undefined);
    await cleanupSimTenant(e2e, other.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 60_000);

  // ── Credentials (rows 1, 3, 4, 5) ─────────────────────────────────────────

  describe('the partner obtains and uses a credential', () => {
    it('1 — the owner issues a write-capable key: plaintext ONCE, zk_ prefix, hash never exposed', async () => {
      const res = await call('post', '/platform/api-keys', {
        jwt: owner.token,
        body: {
          name: 'Sim PMS write',
          permissions: [
            'integration.customers.write',
            'integration.services.write',
            'integration.customers.read',
            'integration.services.read',
          ],
          expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        },
      });
      expect(res.status).toBe(201);
      writeKey = res.body.apiKey;
      writeKeyId = res.body.id;
      ownerKeyIds.push(writeKeyId);
      secrets.push(writeKey);
      expect(writeKey).toMatch(/^zk_/);
      expect(JSON.stringify(res.body)).not.toMatch(/key_hash|"hash"/i);

      const list = await call('get', '/platform/api-keys', {
        jwt: owner.token,
      });
      expect(list.status).toBe(200);
      expect(list.text).not.toContain(writeKey); // never again
      const row = list.body.data.find(
        (k: { id: string }) => k.id === writeKeyId,
      );
      expect(writeKey.startsWith(row.key_prefix)).toBe(true);

      const ro = await call('post', '/platform/api-keys', {
        jwt: owner.token,
        body: {
          name: 'Sim PMS read-only',
          permissions: [
            'integration.customers.read',
            'integration.services.read',
          ],
        },
      });
      readKey = ro.body.apiKey;
      ownerKeyIds.push(ro.body.id);
      secrets.push(readKey);
    });

    it('3 — GET /integrations/me lets the partner verify the credential without touching data', async () => {
      const me = await call('get', '/integrations/me', { key: readKey });
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        name: 'Sim PMS read-only',
        scopes: expect.arrayContaining(['integration.customers.read']),
      });
      expect(me.body.tenantName).toContain('E2E Clinic');
      expect(me.text).not.toContain(owner.tenantId);
      expect(me.text).not.toContain(readKey);
    });

    it('4 — a missing, garbage, or wrongly-schemed key is a uniform 401, and reveals nothing about the reason', async () => {
      const none = await call('get', '/integrations/customers');
      const junk = await call('get', '/integrations/customers', {
        key: 'zk_' + 'a'.repeat(48),
      });
      const bearer = await call('get', '/integrations/customers', {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      for (const r of [none, junk, bearer]) {
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('UNAUTHORIZED');
      }
      // "Never existed" and "revoked" are indistinguishable to the caller.
      const doomed = await call('post', '/platform/api-keys', {
        jwt: owner.token,
        body: { name: 'to revoke', permissions: ['integration.services.read'] },
      });
      secrets.push(doomed.body.apiKey);
      await call('post', `/platform/api-keys/${doomed.body.id}/revoke`, {
        jwt: owner.token,
        body: {},
      });
      const revoked = await call('get', '/integrations/customers', {
        key: doomed.body.apiKey,
      });
      expect(revoked.status).toBe(401);
      expect(revoked.body.message).toBe(junk.body.message);
    });

    it('5 — a read-only key cannot write (403), and a write key without read scope cannot read', async () => {
      const w = await upsertCustomer(readKey, `RO-${uniq()}`, goodCustomer());
      expect(w.status).toBe(403);
      const wo = await call('post', '/platform/api-keys', {
        jwt: owner.token,
        body: {
          name: 'write only',
          permissions: ['integration.customers.write'],
        },
      });
      secrets.push(wo.body.apiKey);
      const r = await call('get', '/integrations/customers', {
        key: wo.body.apiKey,
      });
      expect(r.status).toBe(403);
    });
  });

  // ── Writes and their attacks (rows 6, 9–13, 17, 18) ───────────────────────

  describe('the partner writes data', () => {
    it('6 — the same external id is created, then updated, then a no-op — one record, one mapping', async () => {
      const externalId = `LC-${uniq()}`;
      const base = goodCustomer();
      const a = await upsertCustomer(writeKey, externalId, base);
      const b = await upsertCustomer(writeKey, externalId, {
        ...base,
        full_name: base.full_name + ' Jr',
      });
      const c = await upsertCustomer(writeKey, externalId, {
        ...base,
        full_name: base.full_name + ' Jr',
      });
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
      expect([a.body.outcome, b.body.outcome, c.body.outcome]).toEqual([
        'created',
        'updated',
        'skipped',
      ]);
      expect(a.body.internalId).toBe(b.body.internalId);
      const maps = await e2e.dataSource.getRepository(IntegrationIdMap).count({
        where: { tenant: { id: owner.tenantId }, external_id: externalId },
      });
      expect(maps).toBe(1);
    });

    it('9 — two concurrent requests with the SAME Idempotency-Key produce one record (one 200, the other replayed or 409)', async () => {
      const externalId = `CC-${uniq()}`;
      const data = goodCustomer();
      const idem = { 'Idempotency-Key': `idem-${randomUUID()}` };
      const [x, y] = await Promise.all([
        upsertCustomer(writeKey, externalId, data, idem),
        upsertCustomer(writeKey, externalId, data, idem),
      ]);
      const statuses = [x.status, y.status].sort();
      expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
      expect(statuses).toContain(200);
      const count = await e2e.dataSource.getRepository(Customer).count({
        where: { tenant: { id: owner.tenantId }, email: data.email },
      });
      expect(count).toBe(1);
    }, 30_000);

    it('11 — prototype-pollution payloads never pollute the process or the record', async () => {
      const externalId = `PP-${uniq()}`;
      const data = goodCustomer();
      const raw1 = `{"connectionId":"${connectionId}","externalId":"${externalId}","data":{"__proto__":{"isAdmin":true,"polluted":"yes"},"full_name":"${data.full_name}","phone":"${data.phone}","email":"${data.email}"}}`;
      const raw2 = `{"connectionId":"${connectionId}","externalId":"${externalId}-2","data":{"constructor":{"prototype":{"isAdmin":true}},"full_name":"${data.full_name}2","phone":"${phone(7)}","email":"${email()}"}}`;
      for (const raw of [raw1, raw2]) {
        const res = await call('post', '/integrations/customers/upsert', {
          key: writeKey,
          raw,
        });
        expect([200, 400, 422]).toContain(res.status);
      }
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(
        Object.prototype.hasOwnProperty.call(Object.prototype, 'isAdmin'),
      ).toBe(false);
    });

    it('12 — SQL-injection and XSS strings are stored as inert text; the schema is intact', async () => {
      const sqli = `Robert'); DROP TABLE customers;--`;
      const xss = `<img src=x onerror=alert(1)>`;
      const a = await upsertCustomer(writeKey, `SQL-${uniq()}`, {
        ...goodCustomer(),
        full_name: sqli,
      });
      const b = await upsertCustomer(writeKey, `XSS-${uniq()}`, {
        ...goodCustomer(),
        full_name: xss,
      });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const stored = await e2e.dataSource
        .getRepository(Customer)
        .find({ where: { tenant: { id: owner.tenantId } } });
      expect(stored.map((c) => c.full_name)).toEqual(
        expect.arrayContaining([sqli, xss]),
      );
      const table = await e2e.dataSource.query(
        `SELECT to_regclass('public.customers') AS t`,
      );
      expect(table[0].t).toBe('customers');
      // Read back over the API as JSON: the string is data, returned verbatim.
      const read = await call(
        'get',
        `/integrations/customers/${b.body.internalId}`,
        { key: readKey },
      );
      expect(read.status).toBe(200);
      expect(read.headers['content-type']).toMatch(/application\/json/);
    });

    it('13 — an oversized upsert body is refused before anything is written', async () => {
      const before = await e2e.dataSource
        .getRepository(Customer)
        .count({ where: { tenant: { id: owner.tenantId } } });
      // The PUBLISHED limit is the HTTP body cap, 100 KB (integration-api-guide.ts) —
      // not the 256 KB constant deeper in the write path, which a JSON body can
      // never reach. 150 KB sits between the two, so it pins the documented number.
      for (const size of [150_000, 400_000]) {
        const res = await call('post', '/integrations/customers/upsert', {
          key: writeKey,
          raw: JSON.stringify({
            connectionId,
            externalId: `BIG-${uniq()}`,
            data: { ...goodCustomer(), notes: 'x'.repeat(size) },
          }),
        });
        expect({ size, status: res.status }).toEqual({ size, status: 413 });
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      const after = await e2e.dataSource
        .getRepository(Customer)
        .count({ where: { tenant: { id: owner.tenantId } } });
      expect(after).toBe(before);
    });

    it('17 — a spoofed tenant (header, query, body) is ignored or refused; the caller only ever sees its own clinic', async () => {
      const services = e2e.dataSource.getRepository(Service);
      await services.save(
        services.create({
          tenant: { id: owner.tenantId } as Tenant,
          name: 'A-only service',
          public_slug: `a-${uniq()}`,
          duration_minutes: 20,
          is_active: true,
        }),
      );
      await services.save(
        services.create({
          tenant: { id: other.tenantId } as Tenant,
          name: 'B-secret service',
          public_slug: `b-${uniq()}`,
          duration_minutes: 20,
          is_active: true,
        }),
      );

      const viaHeader = await call('get', '/integrations/services', {
        key: readKey,
        headers: { 'X-Tenant-Id': other.tenantId, 'X-Tenant': other.tenantId },
      });
      expect(viaHeader.status).toBe(200);
      expect(viaHeader.text).toContain('A-only service');
      expect(viaHeader.text).not.toContain('B-secret service');

      const viaQuery = await call(
        'get',
        `/integrations/services?tenantId=${other.tenantId}`,
        { key: readKey },
      );
      expect(viaQuery.text).not.toContain('B-secret service');

      const viaBody = await call('post', '/integrations/customers/upsert', {
        key: writeKey,
        body: {
          tenantId: other.tenantId,
          connectionId,
          externalId: `TN-${uniq()}`,
          data: goodCustomer(),
        },
      });
      expect([400, 422]).toContain(viaBody.status);
      const leaked = await e2e.dataSource
        .getRepository(Customer)
        .count({ where: { tenant: { id: other.tenantId } } });
      expect(leaked).toBe(0);
    });

    it('18 — pagination is a stable envelope, pages do not overlap, and the size cap is enforced', async () => {
      const customers = e2e.dataSource.getRepository(Customer);
      await customers.save(
        Array.from({ length: 120 }, (_, i) =>
          customers.create({
            tenant: { id: owner.tenantId } as Tenant,
            full_name: `Page ${String(i).padStart(3, '0')}`,
            phone: `05${String(10_000_000 + i)}`,
            email: `page-${uniq()}-${i}@example.test`,
            is_active: true,
          }),
        ),
      );
      // The envelope on the documented page size…
      const first = await call(
        'get',
        '/integrations/customers?page=1&limit=50',
        { key: readKey },
      );
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ page: 1, limit: 50 });
      expect(first.body.data.length).toBeLessThanOrEqual(50);

      // …and a FULL walk in small pages. The 120 seeded rows share one created_at, so
      // without a unique tiebreaker in the ORDER BY, LIMIT/OFFSET repeats some rows and
      // skips others — a partner syncing by paging would silently lose customers.
      const seen = new Set<string>();
      const total: number = first.body.total;
      for (let page = 1; page <= Math.ceil(total / 7) + 1; page += 1) {
        const res = await call(
          'get',
          `/integrations/customers?page=${page}&limit=7`,
          { key: readKey },
        );
        expect(res.status).toBe(200);
        for (const c of res.body.data as { id: string }[]) {
          expect({ page, id: c.id, repeated: seen.has(c.id) }).toEqual({
            page,
            id: c.id,
            repeated: false,
          });
          seen.add(c.id);
        }
      }
      expect(total).toBeGreaterThanOrEqual(120);
      expect(seen.size).toBe(total); // nothing missing, nothing doubled
      const tooBig = await call('get', '/integrations/customers?limit=500', {
        key: readKey,
      });
      expect(tooBig.status).toBe(400);
    }, 60_000);
  });

  // ── Import jobs: a real lifecycle (rows 45–50) ────────────────────────────

  describe('bulk import jobs (dashboard JSON path)', () => {
    let partialJobId: string;

    it('45 — an empty import is refused at the API (the original "records must contain at least 1 elements") and creates nothing', async () => {
      const before = await e2e.dataSource.query(
        `SELECT count(*)::int AS n FROM integration_import_jobs WHERE "tenantId" = $1`,
        [owner.tenantId],
      );
      const res = await call(
        'post',
        '/platform/integrations/import-jobs/customer',
        {
          jwt: owner.token,
          body: { connectionId, records: [] },
        },
      );
      expect(res.status).toBe(400);
      const after = await e2e.dataSource.query(
        `SELECT count(*)::int AS n FROM integration_import_jobs WHERE "tenantId" = $1`,
        [owner.tenantId],
      );
      expect(after[0].n).toBe(before[0].n);
    });

    it('46 — 30 records with 3 invalid finish PARTIALLY_COMPLETED: 27 written, 3 failed, and no payload is ever returned', async () => {
      const records = Array.from({ length: 30 }, (_, i) => ({
        externalId: `JOB-${uniq()}-${i}`,
        data: i < 27 ? goodCustomer() : { email: 'no-name@example.test' }, // missing full_name/phone
      }));
      const created = await call(
        'post',
        '/platform/integrations/import-jobs/customer',
        {
          jwt: owner.token,
          body: { connectionId, records },
        },
      );
      expect(created.status).toBe(201);
      partialJobId = created.body.jobId;

      await drain(owner.tenantId, () => importJobs.process(partialJobId));

      const job = await call(
        'get',
        `/platform/integrations/import-jobs/${partialJobId}`,
        { jwt: owner.token },
      );
      expect(job.status).toBe(200);
      expect(job.body.status).toBe('partially_completed');
      expect(JSON.stringify(job.body)).not.toMatch(/"payload"/);
      expect(job.text).not.toContain('no-name@example.test');

      const items = await call(
        'get',
        `/platform/integrations/import-jobs/${partialJobId}/items?limit=100`,
        { jwt: owner.token },
      );
      const list = items.body.data as { status: string }[];
      expect(list.filter((i) => i.status === 'failed')).toHaveLength(3);
      expect(list.filter((i) => i.status === 'done')).toHaveLength(27);
    }, 90_000);

    it('47 — retry re-processes ONLY the failed items; the 27 written records are not duplicated', async () => {
      const before = await e2e.dataSource
        .getRepository(Customer)
        .count({ where: { tenant: { id: owner.tenantId } } });
      const retried = await call(
        'post',
        `/platform/integrations/import-jobs/${partialJobId}/retry`,
        { jwt: owner.token, body: {} },
      );
      expect([200, 201]).toContain(retried.status);
      await drain(owner.tenantId, () => importJobs.process(partialJobId));
      const after = await e2e.dataSource
        .getRepository(Customer)
        .count({ where: { tenant: { id: owner.tenantId } } });
      expect(after).toBe(before); // idempotent: nothing new, nothing doubled
      const job = await call(
        'get',
        `/platform/integrations/import-jobs/${partialJobId}`,
        { jwt: owner.token },
      );
      expect(job.body.status).toBe('partially_completed'); // the 3 invalid rows are still invalid
    }, 90_000);

    it('48 — cancelling a pending job stops it: it becomes CANCELLED and nothing is imported', async () => {
      const email1 = email();
      const created = await call(
        'post',
        '/platform/integrations/import-jobs/customer',
        {
          jwt: owner.token,
          body: {
            connectionId,
            records: [
              {
                externalId: `CX-${uniq()}`,
                data: {
                  full_name: 'Cancelled',
                  phone: phone(3),
                  email: email1,
                },
              },
            ],
          },
        },
      );
      const id = created.body.jobId;
      const cancelled = await call(
        'post',
        `/platform/integrations/import-jobs/${id}/cancel`,
        { jwt: owner.token, body: {} },
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe('cancelled');
      await drain(owner.tenantId, () => importJobs.process(id));
      const written = await e2e.dataSource
        .getRepository(Customer)
        .count({ where: { tenant: { id: owner.tenantId }, email: email1 } });
      expect(written).toBe(0);
      // A finished job cannot be cancelled again.
      const again = await call(
        'post',
        `/platform/integrations/import-jobs/${id}/cancel`,
        { jwt: owner.token, body: {} },
      );
      expect(again.status).toBe(422);
    }, 60_000);

    it("49 — importing through ANOTHER clinic's connection is refused and writes nothing", async () => {
      const foreign = await call('post', '/platform/integrations/connections', {
        jwt: other.token,
        body: { name: 'B PMS', provider: 'custom', authType: 'none' },
      });
      const email2 = email();
      const res = await call(
        'post',
        '/platform/integrations/import-jobs/customer',
        {
          jwt: owner.token,
          body: {
            connectionId: foreign.body.id,
            records: [
              {
                externalId: 'X',
                data: { full_name: 'Foreign', phone: phone(5), email: email2 },
              },
            ],
          },
        },
      );
      expect([404, 422]).toContain(res.status);
      expect(
        await e2e.dataSource
          .getRepository(Customer)
          .count({ where: { email: email2 } }),
      ).toBe(0);
    });

    it('50 — a job whose worker died mid-run is recovered by the stale sweep and finishes without duplicates', async () => {
      const ext = `REC-${uniq()}`;
      const mail = email();
      const created = await call(
        'post',
        '/platform/integrations/import-jobs/customer',
        {
          jwt: owner.token,
          body: {
            connectionId,
            records: [
              {
                externalId: ext,
                data: { full_name: 'Recovered', phone: phone(9), email: mail },
              },
            ],
          },
        },
      );
      const id = created.body.jobId;
      // The worker "dies after dequeuing": row left RUNNING and untouched for 10 minutes.
      await e2e.dataSource.query(
        `UPDATE integration_import_jobs SET status = 'running', updated_at = now() - interval '10 minutes' WHERE id = $1`,
        [id],
      );
      const requeued = await importJobs.recoverStale(60_000);
      expect(requeued).toBeGreaterThanOrEqual(1);

      await drain(owner.tenantId, () => importJobs.process(id));
      const job = await call(
        'get',
        `/platform/integrations/import-jobs/${id}`,
        { jwt: owner.token },
      );
      expect(job.body.status).toBe('completed');
      expect(
        await e2e.dataSource
          .getRepository(Customer)
          .count({ where: { tenant: { id: owner.tenantId }, email: mail } }),
      ).toBe(1);
      expect(
        await e2e.dataSource.getRepository(IntegrationIdMap).count({
          where: { tenant: { id: owner.tenantId }, external_id: ext },
        }),
      ).toBe(1);
    }, 60_000);
  });

  // ── Inbound webhooks from the partner (rows 13, 25–32) ────────────────────

  describe('the partner pushes signed events', () => {
    let inboundConnId: string;
    let secret: string;
    const send = (body: string, headers: Record<string, string>) =>
      call('post', `/integrations/inbound/${inboundConnId}`, {
        raw: body,
        headers,
      });
    const customerEvent = (externalId = `IN-${uniq()}`) =>
      JSON.stringify({ externalId, data: goodCustomer() });
    const rows = (eventId: string) =>
      e2e.dataSource.getRepository(IntegrationInboundEvent).find({
        where: { tenant: { id: owner.tenantId }, provider_event_id: eventId },
      });

    beforeAll(async () => {
      const conn = await call('post', '/platform/integrations/connections', {
        jwt: owner.token,
        body: { name: 'Sim inbound', provider: 'custom', authType: 'none' },
      });
      inboundConnId = conn.body.id;
      const ep = await call(
        'post',
        '/platform/integrations/webhooks/endpoints',
        {
          jwt: owner.token,
          body: {
            connectionId: inboundConnId,
            allowedEvents: ['customer.upserted'],
          },
        },
      );
      expect(ep.status).toBe(201);
      expect(ep.body.signatureScheme).toBe('hmac_sha256_timestamped_v2');
      secret = ep.body.secret;
      secrets.push(secret);
      inboundSecretShared = secret;
      inboundConnShared = inboundConnId;
    });

    it('25 — a signed event is accepted, applied by the worker, and visible as processed with a mapping', async () => {
      const ext = `IN-${uniq()}`;
      const body = customerEvent(ext);
      const evt = `evt-${randomUUID()}`;
      const res = await send(body, v2Headers(secret, evt, body));
      expect(res.status).toBe(202);
      const [row] = await rows(evt);
      await drain(
        owner.tenantId,
        () => inbound.process(row.id),
        JOB.INTEGRATION_INBOUND,
      );
      const list = await call(
        'get',
        `/platform/integrations/webhooks/events?connectionId=${inboundConnId}&limit=50`,
        { jwt: owner.token },
      );
      const seen = (
        list.body.data as { providerEventId: string; status: string }[]
      ).find((e) => e.providerEventId === evt);
      expect(seen?.status).toBe('processed');
      expect(
        await e2e.dataSource.getRepository(IntegrationIdMap).count({
          where: { tenant: { id: owner.tenantId }, external_id: ext },
        }),
      ).toBe(1);
      // History never carries the payload.
      expect(list.text).not.toContain('full_name');
    }, 60_000);

    it("26 — a wrong signature and a missing signature leave NO trace in the tenant's history", async () => {
      const body = customerEvent();
      const evt = `evt-${randomUUID()}`;
      const good = v2Headers(secret, evt, body);
      const wrong = await send(body, {
        ...good,
        'X-Ziyarati-Signature': 'sha256=' + 'f'.repeat(64),
      });
      const { 'X-Ziyarati-Signature': _s, ...unsigned } = good;
      const none = await send(body, unsigned);
      expect([wrong.status, none.status]).toEqual([403, 403]);
      expect(await rows(evt)).toHaveLength(0);
    });

    it('27 — changing a single byte of the body invalidates the signature', async () => {
      const body = customerEvent();
      const evt = `evt-${randomUUID()}`;
      const headers = v2Headers(secret, evt, body);
      const res = await send(body.replace('Sim', 'Sam'), headers);
      expect(res.status).toBe(403);
      expect(res.body.context?.reason).toBe('invalid_signature');
      expect(await rows(evt)).toHaveLength(0);
    });

    it('28 — a timestamp 10 minutes old, or 10 minutes in the future, is refused even when correctly signed', async () => {
      const body = customerEvent();
      const now = Math.floor(Date.now() / 1000);
      const stale = await send(
        body,
        v2Headers(
          secret,
          `evt-${randomUUID()}`,
          body,
          'customer.upserted',
          String(now - 600),
        ),
      );
      const future = await send(
        body,
        v2Headers(
          secret,
          `evt-${randomUUID()}`,
          body,
          'customer.upserted',
          String(now + 600),
        ),
      );
      expect(stale.status).toBe(403);
      expect(stale.body.context?.reason).toBe('stale_timestamp');
      expect(future.status).toBe(403);
      expect(future.body.context?.reason).toBe('future_timestamp');
    });

    it('13 — an oversized inbound body (600 KB) is refused before anything is persisted', async () => {
      const evt = `evt-${randomUUID()}`;
      const body = JSON.stringify({
        externalId: `BIG-${uniq()}`,
        data: { full_name: 'x'.repeat(600_000) },
      });
      const res = await send(body, v2Headers(secret, evt, body));
      expect(res.status).toBe(413);
      expect(await rows(evt)).toHaveLength(0);
    });

    it('29 — a v1-style (timestamp.body) signature cannot be replayed at the v2 endpoint', async () => {
      const body = customerEvent();
      const ts = nowSeconds();
      const res = await send(body, {
        'X-Ziyarati-Timestamp': ts,
        'X-Ziyarati-Event-Id': `evt-${randomUUID()}`,
        'X-Ziyarati-Event': 'customer.upserted',
        'X-Ziyarati-Signature': signInboundV1(secret, ts, body),
      });
      expect(res.status).toBe(403);
    });

    it('32 — a deactivated connection refuses events (422, recorded for the owner); reactivating resumes acceptance', async () => {
      await call(
        'post',
        `/platform/integrations/connections/${inboundConnId}/deactivate`,
        { jwt: owner.token, body: {} },
      );
      const body = customerEvent();
      const evt = `evt-${randomUUID()}`;
      const res = await send(body, v2Headers(secret, evt, body));
      expect(res.status).toBe(422);
      expect(res.body.context?.reason).toBe('connection_inactive');
      expect((await rows(evt))[0]?.rejection_reason).toBe(
        'connection_inactive',
      );

      await call(
        'post',
        `/platform/integrations/connections/${inboundConnId}/activate`,
        { jwt: owner.token, body: {} },
      );
      const body2 = customerEvent();
      const ok = await send(
        body2,
        v2Headers(secret, `evt-${randomUUID()}`, body2),
      );
      expect(ok.status).toBe(202);
    });
  });

  // ── Isolation: the neighbour clinic attacks (rows 14–17) ──────────────────

  describe("clinic B cannot reach clinic A's integration objects (IDOR)", () => {
    it("16 — every dashboard read/modify of A's key, connection, job, mapping and endpoints returns 404 for B", async () => {
      const mapping = await call(
        'get',
        '/platform/integrations/mappings?limit=1',
        { jwt: owner.token },
      );
      const mapId = mapping.body.data[0].id;
      const jobs = await call(
        'get',
        '/platform/integrations/import-jobs?limit=1',
        { jwt: owner.token },
      );
      const jobId = jobs.body.data[0].id;
      const outbound = await call('post', '/platform/webhooks/endpoints', {
        jwt: owner.token,
        body: {
          name: 'A hook',
          url: 'https://example.com/hooks/a',
          events: ['appointment.created'],
        },
      });
      secrets.push(outbound.body.secret);
      const inboundEps = await call(
        'get',
        '/platform/integrations/webhooks/endpoints',
        { jwt: owner.token },
      );
      const inEp = inboundEps.body.data[0]?.id;

      const attempts: [Parameters<typeof call>[0], string, unknown?][] = [
        ['get', `/platform/api-keys/${writeKeyId}`],
        ['post', `/platform/api-keys/${writeKeyId}/rotate`, {}],
        ['post', `/platform/api-keys/${writeKeyId}/revoke`, {}],
        ['get', `/platform/integrations/connections/${connectionId}`],
        [
          'patch',
          `/platform/integrations/connections/${connectionId}`,
          { name: 'hijacked' },
        ],
        [
          'post',
          `/platform/integrations/connections/${connectionId}/deactivate`,
          {},
        ],
        ['get', `/platform/integrations/import-jobs/${jobId}`],
        ['get', `/platform/integrations/import-jobs/${jobId}/items`],
        ['post', `/platform/integrations/import-jobs/${jobId}/cancel`, {}],
        ['post', `/platform/integrations/import-jobs/${jobId}/retry`, {}],
        ['post', `/platform/integrations/mappings/${mapId}/unlink`, {}],
        ['get', `/platform/webhooks/endpoints/${outbound.body.id}`],
        [
          'post',
          `/platform/webhooks/endpoints/${outbound.body.id}/rotate-secret`,
          {},
        ],
        ['post', `/platform/webhooks/endpoints/${outbound.body.id}/test`, {}],
        [
          'post',
          `/platform/webhooks/endpoints/${outbound.body.id}/deactivate`,
          {},
        ],
      ];
      if (inEp) {
        attempts.push(
          ['get', `/platform/integrations/webhooks/endpoints/${inEp}`],
          [
            'post',
            `/platform/integrations/webhooks/endpoints/${inEp}/rotate-secret`,
            {},
          ],
        );
      }
      for (const [method, url, body] of attempts) {
        const res = await call(method, url, { jwt: other.token, body });
        expect({ url, status: res.status }).toEqual({ url, status: 404 });
      }
      // …and none of it changed A's state.
      const still = await call(
        'get',
        `/platform/integrations/connections/${connectionId}`,
        { jwt: owner.token },
      );
      expect(still.body.name).toBe('Sim PMS');
      expect(
        (await call('get', '/integrations/customers?limit=1', { key: readKey }))
          .status,
      ).toBe(200);
    }, 60_000);

    it("14/15 — B's API key cannot write through, or read from, A's connection and records", async () => {
      const bKey = await call('post', '/platform/api-keys', {
        jwt: other.token,
        body: {
          name: 'B key',
          permissions: [
            'integration.customers.write',
            'integration.customers.read',
          ],
        },
      });
      secrets.push(bKey.body.apiKey);
      const write = await upsertCustomer(
        bKey.body.apiKey,
        `XT-${uniq()}`,
        goodCustomer(),
      );
      expect([404, 403, 422]).toContain(write.status);
      const aCustomer = await e2e.dataSource
        .getRepository(Customer)
        .findOneOrFail({ where: { tenant: { id: owner.tenantId } } });
      const read = await call(
        'get',
        `/integrations/customers/${aCustomer.id}`,
        { key: bKey.body.apiKey },
      );
      expect(read.status).toBe(404);
      const list = await call('get', '/integrations/customers?limit=100', {
        key: bKey.body.apiKey,
      });
      expect(list.body.total).toBe(0);
    });
  });

  // ── Read-only dashboard user (row 52) ─────────────────────────────────────

  describe('52 — a read-only dashboard user: the BACKEND refuses every mutation', () => {
    it('reads succeed; connections, keys, imports, endpoints and test events are all 403 and change nothing', async () => {
      const ro = await createLimitedActor(
        e2e,
        owner.tenantId,
        [
          PERMISSION.PLATFORM_INTEGRATIONS_READ,
          PERMISSION.PLATFORM_API_KEYS_READ,
          PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_READ,
        ],
        'readonly',
      );
      for (const url of [
        '/platform/integrations/connections',
        '/platform/api-keys',
        '/platform/webhooks/endpoints',
        '/platform/integrations/import-jobs',
      ]) {
        expect((await call('get', url, { jwt: ro.token })).status).toBe(200);
      }
      const keysBefore = await e2e.dataSource.query(
        `SELECT count(*)::int AS n FROM api_keys WHERE "tenantId" = $1`,
        [owner.tenantId],
      );
      const conns = await e2e.dataSource.query(
        `SELECT count(*)::int AS n FROM integration_connections WHERE "tenantId" = $1`,
        [owner.tenantId],
      );

      const mutations: [Parameters<typeof call>[0], string, unknown][] = [
        [
          'post',
          '/platform/integrations/connections',
          { name: 'x', provider: 'custom', authType: 'none' },
        ],
        [
          'post',
          '/platform/api-keys',
          { name: 'x', permissions: ['integration.services.read'] },
        ],
        ['post', `/platform/api-keys/${writeKeyId}/rotate`, {}],
        ['post', `/platform/api-keys/${writeKeyId}/revoke`, {}],
        [
          'post',
          '/platform/integrations/import-jobs/customer',
          {
            connectionId,
            records: [{ externalId: 'x', data: goodCustomer() }],
          },
        ],
        [
          'post',
          `/platform/integrations/connections/${connectionId}/deactivate`,
          {},
        ],
        [
          'post',
          '/platform/integrations/webhooks/endpoints',
          { connectionId, allowedEvents: ['customer.upserted'] },
        ],
        [
          'post',
          '/platform/webhooks/endpoints',
          {
            name: 'x',
            url: 'https://example.com/x',
            events: ['appointment.created'],
          },
        ],
      ];
      for (const [method, url, body] of mutations) {
        const res = await call(method, url, { jwt: ro.token, body });
        expect({ url, status: res.status }).toEqual({ url, status: 403 });
      }
      const keysAfter = await e2e.dataSource.query(
        `SELECT count(*)::int AS n FROM api_keys WHERE "tenantId" = $1`,
        [owner.tenantId],
      );
      const connsAfter = await e2e.dataSource.query(
        `SELECT count(*)::int AS n FROM integration_connections WHERE "tenantId" = $1`,
        [owner.tenantId],
      );
      expect(keysAfter[0].n).toBe(keysBefore[0].n);
      expect(connsAfter[0].n).toBe(conns[0].n);
    }, 60_000);
  });

  // ── Connection health against the simulated partner (row 54) ──────────────

  describe("54 — connection health follows the partner's real availability", () => {
    it('healthy while the partner answers; degrades and counts failures once it goes away', async () => {
      const partner = new PartnerReceiver();
      const base = await partner.start();
      const conn = await call('post', '/platform/integrations/connections', {
        jwt: owner.token,
        body: {
          name: 'Health PMS',
          provider: 'generic_rest',
          authType: 'none',
          config: { baseUrl: base },
        },
      });
      expect(conn.status).toBe(201);
      const id = conn.body.id;

      const up = await call(
        'post',
        `/platform/integrations/connections/${id}/health/check`,
        { jwt: owner.token, body: {} },
      );
      expect(up.status).toBe(200);
      expect(up.body).toMatchObject({
        state: 'healthy',
        healthy: true,
        consecutiveFailures: 0,
      });

      await partner.stop();
      const down = await call(
        'post',
        `/platform/integrations/connections/${id}/health/check`,
        { jwt: owner.token, body: {} },
      );
      expect(down.body.healthy).toBe(false);
      expect(['degraded', 'offline']).toContain(down.body.state);
      expect(down.body.consecutiveFailures).toBeGreaterThanOrEqual(1);
      expect(down.body.lastError).toEqual(expect.any(String));
    }, 60_000);
  });

  // ── Redis outage: writes fail CLOSED (row 51) ─────────────────────────────

  describe('51 — with Redis down, the platform refuses new work rather than admitting it unchecked', () => {
    afterAll(async () => {
      safely(dockerStart);
      await waitForRedisReady().catch(() => undefined);
      await sleep(500);
    });

    it('writes, import creation and inbound events are 503 with a Retry-After, persist nothing, and reads still work; recovery is automatic', async () => {
      const mail = email();
      const ext = `RD-${uniq()}`;
      const body = JSON.stringify({
        externalId: `RDI-${uniq()}`,
        data: goodCustomer(),
      });
      const inboundConn = inboundConnShared;
      const inboundSecret = inboundSecretShared;
      const evt = `evt-${randomUUID()}`;

      dockerStop();
      try {
        await sleep(500);
        const write = await upsertCustomer(writeKey, ext, {
          ...goodCustomer(),
          email: mail,
        });
        expect(write.status).toBe(503);
        expect(Number(write.headers['retry-after'])).toBeGreaterThan(0);

        const job = await call(
          'post',
          '/platform/integrations/import-jobs/customer',
          {
            jwt: owner.token,
            body: {
              connectionId,
              records: [{ externalId: ext, data: goodCustomer() }],
            },
          },
        );
        expect(job.status).toBe(503);

        const inb = await call('post', `/integrations/inbound/${inboundConn}`, {
          raw: body,
          headers: v2Headers(inboundSecret, evt, body),
        });
        expect(inb.status).toBe(503); // fail closed

        // Reads are not gated on Redis (the per-key rate limit fails OPEN by design).
        const read = await call('get', '/integrations/customers?limit=1', {
          key: readKey,
        });
        expect(read.status).toBe(200);

        expect(
          await e2e.dataSource
            .getRepository(Customer)
            .count({ where: { tenant: { id: owner.tenantId }, email: mail } }),
        ).toBe(0);
        expect(
          await e2e.dataSource.getRepository(IntegrationIdMap).count({
            where: { tenant: { id: owner.tenantId }, external_id: ext },
          }),
        ).toBe(0);
      } finally {
        safely(dockerStart);
      }

      await waitForRedisReady();
      let recovered = 0;
      for (let i = 0; i < 20 && recovered !== 200; i += 1) {
        await sleep(500);
        recovered = (
          await upsertCustomer(writeKey, `RD2-${uniq()}`, goodCustomer())
        ).status;
      }
      expect(recovered).toBe(200);
    }, 90_000);
  });

  // ── The sweep: no secret anywhere (row 53) ────────────────────────────────

  describe('53 — secret-leak sweep after the whole run', () => {
    it('no plaintext key or webhook secret appears in any response body, API log, audit row or integration table', async () => {
      const unique = [...new Set(secrets.filter((s) => s && s.length >= 16))];
      expect(unique.length).toBeGreaterThanOrEqual(5);

      // 1. Everything the partner and the owner ever received — except the ONE
      //    show-once response that legitimately carries each plaintext.
      const responses = captured.join('\n');
      for (const s of unique) {
        // Show-once: the creating response is the ONLY place a plaintext may appear.
        const occurrences = responses.split(s).length - 1;
        expect({ prefix: s.slice(0, 8), occurrences }).toEqual({
          prefix: s.slice(0, 8),
          occurrences: 1,
        });
      }

      // 2. Every table the run wrote to, for this tenant.
      const dumps: string[] = [];
      const t = owner.tenantId;
      for (const sql of [
        `SELECT row_to_json(x)::text AS j FROM api_logs x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM audit_logs x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM integration_inbound_events x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM integration_import_jobs x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM integration_idempotency_keys x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM integration_conflicts x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM integration_id_map x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM webhook_deliveries x WHERE "tenantId" = $1`,
        `SELECT row_to_json(x)::text AS j FROM integration_connections x WHERE "tenantId" = $1`,
      ]) {
        const rows: { j: string }[] = await e2e.dataSource.query(sql, [t]);
        dumps.push(...rows.map((r) => r.j));
      }
      const all = dumps.join('\n');
      for (const s of unique)
        expect({
          leakedIn: 'db',
          prefix: s.slice(0, 8),
          found: all.includes(s),
        }).toEqual({ leakedIn: 'db', prefix: s.slice(0, 8), found: false });

      // 3. The stored key material is a hash, never the key.
      const keys: { key_hash: string }[] = await e2e.dataSource.query(
        `SELECT key_hash FROM api_keys WHERE "tenantId" = $1`,
        [t],
      );
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(unique).not.toContain(k.key_hash);
    });
  });
});
