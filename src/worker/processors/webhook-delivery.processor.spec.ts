import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';

import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WebhookDeliveryService } from '../../modules/platform/webhook-delivery.service';
import { WebhookEndpointService } from '../../modules/platform/webhook-endpoint.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { WebhookDeliverJob } from '../../queue/job-data.interface';
import { createMockConfigService } from '../../../test/utils/mock-factories';
import { deliverWebhookRequest } from '../../modules/platform/webhook-http-client';

jest.mock('../../modules/platform/webhook-http-client');

const mockDeliverWebhookRequest = deliverWebhookRequest as jest.MockedFunction<
  typeof deliverWebhookRequest
>;

function makeJob(
  data: WebhookDeliverJob,
  attemptsMade = 0,
  opts: Record<string, unknown> = { attempts: 6 },
) {
  return {
    id: 'job-1',
    name: 'webhooks.deliver',
    data,
    attemptsMade,
    opts,
  } as unknown as Job<WebhookDeliverJob>;
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

  const baseDelivery = {
    id: 'd1',
    event_type: 'appointment.created',
    payload: { appointmentId: 'a1' },
    status: 'PENDING',
    webhook_endpoint: { id: 'ep1' },
  };

  beforeEach(async () => {
    mockDeliverWebhookRequest.mockReset();
    deliveryService = {
      loadForProcessing: jest.fn().mockResolvedValue(baseDelivery),
      markDelivering: jest.fn().mockResolvedValue(undefined),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markFailedPermanent: jest.fn().mockResolvedValue(undefined),
      recordTransientFailure: jest.fn().mockResolvedValue(undefined),
      markDeadLettered: jest.fn().mockResolvedValue(true),
    };
    endpoints = {
      findActiveWithSecret: jest.fn().mockResolvedValue({
        endpoint: {
          id: 'ep1',
          url: 'https://example.com/hook',
          is_active: true,
        },
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
        {
          provide: WorkerAuthorizationService,
          useValue: {
            assertAuthorized: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: createMockConfigService({
            WEBHOOK_DELIVERY_TIMEOUT_MS: 200,
          }),
        },
      ],
    }).compile();
    processor = moduleRef.get(WebhookDeliveryProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks SUCCEEDED and never throws on a 2xx response', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: true,
      transient: false,
      httpStatus: 200,
      bodyPreview: 'ok',
    });

    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).resolves.toBeUndefined();
    expect(deliveryService.markSucceeded).toHaveBeenCalledWith('d1', 200, 'ok');
    expect(deliveryService.markFailedPermanent).not.toHaveBeenCalled();
    expect(deliveryService.recordTransientFailure).not.toHaveBeenCalled();
  });

  it('signs the request and sends the documented headers to the correct URL/body/timeout', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: true,
      transient: false,
      httpStatus: 200,
      bodyPreview: '',
    });

    await processor.process(
      makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }),
    );

    expect(mockDeliverWebhookRequest).toHaveBeenCalledTimes(1);
    const [url, body, headers, timeoutMs] =
      mockDeliverWebhookRequest.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(JSON.parse(body)).toEqual({ appointmentId: 'a1' });
    expect(headers['X-Webhook-Id']).toBe('d1');
    expect(headers['X-Webhook-Event']).toBe('appointment.created');
    expect(headers['X-Webhook-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(timeoutMs).toBe(200);
  });

  it('marks FAILED (permanent) and does NOT throw on a non-retryable 4xx', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: false,
      transient: false,
      httpStatus: 400,
      bodyPreview: 'bad request',
      error: 'HTTP 400',
    });

    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).resolves.toBeUndefined();
    expect(deliveryService.markFailedPermanent).toHaveBeenCalledWith(
      'd1',
      400,
      'bad request',
      'HTTP 400',
    );
    expect(deliveryService.markSucceeded).not.toHaveBeenCalled();
  });

  it('records progress and THROWS (triggering a BullMQ retry) on a 500', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: false,
      transient: true,
      httpStatus: 500,
      bodyPreview: 'server error',
      error: 'HTTP 500',
    });

    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).rejects.toThrow();
    expect(deliveryService.recordTransientFailure).toHaveBeenCalledWith(
      'd1',
      500,
      'server error',
      'HTTP 500',
    );
    expect(deliveryService.markFailedPermanent).not.toHaveBeenCalled();
  });

  it('treats HTTP 429 as transient (throws for retry)', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: false,
      transient: true,
      httpStatus: 429,
      bodyPreview: 'slow down',
      error: 'HTTP 429',
    });

    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).rejects.toThrow();
    expect(deliveryService.recordTransientFailure).toHaveBeenCalledWith(
      'd1',
      429,
      'slow down',
      'HTTP 429',
    );
  });

  it('classifies a timeout as transient and throws', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: false,
      transient: true,
      error: 'Delivery timed out',
    });

    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).rejects.toThrow('Delivery timed out');
    expect(deliveryService.recordTransientFailure).toHaveBeenCalledWith(
      'd1',
      undefined,
      undefined,
      'Delivery timed out',
    );
  });

  it('classifies a network error as transient and throws', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: false,
      transient: true,
      error: 'ECONNREFUSED',
    });

    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('classifies an SSRF-blocked target as permanent (does NOT throw)', async () => {
    mockDeliverWebhookRequest.mockResolvedValueOnce({
      ok: false,
      transient: false,
      error: 'Delivery blocked: target address is not allowed',
    });

    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).resolves.toBeUndefined();
    expect(deliveryService.markFailedPermanent).toHaveBeenCalledWith(
      'd1',
      undefined,
      undefined,
      'Delivery blocked: target address is not allowed',
    );
  });

  it('is idempotent: skips (and never calls the http client) when the delivery already SUCCEEDED', async () => {
    deliveryService.loadForProcessing.mockResolvedValueOnce({
      ...baseDelivery,
      status: 'SUCCEEDED',
    });

    await processor.process(
      makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }),
    );

    expect(mockDeliverWebhookRequest).not.toHaveBeenCalled();
    expect(deliveryService.markSucceeded).not.toHaveBeenCalled();
  });

  it('marks FAILED (permanent, no throw) when the endpoint is disabled/gone', async () => {
    endpoints.findActiveWithSecret.mockResolvedValueOnce(null);
    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).resolves.toBeUndefined();
    expect(deliveryService.markFailedPermanent).toHaveBeenCalledWith(
      'd1',
      undefined,
      undefined,
      'Endpoint is disabled or no longer exists',
    );
  });

  it('marks FAILED (permanent, no throw) when the delivery has no endpoint relation at all (hard-deleted)', async () => {
    deliveryService.loadForProcessing.mockResolvedValueOnce({
      ...baseDelivery,
      webhook_endpoint: undefined,
    });
    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' })),
    ).resolves.toBeUndefined();
    expect(deliveryService.markFailedPermanent).toHaveBeenCalledWith(
      'd1',
      undefined,
      undefined,
      'Endpoint no longer exists',
    );
    expect(endpoints.findActiveWithSecret).not.toHaveBeenCalled();
  });

  it('skips gracefully when the delivery row no longer exists', async () => {
    deliveryService.loadForProcessing.mockResolvedValueOnce(null);
    await expect(
      processor.process(makeJob({ tenantId: 't1', webhookDeliveryId: 'gone' })),
    ).resolves.toBeUndefined();
    expect(mockDeliverWebhookRequest).not.toHaveBeenCalled();
  });

  describe('@OnWorkerEvent(failed) — DLQ on exhaustion', () => {
    it('marks DEAD_LETTERED and parks a DLQ job once attempts are exhausted', async () => {
      const job = makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }, 6, {
        attempts: 6,
      });
      await processor.onFailed(job, new Error('boom'));

      expect(deliveryService.markDeadLettered).toHaveBeenCalledWith(
        'd1',
        'boom',
      );
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
      const job = makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }, 2, {
        attempts: 6,
      });
      await processor.onFailed(job, new Error('boom'));

      expect(deliveryService.markDeadLettered).not.toHaveBeenCalled();
      expect(queue.enqueueWebhookDlq).not.toHaveBeenCalled();
    });

    it('does not double-park a DLQ job when the delivery was already DEAD_LETTERED (exactly-once transition)', async () => {
      deliveryService.markDeadLettered.mockResolvedValueOnce(false);
      const job = makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }, 6, {
        attempts: 6,
      });
      await processor.onFailed(job, new Error('boom'));

      expect(deliveryService.markDeadLettered).toHaveBeenCalledWith(
        'd1',
        'boom',
      );
      expect(queue.enqueueWebhookDlq).not.toHaveBeenCalled();
    });

    it('DLQs an UnrecoverableError on the FIRST attempt, even though attemptsMade never reaches opts.attempts (§18 test-plan #20 — a real gap found and fixed this pass)', async () => {
      // Before this fix: `exhausted` alone gated the DLQ park, but BullMQ's
      // `shouldRetryJob` skips retrying an UnrecoverableError unconditionally
      // (see job-payload-validator.ts / bullmq's job.js), so `attemptsMade`
      // stays at 1 forever — `1 >= 6` is false, and a malformed-payload
      // rejection would silently vanish with no DLQ park at all.
      const job = makeJob({ tenantId: 't1', webhookDeliveryId: 'd1' }, 1, {
        attempts: 6,
      });
      await processor.onFailed(
        job,
        new UnrecoverableError('payload missing required field'),
      );

      expect(deliveryService.markDeadLettered).toHaveBeenCalledWith(
        'd1',
        'payload missing required field',
      );
      expect(queue.enqueueWebhookDlq).toHaveBeenCalledWith(
        expect.objectContaining({ webhookDeliveryId: 'd1', attemptsMade: 1 }),
      );
    });

    it('the process() → validateJobPayload → UnrecoverableError → onFailed chain lands a malformed payload in the DLQ without ever calling deliverWebhookRequest', async () => {
      const malformed = { tenantId: 't1' } as unknown as WebhookDeliverJob; // missing webhookDeliveryId
      const job = makeJob(malformed, 0, { attempts: 6 });

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      expect(mockDeliverWebhookRequest).not.toHaveBeenCalled();

      // Simulate BullMQ's own reaction to that thrown UnrecoverableError:
      // attemptsMade advances by exactly 1 (bullmq job.js moveToFailed), and
      // the 'failed' event fires with the SAME error instance.
      const failedJob = makeJob(malformed, 1, { attempts: 6 });
      await processor.onFailed(
        failedJob,
        new UnrecoverableError(
          'Job "webhooks.deliver" payload missing required string field "webhookDeliveryId"',
        ),
      );
      expect(queue.enqueueWebhookDlq).toHaveBeenCalledTimes(1);
    });
  });
});
