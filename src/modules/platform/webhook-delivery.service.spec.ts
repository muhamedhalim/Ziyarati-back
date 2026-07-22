import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookAuditService, WEBHOOK_AUDIT_ACTION } from './webhook-audit.service';
import { WebhookDelivery } from '../../entities/System/WebhookDelivery';
import { QueueService } from '../../queue/queue.service';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository, createMockConfigService } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let deliveries: MockRepository;
  let endpointsService: { findActiveSubscribers: jest.Mock };
  let queue: { enqueueWebhookDeliver: jest.Mock; retryWebhookDeliver: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    deliveries = createMockRepository();
    endpointsService = { findActiveSubscribers: jest.fn().mockResolvedValue([]) };
    queue = {
      enqueueWebhookDeliver: jest.fn().mockResolvedValue({ id: 'job-1' }),
      retryWebhookDeliver: jest.fn().mockResolvedValue({ id: 'job-2' }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

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
      ],
    }).compile();
    service = moduleRef.get(WebhookDeliveryService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('dispatchEvent (event filtering + fan-out)', () => {
    it('creates one delivery row + enqueues one job per active subscriber', async () => {
      endpointsService.findActiveSubscribers.mockResolvedValueOnce([
        { id: 'ep1' },
        { id: 'ep2' },
      ]);
      deliveries.save.mockImplementation(async (d: any) => ({ ...d, id: `d-${d.webhook_endpoint.id}` }));

      await service.dispatchEvent(TENANT, 'appointment.created', { appointmentId: 'a1' });

      expect(deliveries.save).toHaveBeenCalledTimes(2);
      expect(queue.enqueueWebhookDeliver).toHaveBeenCalledTimes(2);
      expect(queue.enqueueWebhookDeliver).toHaveBeenCalledWith(
        { tenantId: TENANT, webhookDeliveryId: 'd-ep1' },
        expect.objectContaining({ attempts: 6 }),
      );
    });

    it('never dispatches to an endpoint not subscribed to the event (filtering happens in WebhookEndpointService)', async () => {
      endpointsService.findActiveSubscribers.mockResolvedValueOnce([]);
      await service.dispatchEvent(TENANT, 'payment.failed', {});
      expect(deliveries.save).not.toHaveBeenCalled();
      expect(queue.enqueueWebhookDeliver).not.toHaveBeenCalled();
    });

    it('one endpoint failing to enqueue does not block the others', async () => {
      endpointsService.findActiveSubscribers.mockResolvedValueOnce([{ id: 'ep1' }, { id: 'ep2' }]);
      deliveries.save.mockImplementation(async (d: any) => ({ ...d, id: `d-${d.webhook_endpoint.id}` }));
      queue.enqueueWebhookDeliver
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValueOnce({ id: 'job-2' });

      await expect(
        service.dispatchEvent(TENANT, 'appointment.created', {}),
      ).resolves.toBeUndefined();
      expect(queue.enqueueWebhookDeliver).toHaveBeenCalledTimes(2);
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
        webhook_endpoint: { id: 'ep1', is_active: true },
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
        webhook_endpoint: { id: 'ep1', is_active: false },
      });
      await expect(service.replay(TENANT, 'd1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('resets the delivery to PENDING, re-enqueues with a fresh job, and audits the replay', async () => {
      deliveries.findOne.mockResolvedValueOnce({
        id: 'd1',
        status: 'DEAD_LETTERED',
        event_type: 'appointment.created',
        attempt_count: 6,
        http_status: 500,
        last_error: 'boom',
        webhook_endpoint: { id: 'ep1', is_active: true },
      });
      deliveries.save.mockImplementationOnce(async (d: any) => d);

      await service.replay(TENANT, 'd1', { userId: 'u1', ip: '1.2.3.4' });

      const saved = deliveries.save.mock.calls[0][0];
      expect(saved.status).toBe('PENDING');
      expect(saved.attempt_count).toBe(0);
      expect(saved.http_status).toBeUndefined();
      expect(queue.retryWebhookDeliver).toHaveBeenCalledWith(
        { tenantId: TENANT, webhookDeliveryId: 'd1' },
        expect.objectContaining({ attempts: 6 }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        WEBHOOK_AUDIT_ACTION.REPLAY,
        TENANT,
        'u1',
        'WebhookDelivery',
        'd1',
        '1.2.3.4',
        expect.objectContaining({ eventType: 'appointment.created' }),
      );
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

    it('markDeadLettered sets DEAD_LETTERED (called by the processor once retries are exhausted)', async () => {
      await service.markDeadLettered('d1', 'exhausted');
      expect(deliveries.update).toHaveBeenCalledWith(
        { id: 'd1' },
        expect.objectContaining({ status: 'DEAD_LETTERED', last_error: 'exhausted' }),
      );
    });
  });
});
