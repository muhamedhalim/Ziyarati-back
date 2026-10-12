/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AUDIT G-13 (F03, NR-05 from the original audit) — the GLOBAL per-IP throttle
 * in front of the public inbound route.
 *
 * The global ceiling is 300/min/IP in production. Under NODE_ENV=test it is
 * effectively disabled, and `E2E_THROTTLE_LIMIT` (read ONLY when NODE_ENV=test,
 * see app.module.ts) lowers it for this spec. The inbound unsigned budgets are
 * raised so the GLOBAL limiter is the only thing that can answer 429 here.
 *
 * Deliberately NOT a flood: the loop stops at the first 429 and is capped at 80.
 */
process.env.E2E_THROTTLE_LIMIT = '40';
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_UNSIGNED_IP = '1000';
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_UNSIGNED_CONNECTION = '1000';
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_UNSIGNED_TENANT = '1000';

import { execSync } from 'node:child_process';
import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import { REDIS_CONTAINER, waitForRedisReady } from './utils/docker-redis-control';
import { note, flush } from './utils/audit-evidence';

const API = '/api/v1';

describe('Integration API audit — global per-IP throttle (G-13)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let connectionId = '';

  beforeAll(async () => {
    await waitForRedisReady();
    // Dedicated, disposable test Redis: clear residual throttle counters left by
    // earlier suites (their ceiling was 1,000,000) so this spec starts from zero.
    execSync(`docker exec ${REDIS_CONTAINER} redis-cli FLUSHALL`, { stdio: 'ignore' });
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'audit-thr');
    const conn = await request(e2e.app.getHttpServer())
      .post(`${API}/platform/integrations/connections`)
      .set(...authHeader(owner.token))
      .send({ name: 'thr', provider: 'custom', authType: 'none' })
      .expect(201);
    connectionId = conn.body.id;
    await request(e2e.app.getHttpServer())
      .post(`${API}/platform/integrations/webhooks/endpoints`)
      .set(...authHeader(owner.token))
      .send({ connectionId, allowedEvents: ['customer.upserted'] })
      .expect(201);
  }, 180_000);

  afterAll(async () => {
    try {
      flush(undefined, '-throttle');
    } catch {
      /* ignore */
    }
    const q = async (s: string) => e2e.dataSource.query(s, [owner.tenantId]).catch(() => undefined);
    await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
    await q(`DELETE FROM integration_inbound_events WHERE "tenantId" = $1`);
    await q(`DELETE FROM integration_webhook_endpoints WHERE "tenantId" = $1`);
    await q(`DELETE FROM integration_connections WHERE "tenantId" = $1`);
    await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
    await cleanupTenant(e2e, owner.tenantId).catch(() => undefined);
    await e2e.app.close();
    // This spec deliberately trips the per-IP limiter, which leaves a BLOCK record
    // (~60 s) in Redis that would 429 whichever suite runs next from this address.
    // The e2e Redis is a dedicated, disposable container — clear it.
    try {
      execSync(`docker exec ${REDIS_CONTAINER} redis-cli FLUSHALL`, { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
  }, 60_000);

  it('G-13 the global per-IP limit answers 429 + Retry-After at the configured ceiling, and not before', async () => {
    let first429 = 0;
    let retryAfter: string | undefined;
    const statuses: number[] = [];
    for (let i = 1; i <= 80; i++) {
      const r = await request(e2e.app.getHttpServer())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Signature', 'sha256=' + '0'.repeat(64))
        .send(JSON.stringify({ externalId: 'x', data: {} }));
      statuses.push(r.status);
      if (r.status === 429) {
        first429 = i;
        retryAfter = r.headers['retry-after'] as string;
        break;
      }
    }
    note({
      id: 'G-13',
      category: 'G',
      title: 'Global per-IP throttle on the public inbound route',
      route: 'POST /integrations/inbound/:connectionId',
      expected: 'unsigned requests answered 403 until the global ceiling (40/min incl. fixture traffic), then 429 + Retry-After',
      actual: { configuredGlobalLimit: 40, first429AtRequest: first429, retryAfter, sample: statuses.slice(0, 5) },
      finding: 'C9',
    });
    expect(statuses[0]).toBe(403); // not throttled before the ceiling
    expect(first429).toBeGreaterThan(1);
    expect(first429).toBeLessThanOrEqual(41); // never above the configured ceiling
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // everything before the first 429 was an authentication refusal, not a 5xx
    expect(statuses.slice(0, -1).every((s) => s === 403)).toBe(true);
  }, 120_000);
});
