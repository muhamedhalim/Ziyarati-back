import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { WebhookDelivery } from '../../entities/System/WebhookDelivery';
import { WebhookEndpoint } from '../../entities/System/WebhookEndpoint';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { QueueService } from '../../queue/queue.service';

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
  ) {}

  /** Fan out one domain event to every active, subscribed endpoint for the tenant. */
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
        const delivery = await this.deliveries.save(
          this.deliveries.create({
            tenant: { id: tenantId } as Tenant,
            webhook_endpoint: { id: endpoint.id } as WebhookEndpoint,
            event_type: eventType,
            payload,
            status: WEBHOOK_DELIVERY_STATUS.PENDING,
          }),
        );
        await this.queue.enqueueWebhookDeliver({
          tenantId,
          webhookDeliveryId: delivery.id,
        }, this.deliverJobOptions());
      } catch (err) {
        // One bad endpoint must never suppress delivery to the others.
        this.logger.error(
          `Failed to enqueue webhook delivery for endpoint ${endpoint.id} (${eventType}): ${(err as Error)?.message}`,
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

  /** Called by the processor's `@OnWorkerEvent('failed')` once retries are exhausted. */
  async markDeadLettered(id: string, error: string): Promise<void> {
    await this.deliveries.update(
      { id },
      { status: WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED, last_error: error },
    );
  }

  /** Manual replay from the dashboard — only for deliveries in a terminal failure state. */
  async replay(tenantId: string, id: string, actor: WebhookDeliveryActor) {
    const delivery = await this.findOneOrThrow(tenantId, id);

    if (
      delivery.status !== WEBHOOK_DELIVERY_STATUS.FAILED &&
      delivery.status !== WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only failed or dead-lettered deliveries can be replayed (current status: ${delivery.status})`,
      });
    }
    if (!delivery.webhook_endpoint.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The webhook endpoint is disabled — activate it before replaying',
      });
    }

    delivery.status = WEBHOOK_DELIVERY_STATUS.PENDING;
    delivery.attempt_count = 0;
    delivery.http_status = undefined;
    delivery.last_error = undefined;
    delivery.response_preview = undefined;
    const saved = await this.deliveries.save(delivery);

    await this.queue.retryWebhookDeliver(
      { tenantId, webhookDeliveryId: saved.id },
      this.deliverJobOptions(),
    );
    await this.audit.record(
      WEBHOOK_AUDIT_ACTION.REPLAY,
      tenantId,
      actor.userId,
      'WebhookDelivery',
      saved.id,
      actor.ip,
      { eventType: saved.event_type, webhookEndpointId: saved.webhook_endpoint.id },
    );
    return this.toView(saved);
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

  /** Response projection — never includes the endpoint's secret. */
  private toView(delivery: WebhookDelivery) {
    return {
      id: delivery.id,
      eventType: delivery.event_type,
      webhookEndpointId: delivery.webhook_endpoint.id,
      webhookEndpointName: delivery.webhook_endpoint.name ?? null,
      webhookEndpointUrl: delivery.webhook_endpoint.url,
      status: delivery.status,
      httpStatus: delivery.http_status ?? null,
      attemptCount: delivery.attempt_count,
      responsePreview: delivery.response_preview ?? null,
      lastError: delivery.last_error ?? null,
      lastAttemptedAt: delivery.last_attempted_at ?? null,
      requestId: delivery.id,
      createdAt: delivery.created_at,
    };
  }
}
