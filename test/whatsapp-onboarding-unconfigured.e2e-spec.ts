/**
 * HTTP e2e — the platform Meta App is NOT configured (every META_* var empty),
 * exactly the real state of this dev environment today. Opposite precondition
 * from whatsapp-tech-provider.e2e-spec.ts, so it gets its own app instance:
 * ConfigService snapshots process.env at compile time, and both suites need a
 * different snapshot.
 *
 * Covers scenario #1 (public config returns configured=false), #2 (never
 * returns secrets even so), and the backend contract #3 depends on (the
 * frontend disables Connect off this same `configured` boolean — that
 * disablement itself is a browser/React assertion, not something an HTTP e2e
 * suite can observe; see the frontend's useEmbeddedSignup.isUnavailable).
 */
// MUST be the first import — see whatsapp-meta-env-configured.setup.ts (and
// whatsapp-tech-provider.e2e-spec.ts) for why ordering matters here.
import './utils/whatsapp-meta-env-unconfigured.setup';

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

describe('WhatsApp Tech Provider (Meta NOT configured) — HTTP e2e', () => {
  let e2e: E2eApp;
  let tenant: OwnerFixture;

  beforeAll(async () => {
    e2e = await createE2eApp();
    tenant = await createOwnerFixture(e2e, 'unconfigured');
  }, 60_000);

  afterAll(async () => {
    await cleanupTenant(e2e, tenant.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ── #1 ────────────────────────────────────────────────────────────────
  it('#1 GET /whatsapp/onboarding/status returns configured=false', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/onboarding/status`)
      .set(...authHeader(tenant.token))
      .expect(200);
    expect(res.body).toEqual({ configured: false });
  });

  it('the onboarding dialog config endpoint fails loudly (422) rather than serving partial values', async () => {
    await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/onboarding/config`)
      .set(...authHeader(tenant.token))
      .expect(422);
  });

  // ── #2 ────────────────────────────────────────────────────────────────
  it('#2 neither endpoint ever leaks a secret value, even when empty strings are technically "configured"', async () => {
    const status = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/onboarding/status`)
      .set(...authHeader(tenant.token))
      .expect(200);
    const body = JSON.stringify(status.body);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/verify.?token/i);
    expect(Object.keys(status.body).sort()).toEqual(['configured']);
  });

  it('the webhook GET handshake fails closed when no verify token is configured', async () => {
    await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/webhooks/verify`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'anything', 'hub.challenge': 'x' })
      .expect(403);
  });

  it('inbound webhook events are rejected (signature cannot be verified without an app secret)', async () => {
    const payload = JSON.stringify({ entry: [] });
    await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/webhooks/events`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=aa')
      .send(payload)
      .expect(401);
  });

  it('the WhatsApp accounts screen stays usable (existing connections are not gated by onboarding config)', async () => {
    await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/accounts`)
      .set(...authHeader(tenant.token))
      .expect(200);
  });
});
