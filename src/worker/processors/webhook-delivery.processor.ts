import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { scrubFailureReason } from '../../common/utils/log-scrubber.util';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { WebhookDeliverJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { QueueService } from '../../queue/queue.service';
import { WebhookEndpointService } from '../../modules/platform/webhook-endpoint.service';
import { WebhookDeliveryService } from '../../modules/platform/webhook-delivery.service';
import {
  WEBHOOK_HEADER,
  WEBHOOK_PAYLOAD_MAX_BYTES,
  computeWebhookSignature,
  computeWebhookSignatureV2,
} from '../../modules/platform/webhook.constants';
import { deliverWebhookRequest } from '../../modules/platform/webhook-http-client';

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
 * RETRY CLASSIFICATION (see webhook-retry-policy.ts for the tested pure
 * function): HTTP 408/425/429/5xx, timeouts, and network errors are
 * TRANSIENT — this method throws, which is what makes BullMQ's
 * attempts/backoff retry the job (same "throw = retry" convention as
 * CampaignDispatchService's TransientDispatchError). Any other 4xx, a 3xx
 * (redirects are never followed — see webhook-http-client.ts), or a blocked
 * SSRF target is PERMANENT — the row is marked FAILED and this method
 * returns normally (no throw), so BullMQ marks the job complete and never
 * retries it. Delivery is AT-LEAST-ONCE, not exactly-once: a transient retry
 * can in rare races re-send an event the receiver already accepted — the
 * receiver is expected to dedupe on the stable `X-Webhook-Id` header.
 * Ordering across events/deliveries is not guaranteed.
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
    private readonly authz: WorkerAuthorizationService,
    config: ConfigService,
  ) {
    super();
    this.timeoutMs =
      config.get<number>('WEBHOOK_DELIVERY_TIMEOUT_MS', 10_000) ?? 10_000;
  }

  async process(job: Job<WebhookDeliverJob>): Promise<void> {
    const data = job.data;
    validateJobPayload(job.name, data);
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] delivery=${data.webhookDeliveryId} tenant=${data.tenantId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
      this.deliver(data.webhookDeliveryId, job.attemptsMade + 1),
    );
  }

  private async deliver(
    deliveryId: string,
    attemptNumber: number,
  ): Promise<void> {
    const delivery = await this.deliveryService.loadForProcessing(deliveryId);
    if (!delivery) {
      this.logger.warn(
        `Webhook delivery ${deliveryId} no longer exists — skipping`,
      );
      return;
    }

    // Idempotency short-circuit: a stalled-job re-execution must never re-send
    // an event that already succeeded.
    if (delivery.status === 'SUCCEEDED') {
      this.logger.log(
        `Webhook delivery ${deliveryId} already succeeded — skipping duplicate processing`,
      );
      return;
    }

    if (!delivery.webhook_endpoint) {
      await this.deliveryService.markFailedPermanent(
        deliveryId,
        undefined,
        undefined,
        'Endpoint no longer exists',
      );
      return; // permanent — no throw, no retry
    }

    const active = await this.endpoints.findActiveWithSecret(
      delivery.webhook_endpoint.id,
    );
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

    // The destination is bound to the URL the event was dispatched to. If the
    // endpoint's URL has been edited since, a queued/retrying delivery must NOT
    // silently go to the new destination (it may sit across a trust boundary
    // the original authorisation never covered). It fails permanently and can be
    // replayed deliberately, which snapshots the then-current URL.
    if (
      delivery.webhook_endpoint_url_snapshot &&
      delivery.webhook_endpoint_url_snapshot !== endpoint.url
    ) {
      await this.deliveryService.markFailedPermanent(
        deliveryId,
        undefined,
        undefined,
        'endpoint_url_changed: the endpoint URL was edited after this event was queued — replay it to deliver to the new URL',
      );
      return; // permanent — no throw, no retry
    }

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

    // `delivery.event_type` / `delivery.payload` are the IMMUTABLE original —
    // captured once at dispatch (or, for a replay, copied byte-for-byte from
    // the delivery it replayed) and never rebuilt from live database state
    // here. `timestampSeconds` is the one deliberate exception: it is the
    // SIGNING timestamp, regenerated fresh on every attempt so the receiver's
    // own replay-protection window doesn't reject a request that was merely
    // delayed by backoff — it is not "when the event happened" (that, where
    // relevant, is a field inside the immutable payload itself, e.g. `startAt`).
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = computeWebhookSignature(
      secret,
      timestampSeconds,
      bodyString,
    );

    const signatureV2 = computeWebhookSignatureV2(
      secret,
      timestampSeconds,
      delivery.id,
      delivery.event_type,
      bodyString,
    );
    const originalId = await this.deliveryService.rootDeliveryId(delivery);

    const result = await deliverWebhookRequest(
      endpoint.url,
      bodyString,
      {
        [WEBHOOK_HEADER.ID]: delivery.id,
        [WEBHOOK_HEADER.ORIGINAL_ID]: originalId,
        [WEBHOOK_HEADER.EVENT]: delivery.event_type,
        [WEBHOOK_HEADER.TIMESTAMP]: String(timestampSeconds),
        [WEBHOOK_HEADER.SIGNATURE]: signature,
        [WEBHOOK_HEADER.SIGNATURE_V2]: signatureV2,
      },
      this.timeoutMs,
    );

    if (result.ok) {
      await this.deliveryService.markSucceeded(
        deliveryId,
        result.httpStatus,
        result.bodyPreview,
      );
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

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    const data = job?.data as WebhookDeliverJob | undefined;
    this.logger.error(
      `webhooks.deliver job=${job?.id} delivery=${data?.webhookDeliveryId} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );

    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
    // A job that fails via `UnrecoverableError` (payload validation, worker
    // authorization) never retries — BullMQ's `shouldRetryJob` skips it
    // unconditionally, so `attemptsMade` never climbs to `opts.attempts` and
    // the `exhausted` check above alone would never become true for it. Left
    // as `exhausted`-only, such a job would fail once, log one error line,
    // and vanish with no DLQ park and no `DEAD_LETTERED` row — silently,
    // since nothing else ever re-drives it (§18 test-plan gap, found while
    // writing the "payload validation → DLQ, no retry" test). Treat an
    // UnrecoverableError as terminal on its own, same as an exhausted retry
    // budget, so it gets the same DLQ/operator visibility.
    const permanent = err instanceof UnrecoverableError;
    if ((!exhausted && !permanent) || !data) return;

    // Beyond this point retries are done. Mark the row terminal so the
    // tenant-facing delivery history + replay endpoint (DB-driven, never a
    // raw BullMQ jobId lookup) can see and act on it. `markDeadLettered`
    // itself is a conditional update (only rows not already DEAD_LETTERED) —
    // this guarantees the transition happens exactly once even if BullMQ ever
    // emitted 'failed' more than once for the same exhausted job.
    const transitioned = await this.deliveryService
      .markDeadLettered(
        data.webhookDeliveryId,
        err?.message ?? 'Exhausted retries',
      )
      .catch((e) => {
        this.logger.error(
          `Failed to mark delivery dead-lettered: ${(e as Error)?.message}`,
        );
        return false;
      });
    if (!transitioned) return;

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
        failedReason: scrubFailureReason(err),
        attemptsMade: job?.attemptsMade ?? 0,
        diedAt: new Date().toISOString(),
      })
      .catch((e) =>
        this.logger.error(`DLQ enqueue failed: ${(e as Error)?.message}`),
      );
  }
}
