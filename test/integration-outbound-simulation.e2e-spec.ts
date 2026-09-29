/**
 * Outbound webhooks against a SIMULATED PARTNER (matrix rows 33–38).
 *
 * The platform delivers a real, signed HTTP POST over a real socket to
 * `PartnerReceiver` (test/utils/partner-simulator.ts) — a partner-side server
 * that verifies the signature and dedupes on `X-Webhook-Id` using only the
 * documented contract, never the platform's own helpers.
 *
 * What is REAL here: the AppModule + HTTP API, Postgres, the transactional
 * outbox row, the domain event → WebhookEventListener → WebhookDeliveryService
 * path, the REAL `WebhookDeliveryProcessor` (signing, classification, state
 * transitions) and the real DNS-pinned, redirect-refusing HTTP client.
 *
 * What is NOT: the SSRF guard is relaxed for `127.0.0.1` ONLY, and ONLY while
 * `E2E_ALLOW_SIM_LOOPBACK=1` — the guard blocks loopback by design and the
 * simulator has to live there. Everything else it blocks (cloud metadata,
 * private ranges) stays blocked, and the flag is switched OFF to prove the real
 * guard rejects loopback (row 38). No BullMQ worker process runs in this suite
 * (same as the other integration e2e files): the processor's entry point is
 * invoked directly, once per attempt, the way BullMQ's retry would.
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
import { randomUUID } from 'node:crypto';
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
import { PartnerReceiver } from './utils/partner-simulator';

import { WebhookDelivery } from '../src/entities/System/WebhookDelivery';
import { OutboxJob } from '../src/entities/Campaigns/OutboxJob';
import {
  AppointmentCreatedEvent,
  APPOINTMENT_EVENT,
} from '../src/events/appointment.events';
import { WebhookDeliveryProcessor } from '../src/worker/processors/webhook-delivery.processor';
import { WebhookDeliveryService } from '../src/modules/platform/webhook-delivery.service';
import { WebhookEndpointService } from '../src/modules/platform/webhook-endpoint.service';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../src/queue/worker-authorization.service';
import { QueueService } from '../src/queue/queue.service';
import { JOB } from '../src/queue/queue.constants';

const API = '/api/v1';

async function cleanupWebhookTenant(
  e2e: E2eApp,
  tenantId: string,
): Promise<void> {
  const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
  await q(
    `DELETE FROM outbox_jobs WHERE dedupe_key IN (
       SELECT 'webhook-delivery-' || id FROM webhook_deliveries WHERE "tenantId" = $1)`,
  );
  await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
  await cleanupTenant(e2e, tenantId);
}

describe('Outbound webhooks ↔ simulated partner system (real HTTP delivery)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let other: OwnerFixture;
  let receiver: PartnerReceiver;
  let processor: WebhookDeliveryProcessor;
  const server = () => e2e.app.getHttpServer();

  const create = async (
    path: string,
    events: string[] = ['appointment.created'],
  ) => {
    const res = await request(server())
      .post(`${API}/platform/webhooks/endpoints`)
      .set(...authHeader(owner.token))
      .send({ name: `sim ${path}`, url: `${receiver.baseUrl}${path}`, events })
      .expect(201);
    receiver.setSecret(path, res.body.secret);
    return {
      id: res.body.id as string,
      secret: res.body.secret as string,
      path,
    };
  };

  const deliveriesOf = (endpointId: string) =>
    e2e.dataSource.getRepository(WebhookDelivery).find({
      where: { webhook_endpoint: { id: endpointId } },
      order: { created_at: 'ASC' },
    });

  const fire = async (): Promise<void> => {
    await e2e.app
      .get(EventEmitter2)
      .emitAsync(
        APPOINTMENT_EVENT.CREATED,
        new AppointmentCreatedEvent(
          owner.tenantId,
          `apt-${randomUUID().slice(0, 8)}`,
          'cust-1',
          'staff-1',
          'branch-1',
          new Date(),
        ),
      );
    await new Promise((r) => setTimeout(r, 250)); // the @OnEvent handler is async
  };

  /** One processor attempt, the way BullMQ would run it (`attemptsMade` = attempts already made). */
  const attempt = (deliveryId: string, attemptsMade = 0): Promise<void> =>
    processor.process({
      name: JOB.WEBHOOKS_DELIVER,
      data: {
        tenantId: owner.tenantId,
        webhookDeliveryId: deliveryId,
        correlationId: 'e2e',
      },
      attemptsMade,
    } as unknown as Job);

  const statusOf = async (deliveryId: string) =>
    await e2e.dataSource
      .getRepository(WebhookDelivery)
      .findOneByOrFail({ id: deliveryId });

  beforeAll(async () => {
    process.env.E2E_ALLOW_SIM_LOOPBACK = '1';
    receiver = new PartnerReceiver();
    await receiver.start();

    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'outsim');
    other = await createOwnerFixture(e2e, 'outsim-other');

    processor = new WebhookDeliveryProcessor(
      e2e.app.get(WebhookDeliveryService),
      e2e.app.get(WebhookEndpointService),
      e2e.app.get(TenantContextService),
      e2e.app.get(QueueService),
      e2e.app.get(WorkerAuthorizationService),
      e2e.config,
    );
  }, 120_000);

  afterAll(async () => {
    process.env.E2E_ALLOW_SIM_LOOPBACK = '0';
    await receiver?.stop();
    await cleanupWebhookTenant(e2e, owner.tenantId).catch(() => undefined);
    await cleanupWebhookTenant(e2e, other.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 60_000);

  // ── 33: delivery + signature ──────────────────────────────────────────────

  it('33 — a domain event is delivered over real HTTP, and the PARTNER independently verifies the signature', async () => {
    const ep = await create('/hooks/ok');
    await fire();

    const [delivery] = await deliveriesOf(ep.id);
    expect(delivery.status).toBe('PENDING');
    // Durable intent committed with the delivery row.
    const outbox = await e2e.dataSource
      .getRepository(OutboxJob)
      .findOneBy({ dedupe_key: `webhook-delivery-${delivery.id}` });
    expect(outbox).toBeTruthy();

    await attempt(delivery.id);

    const done = await statusOf(delivery.id);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.http_status).toBe(200);
    expect(done.attempt_count).toBe(1);

    const hooks = receiver.hooksFor('/hooks/ok');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      id: delivery.id, // the delivery row id IS the stable X-Webhook-Id
      event: 'appointment.created',
      verdict: 'valid', // HMAC(secret, ts.body) verified by the partner, constant-time
      duplicate: false,
    });
    expect(JSON.parse(hooks[0].rawBody)).toMatchObject({
      customerId: 'cust-1',
      branchId: 'branch-1',
    });
    expect(receiver.processedFor('/hooks/ok')).toHaveLength(1);
  }, 60_000);

  it('33b — the signature is bound to THIS secret: a partner holding a different secret rejects the delivery', async () => {
    const ep = await create('/hooks/wrong-secret');
    receiver.setSecret('/hooks/wrong-secret', 'whsec_not-the-real-secret');
    await fire();
    const [delivery] = await deliveriesOf(ep.id);
    await attempt(delivery.id);
    expect(receiver.hooksFor('/hooks/wrong-secret')[0].verdict).toBe(
      'bad_signature',
    );
  }, 60_000);

  // ── 34: retry + dedupe ────────────────────────────────────────────────────

  it('34 — a 500 is retried; the retry carries the SAME X-Webhook-Id and the partner processes the event once', async () => {
    const ep = await create('/hooks/flaky');
    receiver.reply('/hooks/flaky', { status: 500 }, { status: 200 });
    await fire();
    const [delivery] = await deliveriesOf(ep.id);

    // Attempt 1: transient → the processor throws so BullMQ retries.
    await expect(attempt(delivery.id, 0)).rejects.toThrow(/HTTP 500/);
    const afterFirst = await statusOf(delivery.id);
    expect(afterFirst.status).not.toBe('SUCCEEDED');
    expect(afterFirst.http_status).toBe(500);
    expect(afterFirst.last_error).toContain('500');

    // Attempt 2 (BullMQ's retry): succeeds.
    await attempt(delivery.id, 1);
    const done = await statusOf(delivery.id);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.attempt_count).toBe(2);

    const hooks = receiver.hooksFor('/hooks/flaky');
    expect(hooks).toHaveLength(2);
    expect(hooks[0].id).toBe(hooks[1].id); // identical id across attempts → dedupe key
    expect(hooks.every((h) => h.verdict === 'valid')).toBe(true);
    // The signing timestamp is regenerated per attempt, so a delayed retry is not "stale".
    expect(receiver.processedFor('/hooks/flaky')).toHaveLength(1);
  }, 60_000);

  it('34b — re-running an already-SUCCEEDED delivery (stalled-job re-execution) sends nothing more', async () => {
    const ep = await create('/hooks/once');
    await fire();
    const [delivery] = await deliveriesOf(ep.id);
    await attempt(delivery.id);
    await attempt(delivery.id, 1);
    expect(receiver.hooksFor('/hooks/once')).toHaveLength(1);
  }, 60_000);

  // ── 35: permanent failures ────────────────────────────────────────────────

  it('35 — a 400 is a PERMANENT failure: marked FAILED, no retry, the processor does not throw', async () => {
    const ep = await create('/hooks/bad-request');
    receiver.reply('/hooks/bad-request', {
      status: 400,
      body: '{"error":"nope"}',
    });
    await fire();
    const [delivery] = await deliveriesOf(ep.id);

    await expect(attempt(delivery.id)).resolves.toBeUndefined();
    const done = await statusOf(delivery.id);
    expect(done.status).toBe('FAILED');
    expect(done.http_status).toBe(400);
    expect(receiver.hooksFor('/hooks/bad-request')).toHaveLength(1);
  }, 60_000);

  it('35b — a 302 redirect is NEVER followed (would be an SSRF pivot) and is permanent', async () => {
    const ep = await create('/hooks/redirect');
    receiver.reply('/hooks/redirect', {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
    });
    await fire();
    const [delivery] = await deliveriesOf(ep.id);

    await expect(attempt(delivery.id)).resolves.toBeUndefined();
    const done = await statusOf(delivery.id);
    expect(done.status).toBe('FAILED');
    expect(done.http_status).toBe(302);
    expect(receiver.hooksFor('/hooks/redirect')).toHaveLength(1); // exactly one request: nothing followed
  }, 60_000);

  it('35c — a receiver that never answers times out as a TRANSIENT failure (retryable), not a hang', async () => {
    const ep = await create('/hooks/slow');
    receiver.reply('/hooks/slow', { status: 200, delayMs: 3_000 });
    await fire();
    const [delivery] = await deliveriesOf(ep.id);
    // Tight timeout for THIS attempt only.
    const fast = new WebhookDeliveryProcessor(
      e2e.app.get(WebhookDeliveryService),
      e2e.app.get(WebhookEndpointService),
      e2e.app.get(TenantContextService),
      e2e.app.get(QueueService),
      e2e.app.get(WorkerAuthorizationService),
      {
        get: (k: string, d: unknown) =>
          k === 'WEBHOOK_DELIVERY_TIMEOUT_MS' ? 400 : d,
      } as never,
    );
    await expect(
      fast.process({
        name: JOB.WEBHOOKS_DELIVER,
        data: { tenantId: owner.tenantId, webhookDeliveryId: delivery.id },
        attemptsMade: 0,
      } as unknown as Job),
    ).rejects.toThrow();
    expect((await statusOf(delivery.id)).status).not.toBe('SUCCEEDED');
  }, 30_000);

  // ── 36: test event ────────────────────────────────────────────────────────

  it('36 — "Send test event" queues a webhook.test delivery that the partner receives and verifies', async () => {
    const ep = await create('/hooks/test-event');
    const res = await request(server())
      .post(`${API}/platform/webhooks/endpoints/${ep.id}/test`)
      .set(...authHeader(owner.token))
      .expect(202);
    expect(res.body).toMatchObject({
      eventType: 'webhook.test',
      status: 'PENDING',
    });

    await attempt(res.body.id);
    const hooks = receiver.hooksFor('/hooks/test-event');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ event: 'webhook.test', verdict: 'valid' });
    expect(JSON.parse(hooks[0].rawBody)).toMatchObject({
      test: true,
      webhookEndpointId: ep.id,
    });

    // A test event uses the delivery history like any other.
    const list = await request(server())
      .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${ep.id}`)
      .set(...authHeader(owner.token))
      .expect(200);
    expect(list.body.data[0]).toMatchObject({
      eventType: 'webhook.test',
      status: 'SUCCEEDED',
    });
  }, 60_000);

  it('36b — another clinic cannot send a test event to this endpoint (404, nothing queued)', async () => {
    const ep = await create('/hooks/test-idor');
    await request(server())
      .post(`${API}/platform/webhooks/endpoints/${ep.id}/test`)
      .set(...authHeader(other.token))
      .expect(404);
    expect(await deliveriesOf(ep.id)).toHaveLength(0);
  }, 30_000);

  // ── 37: secret rotation ───────────────────────────────────────────────────

  it("37 — after rotating the secret, the partner's OLD secret fails verification and the NEW one passes", async () => {
    const ep = await create('/hooks/rotate');
    const oldSecret = ep.secret;

    const rotated = await request(server())
      .post(`${API}/platform/webhooks/endpoints/${ep.id}/rotate-secret`)
      .set(...authHeader(owner.token))
      .expect(200);
    const newSecret: string = rotated.body.secret;
    expect(newSecret).not.toBe(oldSecret);

    // Partner still holding the OLD secret → rejects.
    receiver.setSecret('/hooks/rotate', oldSecret);
    await fire();
    const [d1] = await deliveriesOf(ep.id);
    await attempt(d1.id);
    expect(receiver.hooksFor('/hooks/rotate')[0].verdict).toBe('bad_signature');

    // Partner updated to the NEW secret → accepts.
    receiver.setSecret('/hooks/rotate', newSecret);
    await fire();
    const deliveries = await deliveriesOf(ep.id);
    await attempt(deliveries[deliveries.length - 1].id);
    const hooks = receiver.hooksFor('/hooks/rotate');
    expect(hooks[hooks.length - 1].verdict).toBe('valid');
  }, 60_000);

  it('37b — a deactivated endpoint is never delivered to (marked FAILED, the partner sees nothing)', async () => {
    const ep = await create('/hooks/disabled');
    await fire();
    const [delivery] = await deliveriesOf(ep.id);
    await request(server())
      .post(`${API}/platform/webhooks/endpoints/${ep.id}/deactivate`)
      .set(...authHeader(owner.token))
      .expect(200);

    await attempt(delivery.id);
    expect((await statusOf(delivery.id)).status).toBe('FAILED');
    expect(receiver.hooksFor('/hooks/disabled')).toHaveLength(0);
  }, 60_000);

  // ── 38: the REAL SSRF guard ───────────────────────────────────────────────

  describe('38 — the real SSRF guard (loopback exemption switched OFF)', () => {
    beforeAll(() => {
      process.env.E2E_ALLOW_SIM_LOOPBACK = '0';
    });
    afterAll(() => {
      process.env.E2E_ALLOW_SIM_LOOPBACK = '1';
    });

    it.each([
      ['loopback IPv4', 'http://127.0.0.1:9/hook'],
      ['localhost', 'http://localhost/hook'],
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['private range', 'http://10.0.0.5/hook'],
      ['IPv6 loopback', 'http://[::1]/hook'],
      ['a blocked service port', 'http://203.0.113.10:6379/hook'],
    ])('refuses to register an endpoint at %s', async (_label, url) => {
      const res = await request(server())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'ssrf', url, events: ['appointment.created'] })
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain(owner.tenantId);
    });

    it('re-validates at DELIVERY time: an endpoint that became unsafe is blocked, permanently, with no request sent', async () => {
      // Registered while the exemption is on, then the exemption goes away — as if
      // the rule had tightened (or DNS rebinding pointed the name at loopback).
      process.env.E2E_ALLOW_SIM_LOOPBACK = '1';
      const ep = await create('/hooks/became-unsafe');
      await fire();
      const [delivery] = await deliveriesOf(ep.id);
      process.env.E2E_ALLOW_SIM_LOOPBACK = '0';

      await expect(attempt(delivery.id)).resolves.toBeUndefined(); // permanent, not retried
      const done = await statusOf(delivery.id);
      expect(done.status).toBe('FAILED');
      expect(done.last_error).toMatch(/not allowed/i); // and never says WHICH address
      expect(receiver.hooksFor('/hooks/became-unsafe')).toHaveLength(0);
    }, 60_000);
  });
});
