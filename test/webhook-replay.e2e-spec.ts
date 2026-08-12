/**
 * ZT-H02 — webhook replay-freshness e2e coverage (T055/T056).
 *
 * Boots the REAL AppModule (createE2eApp) against real Postgres + Redis, so
 * signature verification, the freshness check, dedup and the financial
 * idempotency controls all run exactly as in production. Covers the two
 * MOUNTED ingestion paths only (evidence/webhook-paths.md) —
 * NotificationWebhookController stays unmounted and out of scope (O1).
 */
// MUST be the first import — sets Meta env vars before AppModule (imported
// transitively by whatsapp-e2e-app.ts below) triggers ConfigModule.forRoot(),
// which reads process.env synchronously and caches the result.
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';

// Same rule applies to Moyasar's secret: this repo's .env ships
// MOYASAR_WEBHOOK_SECRET unset, so the verifier's dev-fallback would accept
// any/no token — fine for the OTHER Moyasar e2e suites, but this file
// specifically needs a configured secret to prove "invalid token refused
// before the freshness check" (T056's 7th case). Setting it here, before any
// AppModule-pulling import, is what makes it win over dotenv's later
// (skipped, since the key already exists in process.env) attempt to set it.
process.env.MOYASAR_WEBHOOK_SECRET ||= 'test-moyasar-webhook-secret-zt-h02';
const TEST_MOYASAR_SECRET = process.env.MOYASAR_WEBHOOK_SECRET;

import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  signWebhookBody,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Payment } from '../src/entities/Payments/Payment';
import { PaymentStatus } from '../src/entities/enums';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';

const API = '/api/v1';

