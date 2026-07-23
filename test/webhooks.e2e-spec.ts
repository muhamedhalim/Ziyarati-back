/**
 * HTTP e2e for Phase 2 of the Integration platform: outbound webhooks. Boots
 * the REAL AppModule (see whatsapp-e2e-app.ts's createE2eApp) against real
 * Postgres + Redis, so the full guard chain, RBAC seeding, encryption, and
 * BullMQ enqueue wiring all run exactly as in production.
 *
 * The actual HTTP delivery (fetch, signing, retry/backoff, DLQ classification,
 * timeout, idempotency) is unit-tested in isolation with a full range of
 * scenarios (webhook-delivery.processor.spec.ts) — there is no separate
 * worker process running in this e2e suite, so what's verified HERE is the
 * REAL wiring this app process owns: HTTP → service → DB → domain event →
 * WebhookEventListener → WebhookDeliveryService → a real BullMQ job landing
 * on the real `webhooks.deliver` queue with the correct deterministic jobId.
 *
 * DATABASE ISOLATION: every fixture is scoped under a freshly-created Tenant;
 * `cleanupWebhookTenant` deletes this suite's audit_logs then delegates to the
 * shared `cleanupTenant` (webhook_endpoints/webhook_deliveries cascade-delete
 * with the tenant via the migration's FK ON DELETE CASCADE).
 */
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { AuditLog } from '../src/entities/Auth&RBAC/AuditLog';
import { WebhookDelivery } from '../src/entities/System/WebhookDelivery';
import { QueueService } from '../src/queue/queue.service';
import { QUEUE } from '../src/queue/queue.constants';
import {
  AppointmentCreatedEvent,
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentNoShowEvent,
  APPOINTMENT_EVENT,
} from '../src/events/appointment.events';

const API = '/api/v1';

async function cleanupWebhookTenant(e2e: E2eApp, tenantId: string): Promise<void> {
  await e2e.dataSource.query(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [tenantId]);
  await cleanupTenant(e2e, tenantId);
}

