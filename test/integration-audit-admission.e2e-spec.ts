/* eslint-disable @typescript-eslint/no-explicit-any */
import './utils/audit-admission-env.setup';

/**
 * AUDIT G-12 (remediated F03) — unauthenticated traffic must not consume the
 * budget reserved for a partner's signed events, and the signed budget itself
 * must still be a hard, observable limit.
 *
 * Limits are lowered through env (see utils/audit-admission-env.setup.ts):
 *   signed 5/min/connection · unsigned 4/min/IP.
 * The "attacker" knows only the (non-secret) connection UUID. Every scenario is
 * bounded (≤ 12 requests).
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
import { v2Headers } from './utils/partner-simulator';
import { waitForRedisReady } from './utils/docker-redis-control';
import { note, flush } from './utils/audit-evidence';

const API = '/api/v1';

describe('Integration API audit — inbound admission budgets (G-12, remediated F03)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  const conns: Record<string, { id: string; secret: string }> = {};

  const server = () => e2e.app.getHttpServer();

  async function makeConn(name: string) {
    const conn = await request(server())
      .post(`${API}/platform/integrations/connections`)
      .set(...authHeader(owner.token))
      .send({ name, provider: 'custom', authType: 'none' })
      .expect(201);
    const ep = await request(server())
      .post(`${API}/platform/integrations/webhooks/endpoints`)
      .set(...authHeader(owner.token))
      .send({ connectionId: conn.body.id, allowedEvents: ['customer.upserted'] })
      .expect(201);
    conns[name] = { id: conn.body.id, secret: ep.body.secret };
  }

  const junk = (connectionId: string) =>
    request(server())
      .post(`${API}/integrations/inbound/${connectionId}`)
      .set('Content-Type', 'application/json')
      .set('X-Ziyarati-Signature', 'sha256=' + '0'.repeat(64))
      .send(JSON.stringify({ externalId: 'x', data: { full_name: 'x' } }));

  const signedEvent = (name: string) => {
    const body = JSON.stringify({
      externalId: `G12-${randomUUID().slice(0, 8)}`,
      data: { full_name: 'Adm', phone: `+9665${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}` },
    });
    return request(server())
      .post(`${API}/integrations/inbound/${conns[name].id}`)
      .set('Content-Type', 'application/json')
      .set(v2Headers(conns[name].secret, `evt-${randomUUID()}`, body))
      .send(body);
  };

  beforeAll(async () => {
    await waitForRedisReady();
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'audit-adm');
    for (const n of ['isolation', 'boundary', 'burst']) await makeConn(n);
  }, 180_000);

  afterAll(async () => {
    try {
      flush(undefined, '-admission');
    } catch {
      /* ignore */
    }
    const q = async (s: string) =>
      e2e.dataSource.query(s, [owner.tenantId]).catch(() => undefined);
    await q(`DELETE FROM outbox_jobs WHERE dedupe_key IN (SELECT 'integration-inbound-' || id FROM integration_inbound_events WHERE "tenantId" = $1)`);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM integration_inbound_events WHERE "tenantId" = $1`);
    await q(`DELETE FROM integration_webhook_endpoints WHERE "tenantId" = $1`);
    await q(`DELETE FROM integration_connections WHERE "tenantId" = $1`);
    await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
    await cleanupTenant(e2e, owner.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 60_000);

  it('G-12 a burst of unsigned requests is throttled on its OWN budget and the real partner is still accepted', async () => {
    const id = conns.isolation.id;
    const unsigned: number[] = [];
    let lastRetryAfter: string | undefined;
    for (let i = 0; i < 6; i++) {
      const r = await junk(id);
      unsigned.push(r.status);
      if (r.status === 429) lastRetryAfter = r.headers['retry-after'] as string;
    }
    const real = await signedEvent('isolation');
    note({
      id: 'G-12',
      category: 'G',
      title: 'Unauthenticated budget isolation',
      route: 'POST /integrations/inbound/:connectionId',
      expected:
        'unsigned junk is limited per source IP (403 until the IP budget, then 429 + Retry-After) and never consumes the signed budget',
      actual: {
        unsignedPerIpLimit: 4,
        signedPerConnectionLimit: 5,
        unsignedStatuses: unsigned,
        unsignedRetryAfter: lastRetryAfter,
        thenValidSignedEvent: real.status,
      },
      requestIds: [real.headers['x-request-id'] as string],
      finding: 'C9',
    });
    // 4 within the unsigned IP budget → 403, then 429.
    expect(unsigned.slice(0, 4)).toEqual([403, 403, 403, 403]);
    expect(unsigned.slice(4)).toEqual([429, 429]);
    expect(Number(lastRetryAfter)).toBeGreaterThan(0);
    expect(real.status).toBe(202);
  }, 60_000);

  it('G-12b the SIGNED budget is still a hard limit: exactly N accepted, then 429 with Retry-After', async () => {
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 6; i++) {
      const r = await signedEvent('boundary');
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers['retry-after'] as string;
    }
    note({
      id: 'G-12b',
      category: 'G',
      title: 'Signed budget boundary',
      route: 'POST /integrations/inbound/:connectionId',
      expected: '5 accepted (202) then 429 with Retry-After',
      actual: { statuses, retryAfter },
    });
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  }, 60_000);

  it('G-12c concurrent signed deliveries at the boundary: the budget is not exceeded (no over-admission under a race)', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => signedEvent('burst')));
    const accepted = results.filter((r) => r.status === 202).length;
    const limited = results.filter((r) => r.status === 429);
    note({
      id: 'G-12c',
      category: 'G',
      title: 'Concurrent admission at the limit',
      route: 'POST /integrations/inbound/:connectionId',
      expected: 'limit 5 → 5 accepted (≤ 6 allowing one token refill), the rest 429',
      actual: { accepted, limited: limited.length, other: 10 - accepted - limited.length },
    });
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(accepted).toBeLessThanOrEqual(6);
    expect(accepted + limited.length).toBe(10);
    for (const r of limited) expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  }, 60_000);

  it('G-12d with the signed budget exhausted, an unsigned request is still answered by authentication (403) or the unsigned budget (429)', async () => {
    // Same connection, but the signed budget of `boundary` is exhausted by now;
    // an unsigned request must still be answered by the AUTH check (403) or the
    // unsigned budget (429) — never by the signed budget being "used up".
    const r = await junk(conns.boundary.id);
    expect([403, 429]).toContain(r.status);
    if (r.status === 429) {
      // It is the unsigned IP bucket (4/min) from earlier tests talking, not the signed one.
      expect(r.body?.context?.retryAfterMs ?? 1).toBeGreaterThan(0);
    }
  }, 30_000);
});