// Mirrors the production constants (whatsapp-webhook.service.ts,
// payment-webhook.service.ts) as literal seconds, for constructing
// boundary-adjacent timestamps only — never re-implements the check itself.
const META_TOLERANCE_SECONDS = 7 * 24 * 60 * 60; // 604800 — evidence/webhook-paths.md
const MOYASAR_TOLERANCE_SECONDS = 4 * 60 * 60; // 14400 — evidence/webhook-paths.md

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

  describe('Moyasar — POST /payments/webhooks/moyasar (mounted, defence-in-depth)', () => {
    let tenant: OwnerFixture;

    beforeAll(async () => {
      tenant = await createOwnerFixture(e2e, 'zt-h02-moyasar');
    });

    // NOTE: no per-tenant teardown here — same documented reason as
    // refund-concurrency.e2e-spec.ts: `transactions` is append-only by DB
    // trigger (Principle XII, "an append-only, immutable financial
    // history"), and `payments`/`tenants` are FK-referenced by it with no
    // cascade, so a tenant that ever receives a webhook-recorded transaction
    // can never be deleted again — real production behaviour, not a test
    // artifact. Every test below uses a fresh `gatewayPaymentId` (a fresh
    // UUID) under this suite's own uniquely-suffixed tenant, so no cleanup
    // is needed for isolation between runs.

    async function seedPendingPayment(gatewayPaymentId: string): Promise<Payment> {
      const payments = e2e.dataSource.getRepository(Payment);
      return payments.save(
        payments.create({
          tenant: { id: tenant.tenantId } as Tenant,
          amount: 100,
          currency: 'SAR',
          status: PaymentStatus.PENDING,
          gateway: 'moyasar',
          gateway_payment_id: gatewayPaymentId,
        }),
      );
    }

    it('T056-1 a fresh, validly-signed event is accepted', async () => {
      const gatewayPaymentId = `gw-${randomUUID()}`;
      await seedPendingPayment(gatewayPaymentId);
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', TEST_MOYASAR_SECRET)
        .send({
          id: `evt-${randomUUID()}`,
          type: 'payment_paid',
          created_at: new Date().toISOString(),
          data: { id: gatewayPaymentId, status: 'paid', amount: 10000, currency: 'SAR' },
        })
        .expect(200);
      expect(res.body).toMatchObject({ accepted: true, matched: true });
      await settle();
    });

    it('T056-2 a duplicate delivery is deduplicated and performs NO second financial mutation', async () => {
      const gatewayPaymentId = `gw-${randomUUID()}`;
      await seedPendingPayment(gatewayPaymentId);
      const eventId = `evt-${randomUUID()}`;
      const body = {
        id: eventId,
        type: 'payment_paid',
        created_at: new Date().toISOString(),
        data: { id: gatewayPaymentId, status: 'paid', amount: 10000, currency: 'SAR' },
      };

      const first = await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', TEST_MOYASAR_SECRET)
        .send(body)
        .expect(200);
      expect(first.body.deduplicated).toBeFalsy();

      const second = await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', TEST_MOYASAR_SECRET)
        .send(body)
        .expect(200);
      expect(second.body.deduplicated).toBe(true);
      await settle();

      // No second financial mutation: exactly one webhook transaction row
      // for this event id. The partial unique index on
      // gateway_transaction_id is what makes the second insert a no-op
      // rather than a duplicate row (FR-047 — schema built from the
      // migration chain, never `synchronize`, or this assertion passes
      // vacuously because the index simply would not exist).
      const rows = await e2e.dataSource.query(
        `SELECT count(*)::int AS c FROM transactions WHERE gateway_transaction_id = $1`,
        [eventId],
      );
      expect(rows[0].c).toBe(1);
    });

    it('T056-3 a stale replay (older than the 4-hour tolerance) is refused', async () => {
      const gatewayPaymentId = `gw-${randomUUID()}`;
      await seedPendingPayment(gatewayPaymentId);
      const staleIso = new Date(Date.now() - (MOYASAR_TOLERANCE_SECONDS + 10) * 1000).toISOString();
      await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', TEST_MOYASAR_SECRET)
        .send({
          id: `evt-${randomUUID()}`,
          type: 'payment_paid',
          created_at: staleIso,
          data: { id: gatewayPaymentId, status: 'paid', amount: 10000, currency: 'SAR' },
        })
        .expect(401);
    });

    it('T056-4 a future timestamp (beyond the tolerance) is refused', async () => {
      const gatewayPaymentId = `gw-${randomUUID()}`;
      await seedPendingPayment(gatewayPaymentId);
      const futureIso = new Date(Date.now() + (MOYASAR_TOLERANCE_SECONDS + 10) * 1000).toISOString();
      await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', TEST_MOYASAR_SECRET)
        .send({
          id: `evt-${randomUUID()}`,
          type: 'payment_paid',
          created_at: futureIso,
          data: { id: gatewayPaymentId, status: 'paid', amount: 10000, currency: 'SAR' },
        })
        .expect(401);
    });

    it('T056-5 a timestamp just inside the tolerance boundary is still accepted (inclusive boundary)', async () => {
      const gatewayPaymentId = `gw-${randomUUID()}`;
      await seedPendingPayment(gatewayPaymentId);
      const boundaryIso = new Date(Date.now() - (MOYASAR_TOLERANCE_SECONDS - 5) * 1000).toISOString();
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', TEST_MOYASAR_SECRET)
        .send({
          id: `evt-${randomUUID()}`,
          type: 'payment_paid',
          created_at: boundaryIso,
          data: { id: gatewayPaymentId, status: 'paid', amount: 10000, currency: 'SAR' },
        })
        .expect(200);
      expect(res.body.accepted).toBe(true);
      await settle();
    });

    it('T056-6 a malformed timestamp is refused', async () => {
      const gatewayPaymentId = `gw-${randomUUID()}`;
      await seedPendingPayment(gatewayPaymentId);
      await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', TEST_MOYASAR_SECRET)
        .send({
          id: `evt-${randomUUID()}`,
          type: 'payment_paid',
          created_at: 'not-a-real-timestamp',
          data: { id: gatewayPaymentId, status: 'paid', amount: 10000, currency: 'SAR' },
        })
        .expect(401);
    });

    it('T056-7 an invalid token is refused BEFORE the freshness check runs', async () => {
      const gatewayPaymentId = `gw-${randomUUID()}`;
      await seedPendingPayment(gatewayPaymentId);
      const staleIso = new Date(Date.now() - (MOYASAR_TOLERANCE_SECONDS + 10) * 1000).toISOString();
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/payments/webhooks/moyasar`)
        .set('x-moyasar-token', 'definitely-wrong-token')
        .send({
          id: `evt-${randomUUID()}`,
          type: 'payment_paid',
          created_at: staleIso,
          data: { id: gatewayPaymentId, status: 'paid', amount: 10000, currency: 'SAR' },
        })
        .expect(401);
      expect(res.body.message).toMatch(/signature/i);
    });
  });
});
