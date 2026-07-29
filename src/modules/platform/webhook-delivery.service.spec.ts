import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Not } from 'typeorm';

import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookAuditService, WEBHOOK_AUDIT_ACTION } from './webhook-audit.service';
import { WebhookDelivery } from '../../entities/System/WebhookDelivery';
import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { QueueService } from '../../queue/queue.service';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
  createMockConfigService,
  createMockDataSource,
  createMockEntityManager,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let deliveries: MockRepository;
  let endpointsService: { findActiveSubscribers: jest.Mock };
  let queue: { enqueueWebhookDeliver: jest.Mock; retryWebhookDeliver: jest.Mock };
  let audit: { record: jest.Mock };
  let manager: MockEntityManager;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    deliveries = createMockRepository();
    endpointsService = { findActiveSubscribers: jest.fn().mockResolvedValue([]) };
    queue = {
      enqueueWebhookDeliver: jest.fn().mockResolvedValue({ id: 'job-1' }),
      retryWebhookDeliver: jest.fn().mockResolvedValue({ id: 'job-2' }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryService,
        { provide: getRepositoryToken(WebhookDelivery), useValue: deliveries },
        { provide: WebhookEndpointService, useValue: endpointsService },
        { provide: QueueService, useValue: queue },
        { provide: WebhookAuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: createMockConfigService({
            WEBHOOK_DELIVERY_MAX_ATTEMPTS: 6,
            WEBHOOK_DELIVERY_BACKOFF_MS: 5000,
          }),
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(WebhookDeliveryService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('dispatchEvent (event filtering + fan-out via the transactional outbox)', () => {
    it('writes one WebhookDelivery row + one OutboxJob row per active subscriber, in one transaction', async () => {
      endpointsService.findActiveSubscribers.mockResolvedValueOnce([
        { id: 'ep1' },
        { id: 'ep2' },
      ]);
      manager.save.mockImplementation(async (d: any) => ({ ...d, id: d.id ?? `saved-${Math.random()}` }));

      await service.dispatchEvent(TENANT, 'appointment.created', { appointmentId: 'a1' });

      expect(dataSource.transaction).toHaveBeenCalledTimes(2); // one per endpoint
      // Never falls back to the direct-enqueue path — the whole point of the outbox.
      expect(queue.enqueueWebhookDeliver).not.toHaveBeenCalled();

      const deliveryCreates = manager.create.mock.calls.filter((c) => c[0] === WebhookDelivery);
      const outboxCreates = manager.create.mock.calls.filter((c) => c[0] === OutboxJob);
      expect(deliveryCreates).toHaveLength(2);
      expect(outboxCreates).toHaveLength(2);
      expect(deliveryCreates[0][1]).toMatchObject({
        tenant: { id: TENANT },
        webhook_endpoint: { id: 'ep1' },
        event_type: 'appointment.created',
        payload: { appointmentId: 'a1' },
        status: 'PENDING',
      });
      expect(outboxCreates[0][1]).toMatchObject({
        queue: 'webhooks.deliver',
        job_name: 'webhooks.deliver',
        opts: expect.objectContaining({ attempts: 6 }),
      });
      // The outbox row references the delivery it belongs to.
      expect(outboxCreates[0][1].payload).toMatchObject({ tenantId: TENANT });
      expect(outboxCreates[0][1].dedupe_key).toMatch(/^webhook-delivery-/);
    });

    it('never dispatches to an endpoint not subscribed to the event (filtering happens in WebhookEndpointService)', async () => {
      endpointsService.findActiveSubscribers.mockResolvedValueOnce([]);
      await service.dispatchEvent(TENANT, 'payment.failed', {});
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('one endpoint whose transaction fails does not block the others — and never leaves a half-written row', async () => {
      endpointsService.findActiveSubscribers.mockResolvedValueOnce([{ id: 'ep1' }, { id: 'ep2' }]);
      dataSource.transaction
        .mockRejectedValueOnce(new Error('db down'))
        .mockImplementationOnce(async (cb: any) => cb(manager));

      await expect(
        service.dispatchEvent(TENANT, 'appointment.created', {}),
      ).resolves.toBeUndefined();
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      // Only the second (successful) endpoint actually wrote anything.
      expect(manager.save).toHaveBeenCalledTimes(2); // delivery + outbox for ep2 only
    });

    it('a lookup failure for subscribers is caught and logged, never thrown', async () => {
      endpointsService.findActiveSubscribers.mockRejectedValueOnce(new Error('db down'));
      await expect(service.dispatchEvent(TENANT, 'appointment.created', {})).resolves.toBeUndefined();
    });
  });

  describe('replay (manual replay from the dashboard)', () => {
    it('rejects replaying a delivery that is not FAILED/DEAD_LETTERED', async () => {
      deliveries.findOne.mockResolvedValueOnce({
        id: 'd1',
        status: 'SUCCEEDED',
        webhook_endpoint: { id: 'ep1', is_active: true, url: 'https://example.com/hook' },
      });
      await expect(service.replay(TENANT, 'd1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(queue.retryWebhookDeliver).not.toHaveBeenCalled();
    });

    it('rejects replaying against a disabled endpoint', async () => {
      deliveries.findOne.mockResolvedValueOnce({
        id: 'd1',
        status: 'DEAD_LETTERED',
        webhook_endpoint: { id: 'ep1', is_active: false, url: 'https://example.com/hook' },
      });
      await expect(service.replay(TENANT, 'd1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects replaying a delivery whose endpoint no longer exists (nullable relation)', async () => {
      deliveries.findOne.mockResolvedValueOnce({
        id: 'd1',
        status: 'FAILED',
        webhook_endpoint: undefined,
      });
      await expect(service.replay(TENANT, 'd1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('creates a NEW linked delivery row with the exact original event/payload — the original row is never mutated', async () => {
      const original = {
        id: 'd1',
        status: 'DEAD_LETTERED',
        event_type: 'appointment.created',
        payload: { appointmentId: 'a1' },
        attempt_count: 6,
        http_status: 500,
        last_error: 'boom',
        webhook_endpoint: { id: 'ep1', is_active: true, url: 'https://example.com/hook' },
      };
      deliveries.findOne.mockResolvedValueOnce(original);
      deliveries.save.mockImplementationOnce(async (d: any) => ({ ...d, id: 'd-replay-1' }));

      const result = await service.replay(TENANT, 'd1', { userId: 'u1', ip: '1.2.3.4' });

      expect(deliveries.save).toHaveBeenCalledTimes(1);
      const created = deliveries.save.mock.calls[0][0];
      expect(created.status).toBe('PENDING');
      expect(created.event_type).toBe('appointment.created');
      expect(created.payload).toEqual({ appointmentId: 'a1' });
      expect(created.replayed_from_id).toBe('d1');
      expect(created.webhook_endpoint_url_snapshot).toBe('https://example.com/hook');
      // The original keeps its terminal outcome — nothing about it was reset.
      expect(original.status).toBe('DEAD_LETTERED');
      expect(original.attempt_count).toBe(6);

      expect(queue.retryWebhookDeliver).toHaveBeenCalledWith(
        { tenantId: TENANT, webhookDeliveryId: 'd-replay-1' },
        expect.objectContaining({ attempts: 6 }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        WEBHOOK_AUDIT_ACTION.REPLAY,
        TENANT,
        'u1',
        'WebhookDelivery',
        'd-replay-1',
        '1.2.3.4',
        expect.objectContaining({ eventType: 'appointment.created', replayedFromId: 'd1' }),
      );
      expect(result.id).toBe('d-replay-1');
    });

    it('404s for a delivery not owned by the tenant', async () => {
      deliveries.findOne.mockResolvedValueOnce(null);
      await expect(service.replay(TENANT, 'x', {})).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('processor-facing mark* methods (idempotent status transitions)', () => {
    it('markSucceeded sets SUCCEEDED + clears last_error', async () => {
      await service.markSucceeded('d1', 200, 'ok');
      expect(deliveries.update).toHaveBeenCalledWith(
        { id: 'd1' },
        expect.objectContaining({ status: 'SUCCEEDED', http_status: 200, response_preview: 'ok' }),
      );
    });

    it('markFailedPermanent sets FAILED with the error', async () => {
      await service.markFailedPermanent('d1', 404, 'not found', 'HTTP 404');
      expect(deliveries.update).toHaveBeenCalledWith(
        { id: 'd1' },
        expect.objectContaining({ status: 'FAILED', last_error: 'HTTP 404' }),
      );
    });

    it('markDeadLettered sets DEAD_LETTERED conditionally (not already DEAD_LETTERED) and reports the transition happened', async () => {
      const result = await service.markDeadLettered('d1', 'exhausted');
      expect(result).toBe(true);
      expect(deliveries.update).toHaveBeenCalledWith(
        { id: 'd1', status: Not('DEAD_LETTERED') },
        expect.objectContaining({ status: 'DEAD_LETTERED', last_error: 'exhausted' }),
      );
    });

    it('markDeadLettered reports no transition when the row was already DEAD_LETTERED (exactly-once guard)', async () => {
      deliveries.update.mockResolvedValueOnce({ affected: 0 });
      const result = await service.markDeadLettered('d1', 'exhausted again');
      expect(result).toBe(false);
    });
  });
});
