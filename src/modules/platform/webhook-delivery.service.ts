import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { WebhookDelivery } from '../../entities/System/WebhookDelivery';
import { WebhookEndpoint } from '../../entities/System/WebhookEndpoint';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { AppError, ErrorCode } from '../../common/errors';
import { QueueService } from '../../queue/queue.service';
import { QUEUE, JOB } from '../../queue/queue.constants';

import { WebhookEndpointService } from './webhook-endpoint.service';
import { QueryWebhookDeliveriesDto } from './dto/query-webhook-deliveries.dto';
import { WEBHOOK_DELIVERY_STATUS } from './webhook.constants';
import { WebhookAuditService, WEBHOOK_AUDIT_ACTION } from './webhook-audit.service';

export interface WebhookDeliveryActor {
  userId?: string;
  ip?: string;
}

/**
 * Outbound webhook delivery orchestration (Phase 2 — Integration platform).
 *
 * `dispatchEvent` is the fan-out entry point called by WebhookEventListener:
 * one `webhook_deliveries` row + one queued job per subscribed ACTIVE
 * endpoint. Enqueue failures for one endpoint are logged and never block the
 * others (same isolation principle as NotificationEventListener.dispatch).
 *
 * `replay` is TENANT-SCOPED and DB-row-driven (not a raw BullMQ jobId lookup)
 * — unlike the platform-admin-only WhatsApp DLQ, a clinic owner must only
 * ever be able to see/replay their OWN tenant's dead-lettered deliveries.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger('WebhookDeliveryService');

  constructor(
    @InjectRepository(WebhookDelivery)
    private readonly deliveries: Repository<WebhookDelivery>,
    private readonly endpointsService: WebhookEndpointService,
    private readonly queue: QueueService,
    private readonly audit: WebhookAuditService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Fan out one domain event to every active, subscribed endpoint for the
   * tenant. The delivery row and the intent to enqueue it are written in ONE
   * transaction via the transactional outbox (`OutboxJob` — see its docstring
   * and `OutboxRelayService`) — Phase 0 hardening (see
   * docs/CACHING_QUEUES_AUDIT.md §0.5 item 4 / original audit H6). Previously
   * the enqueue happened after the row's own commit with only a try/catch and
   * no recovery sweep: an enqueue failure left the row PENDING forever with
   * nothing to ever re-enqueue it.
   */
  async dispatchEvent(
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let subscribers: WebhookEndpoint[];
    try {
      subscribers = await this.endpointsService.findActiveSubscribers(tenantId, eventType);
    } catch (err) {
      this.logger.error(
        `Failed to load webhook subscribers for ${eventType} (tenant ${tenantId}): ${(err as Error)?.message}`,
      );
      return;
    }

    for (const endpoint of subscribers) {
      try {
        await this.dataSource.transaction(async (mgr) => {
          const delivery = await mgr.save(
            mgr.create(WebhookDelivery, {
              tenant: { id: tenantId } as Tenant,
              webhook_endpoint: { id: endpoint.id } as WebhookEndpoint,
              // Immutable snapshot of the URL as of THIS dispatch instant — never
              // re-derived from the (possibly since-edited) endpoint later.
              webhook_endpoint_url_snapshot: endpoint.url,
              event_type: eventType,
              payload,
              status: WEBHOOK_DELIVERY_STATUS.PENDING,
            }),
          );
          await mgr.save(
            mgr.create(OutboxJob, {
              queue: QUEUE.WEBHOOKS_DELIVER,
              job_name: JOB.WEBHOOKS_DELIVER,
              dedupe_key: `webhook-delivery-${delivery.id}`,
              payload: { tenantId, webhookDeliveryId: delivery.id },
              opts: this.deliverJobOptions(),
            }),
          );
        });
      } catch (err) {
        // One bad endpoint must never suppress delivery to the others. A
        // failure here means the ROW WAS NEVER COMMITTED (the transaction
        // rolled back) — nothing is silently half-done.
        this.logger.error(
          `Failed to dispatch webhook delivery for endpoint ${endpoint.id} (${eventType}): ${(err as Error)?.message}`,
        );
      }
    }
  }

  async list(tenantId: string, query: QueryWebhookDeliveriesDto) {
    const where: FindOptionsWhere<WebhookDelivery> = { tenant: { id: tenantId } };
    if (query.webhookEndpointId) where.webhook_endpoint = { id: query.webhookEndpointId };
    if (query.status) where.status = query.status;

    const [rows, total] = await this.deliveries.findAndCount({
      where,
      relations: { webhook_endpoint: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: rows.map((d) => this.toView(d)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async get(tenantId: string, id: string) {
    return this.toView(await this.findOneOrThrow(tenantId, id));
  }

  // ── Processor-facing methods (WebhookDeliveryProcessor — worker process) ──
  // Kept here rather than a raw @InjectRepository in the processor: this
  // service is exported from PlatformModule, the repository is not (same
  // "processor is transport, not logic" convention as WhatsappWebhookProcessor
  // reusing WhatsappWebhookService rather than touching entities directly).

  /** Loads a delivery (with its endpoint) for the processor. Not tenant-scoped — the job already carries a trusted delivery id. */
  async loadForProcessing(id: string): Promise<WebhookDelivery | null> {
    return this.deliveries.findOne({ where: { id }, relations: { webhook_endpoint: true } });
  }

  async markDelivering(id: string, attemptNumber: number): Promise<void> {
    await this.deliveries.update(
      { id },
      {
        status: WEBHOOK_DELIVERY_STATUS.DELIVERING,
        attempt_count: attemptNumber,
        last_attempted_at: new Date(),
      },
    );
  }

  async markSucceeded(id: string, httpStatus: number | undefined, responsePreview: string | undefined): Promise<void> {
    await this.deliveries.update(
      { id },
      {
        status: WEBHOOK_DELIVERY_STATUS.SUCCEEDED,
        http_status: httpStatus,
        response_preview: responsePreview,
        last_error: undefined,
      },
    );
  }

  /** Terminal, non-retryable outcome (permanent 4xx, disabled endpoint, oversized payload). */
  async markFailedPermanent(
    id: string,
    httpStatus: number | undefined,
    responsePreview: string | undefined,
    error: string,
  ): Promise<void> {
    await this.deliveries.update(
      { id },
      {
        status: WEBHOOK_DELIVERY_STATUS.FAILED,
        http_status: httpStatus,
        response_preview: responsePreview,
        last_error: error,
      },
    );
  }

  /** Progress checkpoint before the processor throws to trigger a BullMQ retry. */
  async recordTransientFailure(
    id: string,
    httpStatus: number | undefined,
    responsePreview: string | undefined,
    error: string,
  ): Promise<void> {
    await this.deliveries.update(
      { id },
      { http_status: httpStatus, response_preview: responsePreview, last_error: error },
    );
  }

  /**
   * Called by the processor's `@OnWorkerEvent('failed')` once retries are
   * exhausted. Conditional on the row NOT already being DEAD_LETTERED, so the
   * DEAD_LETTERED transition — and the DLQ park that follows it — happens
   * exactly once even if BullMQ were ever to emit 'failed' more than once for
   * the same exhausted job. Returns whether this call performed the
   * transition (the caller skips the DLQ enqueue when it did not).
   */
  async markDeadLettered(id: string, error: string): Promise<boolean> {
    const result = await this.deliveries.update(
      { id, status: Not(WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED) },
      { status: WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED, last_error: error },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * Manual replay from the dashboard — only for deliveries in a terminal
   * failure state. Creates a brand-new delivery row linked back to the
   * original via `replayed_from_id`, rather than resetting the original row
   * in place: the original's terminal outcome (FAILED/DEAD_LETTERED, its
   * final http_status/error/response_preview) is never lost. The event
   * type and payload are copied byte-for-byte from the original — a replay
   * NEVER rebuilds the payload from current/live database state.
   */
  async replay(tenantId: string, id: string, actor: WebhookDeliveryActor) {
    const original = await this.findOneOrThrow(tenantId, id);

    if (
      original.status !== WEBHOOK_DELIVERY_STATUS.FAILED &&
      original.status !== WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only failed or dead-lettered deliveries can be replayed (current status: ${original.status})`,
      });
    }
    if (!original.webhook_endpoint || !original.webhook_endpoint.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The webhook endpoint is disabled or no longer exists — activate it before replaying',
      });
    }

    const replay = await this.deliveries.save(
      this.deliveries.create({
        tenant: { id: tenantId } as Tenant,
        webhook_endpoint: original.webhook_endpoint,
        webhook_endpoint_url_snapshot: original.webhook_endpoint.url,
        event_type: original.event_type,
        payload: original.payload,
        status: WEBHOOK_DELIVERY_STATUS.PENDING,
        replayed_from_id: original.id,
      }),
    );

    await this.queue.retryWebhookDeliver(
      { tenantId, webhookDeliveryId: replay.id },
      this.deliverJobOptions(),
    );
    await this.audit.record(
      WEBHOOK_AUDIT_ACTION.REPLAY,
      tenantId,
      actor.userId,
      'WebhookDelivery',
      replay.id,
      actor.ip,
      {
        eventType: replay.event_type,
        webhookEndpointId: original.webhook_endpoint.id,
        replayedFromId: original.id,
      },
    );
    return this.toView(replay);
  }

  private async findOneOrThrow(tenantId: string, id: string): Promise<WebhookDelivery> {
    const delivery = await this.deliveries.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { webhook_endpoint: true },
    });
    if (!delivery) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Webhook delivery not found' });
    }
    return delivery;
  }

  private deliverJobOptions() {
    return {
      attempts: this.config.get<number>('WEBHOOK_DELIVERY_MAX_ATTEMPTS', 6) ?? 6,
      backoff: {
        type: 'exponential' as const,
        delay: this.config.get<number>('WEBHOOK_DELIVERY_BACKOFF_MS', 5000) ?? 5000,
      },
    };
  }

  /**
   * Response projection — never includes the endpoint's secret. Falls back to
   * `webhook_endpoint_url_snapshot` (never null) whenever the live relation is
   * gone, so history stays readable even after an endpoint is deleted.
   */
  private toView(delivery: WebhookDelivery) {
    return {
      id: delivery.id,
      eventType: delivery.event_type,
      webhookEndpointId: delivery.webhook_endpoint?.id ?? null,
      webhookEndpointName: delivery.webhook_endpoint?.name ?? null,
      webhookEndpointUrl: delivery.webhook_endpoint?.url ?? delivery.webhook_endpoint_url_snapshot,
      status: delivery.status,
      httpStatus: delivery.http_status ?? null,
      attemptCount: delivery.attempt_count,
      responsePreview: delivery.response_preview ?? null,
      lastError: delivery.last_error ?? null,
      lastAttemptedAt: delivery.last_attempted_at ?? null,
      replayedFromId: delivery.replayed_from_id ?? null,
      requestId: delivery.id,
      createdAt: delivery.created_at,
    };
  }
}