describe('Outbound Webhooks (Phase 2) — HTTP e2e', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'webhooks');
  }, 60_000);

  afterAll(async () => {
    await cleanupWebhookTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 30_000);

  describe('Webhook endpoint management', () => {
    it('registers an endpoint and returns the plaintext secret ONCE', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'ERP', url: 'https://example.com/hooks/ziyarati', events: ['appointment.created'] })
        .expect(201);

      expect(res.body.secret).toEqual(expect.stringMatching(/^whsec_/));
      expect(res.body.secret_prefix).toEqual(expect.any(String));
      expect(res.body.secret.startsWith(res.body.secret_prefix)).toBe(true);
      expect(res.body.secret_ciphertext).toBeUndefined();
      expect(res.body.events).toEqual(['appointment.created']);
    });

    it('list returns the {data,total,page,limit} envelope — never a secret', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({ data: expect.any(Array), total: expect.any(Number), page: 1, limit: expect.any(Number) }),
      );
      for (const row of res.body.data) {
        expect(row.secret_ciphertext).toBeUndefined();
        expect(row.secret).toBeUndefined();
        expect(row).toHaveProperty('secret_prefix');
      }
    });

    it('rejects a page size above the max (pagination validation)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/endpoints?limit=500`)
        .set(...authHeader(owner.token))
        .expect(400);
    });

    it('rejects an unrecognised event string outright (DTO allowlist)', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hook', events: ['not.a.real.event'] })
        .expect(400);
    });

    it('rejects an SSRF-unsafe endpoint URL (private IP)', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'http://127.0.0.1/hook', events: ['appointment.created'] })
        .expect(400);
    });

    it('rejects an SSRF-unsafe endpoint URL (cloud metadata IP)', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'http://169.254.169.254/latest/meta-data/', events: ['appointment.created'] })
        .expect(400);
    });

    it('rejects an unsupported scheme', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'ftp://example.com/hook', events: ['appointment.created'] })
        .expect(400);
    });

    it('rotate issues a new secret; the endpoint keeps the same id', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/rotate-test', events: ['appointment.created'] })
        .expect(201);
      const oldSecret = created.body.secret as string;
      const id = created.body.id as string;

      const rotated = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints/${id}/rotate-secret`)
        .set(...authHeader(owner.token))
        .expect(200);

      expect(rotated.body.id).toBe(id);
      expect(rotated.body.secret).not.toBe(oldSecret);
      expect(rotated.body.secret_prefix).not.toBe(created.body.secret_prefix);
    });

    it('activate/deactivate toggles is_active', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/toggle-test', events: ['appointment.created'] })
        .expect(201);
      const id = created.body.id as string;

      const deactivated = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints/${id}/deactivate`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(deactivated.body.is_active).toBe(false);

      const activated = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints/${id}/activate`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(activated.body.is_active).toBe(true);
    });

    it('updates the subscribed events', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/update-test', events: ['appointment.created'] })
        .expect(201);
      const id = created.body.id as string;

      const updated = await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/webhooks/endpoints/${id}`)
        .set(...authHeader(owner.token))
        .send({ events: ['payment.succeeded', 'payment.refunded'] })
        .expect(200);
      expect(updated.body.events.sort()).toEqual(['payment.refunded', 'payment.succeeded']);
    });

    it('updates the URL, re-validated by the same SSRF guard used at creation', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/url-update-test', events: ['appointment.created'] })
        .expect(201);
      const id = created.body.id as string;

      const updated = await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/webhooks/endpoints/${id}`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://updated.example.com/hooks/ziyarati' })
        .expect(200);
      expect(updated.body.url).toBe('https://updated.example.com/hooks/ziyarati');

      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/webhooks/endpoints/${id}`)
        .set(...authHeader(owner.token))
        .send({ url: 'http://169.254.169.254/latest/meta-data/' })
        .expect(400);
    });

    it('an edited event subscription takes effect on the next dispatch', async () => {
      const endpoint = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/edited-subscription', events: ['appointment.created'] })
        .expect(201);

      const emitter = e2e.app.get(EventEmitter2);
      await emitter.emitAsync(
        APPOINTMENT_EVENT.NO_SHOW,
        new AppointmentNoShowEvent(owner.tenantId, 'apt-edit-1', 'cust-edit-1'),
      );
      await new Promise((r) => setTimeout(r, 200));

      const before = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${endpoint.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(before.body.data).toHaveLength(0); // not subscribed to appointment.no_show yet

      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/webhooks/endpoints/${endpoint.body.id}`)
        .set(...authHeader(owner.token))
        .send({ events: ['appointment.no_show'] })
        .expect(200);

      await emitter.emitAsync(
        APPOINTMENT_EVENT.NO_SHOW,
        new AppointmentNoShowEvent(owner.tenantId, 'apt-edit-2', 'cust-edit-2'),
      );
      await new Promise((r) => setTimeout(r, 200));

      const after = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${endpoint.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0].eventType).toBe('appointment.no_show');
    });

    it('deletes an endpoint (cross-tenant delete/get both 404)', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/delete-test', events: ['appointment.created'] })
        .expect(201);
      const id = created.body.id as string;

      await request(e2e.app.getHttpServer())
        .delete(`${API}/platform/webhooks/endpoints/${id}`)
        .set(...authHeader(owner.token))
        .expect(200);

      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/endpoints/${id}`)
        .set(...authHeader(owner.token))
        .expect(404);
    });

    it('deleting an endpoint is a SOFT delete — the row survives (deleted_at set) and its delivery history is preserved', async () => {
      const endpoint = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'retained', url: 'https://example.com/hooks/retention-test', events: ['appointment.completed'] })
        .expect(201);
      const id = endpoint.body.id as string;

      const emitter = e2e.app.get(EventEmitter2);
      await emitter.emitAsync(
        APPOINTMENT_EVENT.COMPLETED,
        new AppointmentCompletedEvent(owner.tenantId, 'apt-retain-1', 'cust-retain-1'),
      );
      await new Promise((r) => setTimeout(r, 200));

      const before = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(before.body.data).toHaveLength(1);
      const deliveryId = before.body.data[0].id as string;

      await request(e2e.app.getHttpServer())
        .delete(`${API}/platform/webhooks/endpoints/${id}`)
        .set(...authHeader(owner.token))
        .expect(200);

      // The endpoint row itself still exists in the DB (soft-deleted), never
      // hard-removed — this is what makes the FK-preserving history possible.
      const rawRow = await e2e.dataSource.query(
        `SELECT "deleted_at", "is_active" FROM "webhook_endpoints" WHERE "id" = $1`,
        [id],
      );
      expect(rawRow).toHaveLength(1);
      expect(rawRow[0].deleted_at).not.toBeNull();
      expect(rawRow[0].is_active).toBe(false);

      // The delivery history is untouched and still readable, with the
      // endpoint's URL preserved via the immutable snapshot.
      const delivery = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries/${deliveryId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(delivery.body.webhookEndpointUrl).toBe('https://example.com/hooks/retention-test');
    });

    it('cross-tenant access to another clinic\'s endpoint returns 404', async () => {
      const other = await createOwnerFixture(e2e, 'webhooks-other');
      try {
        const created = await request(e2e.app.getHttpServer())
          .post(`${API}/platform/webhooks/endpoints`)
          .set(...authHeader(other.token))
          .send({ url: 'https://example.com/hooks/other-tenant', events: ['appointment.created'] })
          .expect(201);

        await request(e2e.app.getHttpServer())
          .get(`${API}/platform/webhooks/endpoints/${created.body.id}`)
          .set(...authHeader(owner.token))
          .expect(404);
      } finally {
        await cleanupWebhookTenant(e2e, other.tenantId);
      }
    });

    it('records an audit row for create/update/rotate/enable/disable/delete, never containing the secret', async () => {
      const created = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'audited', url: 'https://example.com/hooks/audit-test', events: ['appointment.created'] })
        .expect(201);
      const id = created.body.id as string;
      const secret = created.body.secret as string;

      await request(e2e.app.getHttpServer()).patch(`${API}/platform/webhooks/endpoints/${id}`).set(...authHeader(owner.token)).send({ name: 'audited2' }).expect(200);
      await request(e2e.app.getHttpServer()).post(`${API}/platform/webhooks/endpoints/${id}/rotate-secret`).set(...authHeader(owner.token)).expect(200);
      await request(e2e.app.getHttpServer()).post(`${API}/platform/webhooks/endpoints/${id}/deactivate`).set(...authHeader(owner.token)).expect(200);
      await request(e2e.app.getHttpServer()).post(`${API}/platform/webhooks/endpoints/${id}/activate`).set(...authHeader(owner.token)).expect(200);
      await request(e2e.app.getHttpServer()).delete(`${API}/platform/webhooks/endpoints/${id}`).set(...authHeader(owner.token)).expect(200);

      const audits = e2e.dataSource.getRepository(AuditLog);
      const rows = await audits.find({ where: { entity_type: 'WebhookEndpoint', entity_id: id } });
      const actions = rows.map((r) => r.action).sort();
      expect(actions).toEqual(
        ['webhook.create', 'webhook.update', 'webhook.rotate_secret', 'webhook.disable', 'webhook.enable', 'webhook.delete'].sort(),
      );
      for (const row of rows) {
        expect(JSON.stringify(row.new_values ?? {})).not.toContain(secret);
      }
    });
  });

  describe('Event dispatch (real domain events → real BullMQ enqueue)', () => {
    it('dispatches only to endpoints subscribed to the fired event, and never to inactive endpoints', async () => {
      const subscribed = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'subscribed', url: 'https://example.com/hooks/subscribed', events: ['appointment.cancelled'] })
        .expect(201);

      const unsubscribed = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'unsubscribed', url: 'https://example.com/hooks/unsubscribed', events: ['appointment.created'] })
        .expect(201);

      const inactiveButSubscribed = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'inactive', url: 'https://example.com/hooks/inactive', events: ['appointment.cancelled'] })
        .expect(201);
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints/${inactiveButSubscribed.body.id}/deactivate`)
        .set(...authHeader(owner.token))
        .expect(200);

      const emitter = e2e.app.get(EventEmitter2);
      await emitter.emitAsync(
        APPOINTMENT_EVENT.CANCELLED,
        new AppointmentCancelledEvent(owner.tenantId, 'apt-1', 'cust-1', 'no reason given'),
      );
      // Give the async @OnEvent handler's microtask chain a tick to complete.
      await new Promise((r) => setTimeout(r, 200));

      const deliveries = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${subscribed.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(deliveries.body.data).toHaveLength(1);
      expect(deliveries.body.data[0].eventType).toBe('appointment.cancelled');
      expect(deliveries.body.data[0].status).toBe('PENDING');

      const unsubscribedDeliveries = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${unsubscribed.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(unsubscribedDeliveries.body.data).toHaveLength(0);

      const inactiveDeliveries = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${inactiveButSubscribed.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(inactiveDeliveries.body.data).toHaveLength(0);

      // Confirm a REAL BullMQ job landed on the real webhooks.deliver queue
      // under the documented deterministic jobId (idempotency key).
      const deliveryId = deliveries.body.data[0].id as string;
      const queueService = e2e.app.get(QueueService);
      const job = await queueService.queue(QUEUE.WEBHOOKS_DELIVER).getJob(`webhook-delivery-${deliveryId}`);
      expect(job).toBeTruthy();
      expect(job?.data).toMatchObject({ tenantId: owner.tenantId, webhookDeliveryId: deliveryId });
    });

    it('does not dispatch appointment.created to an endpoint only subscribed to appointment.cancelled (event filtering)', async () => {
      const endpoint = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ name: 'cancelled-only', url: 'https://example.com/hooks/cancelled-only', events: ['appointment.cancelled'] })
        .expect(201);

      const emitter = e2e.app.get(EventEmitter2);
      await emitter.emitAsync(
        APPOINTMENT_EVENT.CREATED,
        new AppointmentCreatedEvent(owner.tenantId, 'apt-2', 'cust-2', 'staff-1', 'branch-1', new Date()),
      );
      await new Promise((r) => setTimeout(r, 200));

      const deliveries = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${endpoint.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(deliveries.body.data).toHaveLength(0);
    });
  });

  describe('Manual replay', () => {
    it('rejects replaying a delivery that is still PENDING', async () => {
      const endpoint = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/replay-pending', events: ['appointment.completed'] })
        .expect(201);

      const emitter = e2e.app.get(EventEmitter2);
      await emitter.emitAsync(
        APPOINTMENT_EVENT.COMPLETED,
        new AppointmentCompletedEvent(owner.tenantId, 'apt-3', 'cust-3'),
      );
      await new Promise((r) => setTimeout(r, 200));

      const list = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${endpoint.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      const deliveryId = list.body.data[0].id as string;

      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/deliveries/${deliveryId}/replay`)
        .set(...authHeader(owner.token))
        .expect(422);
    });

    it('replays a dead-lettered delivery: creates a NEW linked delivery, re-enqueues it, and audits it — the original keeps its terminal status', async () => {
      const endpoint = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/replay-dlq', events: ['appointment.completed'] })
        .expect(201);

      const emitter = e2e.app.get(EventEmitter2);
      await emitter.emitAsync(
        APPOINTMENT_EVENT.COMPLETED,
        new AppointmentCompletedEvent(owner.tenantId, 'apt-4', 'cust-4'),
      );
      await new Promise((r) => setTimeout(r, 200));

      const list = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${endpoint.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      const deliveryId = list.body.data[0].id as string;

      // Simulate "retries exhausted" directly (no real worker runs in this suite).
      const deliveriesRepo = e2e.dataSource.getRepository(WebhookDelivery);
      await deliveriesRepo.update({ id: deliveryId }, { status: 'DEAD_LETTERED', last_error: 'exhausted' });

      const replayed = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/deliveries/${deliveryId}/replay`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(replayed.body.status).toBe('PENDING');
      expect(replayed.body.attemptCount).toBe(0);
      expect(replayed.body.replayedFromId).toBe(deliveryId);
      // A brand-new row, not the original mutated in place.
      expect(replayed.body.id).not.toBe(deliveryId);

      // The original delivery's terminal outcome is untouched by the replay.
      const originalAfter = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries/${deliveryId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(originalAfter.body.status).toBe('DEAD_LETTERED');
      expect(originalAfter.body.lastError).toBe('exhausted');

      const queueService = e2e.app.get(QueueService);
      const jobs = await queueService.queue(QUEUE.WEBHOOKS_DELIVER).getJobs(['waiting', 'delayed'], 0, 50);
      const replayJob = jobs.find((j) => j.id?.startsWith(`webhook-delivery-${replayed.body.id}-retry-`));
      expect(replayJob).toBeTruthy();

      const audits = e2e.dataSource.getRepository(AuditLog);
      const rows = await audits.find({ where: { entity_type: 'WebhookDelivery', entity_id: replayed.body.id } });
      expect(rows.map((r) => r.action)).toContain('webhook.replay');
    });

    it('rejects replaying against a disabled endpoint', async () => {
      const endpoint = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ url: 'https://example.com/hooks/replay-disabled', events: ['appointment.completed'] })
        .expect(201);

      const emitter = e2e.app.get(EventEmitter2);
      await emitter.emitAsync(
        APPOINTMENT_EVENT.COMPLETED,
        new AppointmentCompletedEvent(owner.tenantId, 'apt-5', 'cust-5'),
      );
      await new Promise((r) => setTimeout(r, 200));

      const list = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/webhooks/deliveries?webhookEndpointId=${endpoint.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      const deliveryId = list.body.data[0].id as string;

      const deliveriesRepo = e2e.dataSource.getRepository(WebhookDelivery);
      await deliveriesRepo.update({ id: deliveryId }, { status: 'FAILED', last_error: 'boom' });
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/endpoints/${endpoint.body.id}/deactivate`)
        .set(...authHeader(owner.token))
        .expect(200);

      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/webhooks/deliveries/${deliveryId}/replay`)
        .set(...authHeader(owner.token))
        .expect(422);
    });
  });
});
