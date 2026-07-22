import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { WebhookDeliverJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { WebhookEndpointService } from '../../modules/platform/webhook-endpoint.service';
import { WebhookDeliveryService } from '../../modules/platform/webhook-delivery.service';
import {
  WEBHOOK_HEADER,
  WEBHOOK_PAYLOAD_MAX_BYTES,
  computeWebhookSignature,
} from '../../modules/platform/webhook.constants';

interface DeliveryAttemptResult {
  ok: boolean;
  transient: boolean;
  httpStatus?: number;
  bodyPreview?: string;
  error?: string;
}

/**
 * Consumes the `webhooks.deliver` queue — outbound HTTP delivery of a signed
 * webhook payload to a tenant-configured endpoint.
 *
 * Reuses WebhookDeliveryService/WebhookEndpointService rather than touching
 * entities directly: this processor is transport, not logic (same pattern as
 * WhatsappWebhookProcessor reusing WhatsappWebhookService).
 *
 * IDEMPOTENCY: the enqueue-side deterministic jobId (`webhook-delivery-<id>`)
 * collapses duplicate enqueues onto one job; here, a `status === SUCCEEDED`
 * short-circuit additionally guards against a stalled-job re-execution
 * re-sending an already-delivered event. The `X-Webhook-Id` header (the
 * delivery row's own id) lets the RECEIVING tenant system dedupe on their
 * side too, per the documented delivery contract.
 *
 * RETRY CLASSIFICATION: HTTP 429/5xx, timeouts, and network errors are
 * TRANSIENT — this method throws, which is what makes BullMQ's
 * attempts/backoff retry the job (same "throw = retry" convention as
 * CampaignDispatchService's TransientDispatchError). Any other 4xx is
 * PERMANENT — the row is marked FAILED and this method returns normally
 * (no throw), so BullMQ marks the job complete and it is never retried.
 */
@Processor(QUEUE.WEBHOOKS_DELIVER, { concurrency: workerConcurrency() })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger('WebhookDeliveryProcessor');
  private readonly timeoutMs: number;

  constructor(
    private readonly deliveryService: WebhookDeliveryService,
    private readonly endpoints: WebhookEndpointService,
    private readonly ctx: TenantContextService,
    private readonly queue: QueueService,
    config: ConfigService,
  ) {
    super();
    this.timeoutMs = config.get<number>('WEBHOOK_DELIVERY_TIMEOUT_MS', 10_000) ?? 10_000;
  }

  async process(job: Job<WebhookDeliverJob>): Promise<void> {
    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] delivery=${data.webhookDeliveryId} tenant=${data.tenantId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, data, () =>
      this.deliver(data.webhookDeliveryId, job.attemptsMade + 1),
    );
  }

  private async deliver(deliveryId: string, attemptNumber: number): Promise<void> {
    const delivery = await this.deliveryService.loadForProcessing(deliveryId);
    if (!delivery) {
      this.logger.warn(`Webhook delivery ${deliveryId} no longer exists — skipping`);
      return;
    }

    // Idempotency short-circuit: a stalled-job re-execution must never re-send
    // an event that already succeeded.
    if (delivery.status === 'SUCCEEDED') {
      this.logger.log(`Webhook delivery ${deliveryId} already succeeded — skipping duplicate processing`);
      return;
    }

    const active = await this.endpoints.findActiveWithSecret(delivery.webhook_endpoint.id);
    if (!active) {
      await this.deliveryService.markFailedPermanent(
        deliveryId,
        undefined,
        undefined,
        'Endpoint is disabled or no longer exists',
      );
      return; // permanent — no throw, no retry
    }
    const { endpoint, secret } = active;

    const bodyString = JSON.stringify(delivery.payload);
    if (Buffer.byteLength(bodyString, 'utf8') > WEBHOOK_PAYLOAD_MAX_BYTES) {
      await this.deliveryService.markFailedPermanent(
        deliveryId,
        undefined,
        undefined,
        'Payload exceeds the maximum allowed size',
      );
      return; // permanent
    }

    await this.deliveryService.markDelivering(deliveryId, attemptNumber);

    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = computeWebhookSignature(secret, timestampSeconds, bodyString);

    const result = await this.attemptDelivery(endpoint.url, bodyString, {
      [WEBHOOK_HEADER.ID]: delivery.id,
      [WEBHOOK_HEADER.EVENT]: delivery.event_type,
      [WEBHOOK_HEADER.TIMESTAMP]: String(timestampSeconds),
      [WEBHOOK_HEADER.SIGNATURE]: signature,
    });

    if (result.ok) {
      await this.deliveryService.markSucceeded(deliveryId, result.httpStatus, result.bodyPreview);
      return;
    }

    if (!result.transient) {
      await this.deliveryService.markFailedPermanent(
        deliveryId,
        result.httpStatus,
        result.bodyPreview,
        result.error ?? 'Permanent delivery failure',
      );
      return; // permanent — no throw, no retry
    }

    await this.deliveryService.recordTransientFailure(
      deliveryId,
      result.httpStatus,
      result.bodyPreview,
      result.error ?? 'Transient delivery failure',
    );
    // Transient — throw so BullMQ's attempts/backoff retries this job.
    throw new Error(result.error ?? 'Transient webhook delivery failure');
  }

  /** Native fetch + AbortController timeout — never throws; returns a result union. */
  private async attemptDelivery(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<DeliveryAttemptResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      const bodyPreview = text.slice(0, 500);
      if (res.ok) {
        return { ok: true, transient: false, httpStatus: res.status, bodyPreview };
      }
      const transient = res.status === 429 || res.status >= 500;
      return {
        ok: false,
        transient,
        httpStatus: res.status,
        bodyPreview,
        error: `HTTP ${res.status}`,
      };
    } catch (err) {
      const timedOut = (err as Error)?.name === 'AbortError';
      return {
        ok: false,
        transient: true,
        error: timedOut ? 'Delivery timed out' : ((err as Error)?.message ?? 'network error'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    const data = job?.data as WebhookDeliverJob | undefined;
    this.logger.error(
      `webhooks.deliver job=${job?.id} delivery=${data?.webhookDeliveryId} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );

    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
    if (!exhausted || !data) return;

    // Beyond this point retries are done. Mark the row terminal so the
    // tenant-facing delivery history + replay endpoint (DB-driven, never a
    // raw BullMQ jobId lookup) can see and act on it.
    await this.deliveryService
      .markDeadLettered(data.webhookDeliveryId, err?.message ?? 'Exhausted retries')
      .catch((e) => this.logger.error(`Failed to mark delivery dead-lettered: ${(e as Error)?.message}`));

    // Platform ops-depth visibility only — mirrors every other domain's DLQ
    // park (WhatsappDlqService et al.); never read by the tenant-facing API.
    await this.queue
      .enqueueWebhookDlq({
        tenantId: data.tenantId,
        correlationId: data.correlationId,
        webhookDeliveryId: data.webhookDeliveryId,
        sourceQueue: QUEUE.WEBHOOKS_DELIVER,
        sourceJobName: job.name,
        originalJobId: String(job?.id ?? ''),
        failedReason: err?.message ?? 'unknown',
        attemptsMade: job?.attemptsMade ?? 0,
        diedAt: new Date().toISOString(),
      })
      .catch((e) => this.logger.error(`DLQ enqueue failed: ${(e as Error)?.message}`));
  }
}
