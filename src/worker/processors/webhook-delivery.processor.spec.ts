import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';

import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WebhookDeliveryService } from '../../modules/platform/webhook-delivery.service';
import { WebhookEndpointService } from '../../modules/platform/webhook-endpoint.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { WebhookDeliverJob } from '../../queue/job-data.interface';
import { createMockConfigService } from '../../../test/utils/mock-factories';

function makeJob(data: WebhookDeliverJob, attemptsMade = 0, opts: Record<string, unknown> = { attempts: 6 }) {
  return { id: 'job-1', name: 'webhooks.deliver', data, attemptsMade, opts } as unknown as Job<WebhookDeliverJob>;
}

describe('WebhookDeliveryProcessor', () => {
  let processor: WebhookDeliveryProcessor;
  let deliveryService: {
    loadForProcessing: jest.Mock;
    markDelivering: jest.Mock;
    markSucceeded: jest.Mock;
    markFailedPermanent: jest.Mock;
    recordTransientFailure: jest.Mock;
    markDeadLettered: jest.Mock;
  };
  let endpoints: { findActiveWithSecret: jest.Mock };
  let queue: { enqueueWebhookDlq: jest.Mock };
  let ctx: TenantContextService;

  const baseDelivery = {
    id: 'd1',
    event_type: 'appointment.created',
    payload: { appointmentId: 'a1' },
    status: 'PENDING',
    webhook_endpoint: { id: 'ep1' },
  };

  beforeEach(async () => {
    deliveryService = {
      loadForProcessing: jest.fn().mockResolvedValue(baseDelivery),
      markDelivering: jest.fn().mockResolvedValue(undefined),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markFailedPermanent: jest.fn().mockResolvedValue(undefined),
      recordTransientFailure: jest.fn().mockResolvedValue(undefined),
      markDeadLettered: jest.fn().mockResolvedValue(undefined),
    };
    endpoints = {
      findActiveWithSecret: jest.fn().mockResolvedValue({
        endpoint: { id: 'ep1', url: 'https://example.com/hook', is_active: true },
        secret: 'whsec_test',
      }),
    };
    queue = { enqueueWebhookDlq: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryProcessor,
        { provide: WebhookDeliveryService, useValue: deliveryService },
        { provide: WebhookEndpointService, useValue: endpoints },
        TenantContextService,
        { provide: QueueService, useValue: queue },
        { provide: ConfigService, useValue: createMockConfigService({ WEBHOOK_DELIVERY_TIMEOUT_MS: 200 }) },
      ],
    }).compile();
    processor = moduleRef.get(WebhookDeliveryProcessor);
    ctx = moduleRef.get(TenantContextService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks SUCCEEDED and never throws on a 2xx response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'ok',
    } as Response);

    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }))).resolves.toBeUndefined();
    expect(deliveryService.markSucceeded).toHaveBeenCalledWith('d1', 200, 'ok');
    expect(deliveryService.markFailedPermanent).not.toHaveBeenCalled();
    expect(deliveryService.recordTransientFailure).not.toHaveBeenCalled();
  });

  it('signs the request and sends the documented headers', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' } as Response);

    await processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }));

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Webhook-Id']).toBe('d1');
    expect(headers['X-Webhook-Event']).toBe('appointment.created');
    expect(headers['X-Webhook-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body as string)).toEqual({ appointmentId: 'a1' });
  });

  it('marks FAILED (permanent) and does NOT throw on a non-retryable 4xx', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    } as Response);

    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }))).resolves.toBeUndefined();
    expect(deliveryService.markFailedPermanent).toHaveBeenCalledWith('d1', 400, 'bad request', 'HTTP 400');
    expect(deliveryService.markSucceeded).not.toHaveBeenCalled();
  });

  it('records progress and THROWS (triggering a BullMQ retry) on a 500', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'server error',
    } as Response);

    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }))).rejects.toThrow();
    expect(deliveryService.recordTransientFailure).toHaveBeenCalledWith('d1', 500, 'server error', 'HTTP 500');
    expect(deliveryService.markFailedPermanent).not.toHaveBeenCalled();
  });

  it('treats HTTP 429 as transient (throws for retry)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'slow down',
    } as Response);

    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }))).rejects.toThrow();
    expect(deliveryService.recordTransientFailure).toHaveBeenCalledWith('d1', 429, 'slow down', 'HTTP 429');
  });

  it('classifies a timeout as transient and throws', async () => {
    jest.spyOn(global, 'fetch').mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }))).rejects.toThrow(
      'Delivery timed out',
    );
    expect(deliveryService.recordTransientFailure).toHaveBeenCalledWith(
      'd1',
      undefined,
      undefined,
      'Delivery timed out',
    );
  }, 10_000);

  it('classifies a network error as transient and throws', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }))).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('is idempotent: skips (and never calls fetch) when the delivery already SUCCEEDED', async () => {
    deliveryService.loadForProcessing.mockResolvedValueOnce({ ...baseDelivery, status: 'SUCCEEDED' });
    const fetchSpy = jest.spyOn(global, 'fetch');

    await processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deliveryService.markSucceeded).not.toHaveBeenCalled();
  });

  it('marks FAILED (permanent, no throw) when the endpoint is disabled/gone', async () => {
    endpoints.findActiveWithSecret.mockResolvedValueOnce(null);
    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }))).resolves.toBeUndefined();
    expect(deliveryService.markFailedPermanent).toHaveBeenCalledWith(
      'd1',
      undefined,
      undefined,
      'Endpoint is disabled or no longer exists',
    );
  });

  it('skips gracefully when the delivery row no longer exists', async () => {
    deliveryService.loadForProcessing.mockResolvedValueOnce(null);
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'gone' }))).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('@OnWorkerEvent(failed) — DLQ on exhaustion', () => {
    it('marks DEAD_LETTERED and parks a DLQ job once attempts are exhausted', async () => {
      const job = makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }, 6, { attempts: 6 });
      await processor.onFailed(job, new Error('boom'));

      expect(deliveryService.markDeadLettered).toHaveBeenCalledWith('d1', 'boom');
      expect(queue.enqueueWebhookDlq).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          webhookDeliveryId: 'd1',
          failedReason: 'boom',
          attemptsMade: 6,
        }),
      );
    });

    it('does nothing while attempts remain (not yet exhausted)', async () => {
      const job = makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }, 2, { attempts: 6 });
      await processor.onFailed(job, new Error('boom'));

      expect(deliveryService.markDeadLettered).not.toHaveBeenCalled();
      expect(queue.enqueueWebhookDlq).not.toHaveBeenCalled();
    });
  });
});
