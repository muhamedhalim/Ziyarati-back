/**
 * ZT-H02 — webhook replay-freshness e2e coverage (T055/T056).
 *
 * Boots the REAL AppModule (createE2eApp) against real Postgres + Redis, so
 * signature verification, the freshness check, dedup and the financial
 * idempotency controls all run exactly as in production. Covers the Meta /
 * WhatsApp ingestion path (the Tap path is covered by tap-webhook.e2e-spec.ts) —
 * NotificationWebhookController stays unmounted and out of scope (O1).
 */
// MUST be the first import — sets Meta env vars before AppModule (imported
// transitively by whatsapp-e2e-app.ts below) triggers ConfigModule.forRoot(),
// which reads process.env synchronously and caches the result.
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  signWebhookBody,
  type E2eApp,
} from './utils/whatsapp-e2e-app';

const API = '/api/v1';

// Mirrors the production constants (whatsapp-webhook.service.ts,
// payment-webhook.service.ts) as literal seconds, for constructing
// boundary-adjacent timestamps only — never re-implements the check itself.
const META_TOLERANCE_SECONDS = 7 * 24 * 60 * 60; // 604800 — evidence/webhook-paths.md

/**
 * `payment-webhook.service.ts` emits domain events via `emitter.emit(...)`
 * (fire-and-forget, not `emitAsync`) on a successful state transition —
 * production behaviour, unrelated to and unmodified by ZT-H02. Downstream
 * `@OnEvent` listeners therefore run detached from the request's own promise
 * chain; without a short settle window here, `afterAll`'s `e2e.app.close()`
 * can tear down the DB connection while a listener's transaction is still
 * in flight, which Jest reports as "cannot log after tests are done" even
 * though every assertion in this file passes. Same pattern
 * `webhooks.e2e-spec.ts` uses after each of its own `emitAsync` calls.
 */
const settle = () => new Promise((r) => setTimeout(r, 500));

function metaPayload(wamid: string, unixSeconds: string | undefined): string {
  const message: Record<string, unknown> = {
    id: wamid,
    from: '15550009999',
    type: 'text',
    text: { body: 'hello' },
  };
  if (unixSeconds !== undefined) message.timestamp = unixSeconds;
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: { metadata: { phone_number_id: 'zt-h02-unresolved-phone' }, messages: [message] },
          },
        ],
      },
    ],
  });
}

describe('Webhook replay protection (ZT-H02) — HTTP e2e', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 60_000);

  afterAll(async () => {
    // Belt-and-braces on top of the per-test `settle()` calls: a fire-and-
    // forget `emitter.emit(...)` listener chain (production code, not
    // awaited by the HTTP response) can still be mid-flight when the last
    // test resolves. Closing the DB connection while a listener's
    // transaction is committing surfaces as "cannot log after tests are
    // done" even though every assertion already passed.
    await settle();
    await e2e.app.close();
  }, 30_000);

  describe('Meta / WhatsApp — POST /whatsapp/webhooks/events (mounted)', () => {
    it('T055-1 a fresh, validly-signed event is accepted', async () => {
      const wamid = `wamid.${randomUUID()}`;
      const payload = metaPayload(wamid, String(Math.floor(Date.now() / 1000)));
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
        .send(payload)
        .expect(200);
      expect(res.body.accepted).toBe(true);
    });

    it('T055-2 a duplicate delivery of the same event is deduplicated, not reprocessed', async () => {
      const wamid = `wamid.${randomUUID()}`;
      const payload = metaPayload(wamid, String(Math.floor(Date.now() / 1000)));
      const signature = signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET);

      const first = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(payload)
        .expect(200);
      expect(first.body.deduplicated).toBeFalsy();

      const second = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(payload)
        .expect(200);
      expect(second.body).toMatchObject({ accepted: true, id: first.body.id, deduplicated: true });
    });

    it('T055-3 a stale replay (older than the 7-day tolerance) is refused', async () => {
      const wamid = `wamid.${randomUUID()}`;
      const staleSeconds = String(Math.floor(Date.now() / 1000) - META_TOLERANCE_SECONDS - 10);
      const payload = metaPayload(wamid, staleSeconds);
      await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
        .send(payload)
        .expect(401);
    });

    it('T055-4 a future timestamp (beyond the tolerance) is refused', async () => {
      const wamid = `wamid.${randomUUID()}`;
      const futureSeconds = String(Math.floor(Date.now() / 1000) + META_TOLERANCE_SECONDS + 10);
      const payload = metaPayload(wamid, futureSeconds);
      await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
        .send(payload)
        .expect(401);
    });

    it('T055-5 a timestamp just inside the tolerance boundary is still accepted (inclusive boundary)', async () => {
      const wamid = `wamid.${randomUUID()}`;
      // 5s margin inside the 7-day boundary — proves the boundary is
      // inclusive (verifyTimestamp's `> toleranceSeconds` check) without
      // being sensitive to HTTP round-trip timing; an exact-edge value could
      // flip verdicts under load (this session has observed Docker-container
      // timing flakiness elsewhere for exactly this reason).
      const boundarySeconds = String(Math.floor(Date.now() / 1000) - META_TOLERANCE_SECONDS + 5);
      const payload = metaPayload(wamid, boundarySeconds);
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
        .send(payload)
        .expect(200);
      expect(res.body.accepted).toBe(true);
    });

    it('T055-6 a malformed timestamp is refused', async () => {
      const wamid = `wamid.${randomUUID()}`;
      const payload = metaPayload(wamid, 'not-a-timestamp');
      await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
        .send(payload)
        .expect(401);
    });

    it('T055-7 an invalid signature is refused BEFORE the freshness check runs (signature is the outer gate)', async () => {
      const wamid = `wamid.${randomUUID()}`;
      // Also stale, so this proves signature is checked FIRST — if freshness
      // ran first it would also 401, but for the wrong reason.
      const staleSeconds = String(Math.floor(Date.now() / 1000) - META_TOLERANCE_SECONDS - 10);
      const payload = metaPayload(wamid, staleSeconds);
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
        .send(payload)
        .expect(401);
      expect(res.body.message).toMatch(/signature/i);
    });
  });
});
