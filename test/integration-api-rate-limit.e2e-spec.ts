/**
 * Per-key rate limiting for the external integration API — isolated into its
 * own file because it needs a LOW limit (INTEGRATION_API_RATE_LIMIT_PER_MINUTE)
 * baked in before AppModule's ConfigModule.forRoot() ever evaluates it.
 *
 * MUST be the first import: ConfigModule.forRoot() runs synchronously inside
 * AppModule's `@Module({...})` decorator the first time AppModule is
 * `require()`'d in this file's module registry — not per
 * `Test.createTestingModule().compile()` call. If the env var were set inside
 * a `beforeAll` (after `createE2eApp` — and therefore AppModule — was already
 * imported), it would be too late: the validated config snapshot is already
 * frozen. See integration-rate-limit-env.setup.ts.
 */
import './utils/integration-rate-limit-env.setup';

import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

const API = '/api/v1';

async function cleanupIntegrationTenant(e2e: E2eApp, tenantId: string): Promise<void> {
  const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
  await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM api_keys WHERE "tenantId" = $1`);
  await cleanupTenant(e2e, tenantId);
}

describe('External integration API — per-key rate limiting — HTTP e2e', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let key: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'rate-limit');
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/platform/api-keys`)
      .set(...authHeader(owner.token))
      .send({ permissions: ['integration.services.read'] })
      .expect(201);
    key = res.body.apiKey;
  }, 60_000);

  afterAll(async () => {
    await cleanupIntegrationTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 30_000);

  it('rejects with 429 once the per-key per-minute bucket is exhausted', async () => {
    const server = e2e.app.getHttpServer();
    // Limit is 2/min (see integration-rate-limit-env.setup.ts).
    await request(server).get(`${API}/integrations/services`).set('X-API-Key', key).expect(200);
    await request(server).get(`${API}/integrations/services`).set('X-API-Key', key).expect(200);
    const denied = await request(server).get(`${API}/integrations/services`).set('X-API-Key', key).expect(429);
    expect(denied.body.code).toBe('RATE_LIMITED');
    expect(denied.body.message).toEqual(expect.any(String));
  });
});
