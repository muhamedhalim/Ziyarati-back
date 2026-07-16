import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { WhatsappWebhook } from '../../entities/WhatsApp/WhatsappWebhook';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { DELIVERY_STATUS, DeliveryStatus } from '../notifications/notification.constants';
import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WebhookSignatureVerifier } from './webhooks/webhook-signature.verifier';
import { MetaConfig } from './meta/meta.config';
import { QueueService } from '../../queue/queue.service';
import type {
  WhatsappWebhookBody,
  MetaWebhookEntry,
} from './webhooks/whatsapp-webhook.types';
import { CreateWhatsappWebhookDto } from './dto/create-whatsapp-webhook.dto';
import { UpdateWhatsappWebhookDto } from './dto/update-whatsapp-webhook.dto';
import { WhatsappWebhookFilterDto } from './dto/whatsapp-webhook-filter.dto';

/**
 * WhatsApp inbound webhook events.
 *
 * Schema note: `whatsapp_webhooks` is an EVENT LOG (event_type, payload,
 * processed, idempotency_key) — there is no URL/secret column, so the verify
 * token & signing secret come from configuration (see WebhookSignatureVerifier),
 * not the DB.
 *
 * Tenant isolation: management reads filter `tenant: { id: tenantId }`. Ingestion
 * is public (the provider calls it) and resolves the tenant from the payload's
 * `phone_number_id` → account — never from a client-supplied tenantId.
 */
@Injectable()
export class WhatsappWebhookService {
  private readonly logger = new Logger('WhatsappWebhookService');

  constructor(
    @InjectRepository(WhatsappWebhook)
    private readonly webhooks: Repository<WhatsappWebhook>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly verifier: WebhookSignatureVerifier,
    private readonly meta: MetaConfig,
    @Inject(forwardRef(() => NotificationDeliveryService))
    private readonly notifDelivery: NotificationDeliveryService,
    private readonly inboundAi: WhatsappInboundAiService,
    private readonly queue: QueueService,
  ) {}

  /** GET verification handshake — returns the challenge to echo, or null. */
  resolveChallenge(
    mode?: string,
    verifyToken?: string,
    challenge?: string,
  ): string | null {
    return this.verifier.resolveChallenge(
      mode,
      verifyToken,
      challenge,
      this.meta.webhookVerifyToken,
    );
  }

  /**
   * Public ingestion (called by Meta). Does the MINIMUM required to accept the
   * event safely, then hands off:
   *  1. Verify the `X-Hub-Signature-256` over the EXACT raw bytes (Buffer) — the
   *     parsed body is NEVER used for the signature.
   *  2. Derive the event type (messages / message_status) and an idempotency key
   *     (the WhatsApp `wamid`) from the Meta payload — falling back to the legacy
   *     wrapper fields for backward compatibility.
   *  3. De-duplicate redelivered events on the idempotency key.
   *  4. Resolve the tenant from the payload (`phone_number_id` → account) — never
   *     trusted from the request.
   *  5. Persist the raw payload (`processed = false`).
   *  6. Enqueue processing and return immediately.
   *
   * Nothing is processed inline. Meta requires a fast 200 and retries the event
   * if we are slow — doing AI turns or media downloads here would both risk that
   * timeout and lose work on a crash (the old fire-and-forget `void` call had no
   * retry and no record of having failed). The persisted row + queue job give
   * durability, retries and back-pressure instead.
   */
  async ingest(
    body: WhatsappWebhookBody,
    rawBody: Buffer | undefined,
    signatureHeader?: string,
  ): Promise<{ accepted: boolean; id?: string; deduplicated?: boolean }> {
    if (!this.verifier.verify(signatureHeader, rawBody)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'Invalid webhook signature' });
    }

    // Accept both the Meta-native body and the legacy `{ payload }` wrapper.
    const payload: Record<string, unknown> =
      body?.payload ?? (body as unknown as Record<string, unknown>);
    const eventType = body?.eventType ?? this.deriveEventType(body);
    const idempotencyKey = body?.idempotencyKey ?? this.deriveIdempotencyKey(body);

    if (idempotencyKey) {
      const existing = await this.webhooks.findOne({
        where: { idempotency_key: idempotencyKey },
      });
      if (existing) return { accepted: true, id: existing.id, deduplicated: true };
    }

    const tenant = await this.resolveTenantFromPayload(payload);
    const row = this.webhooks.create({
      tenant: tenant ? ({ id: tenant } as Tenant) : undefined,
      event_type: eventType,
      payload,
      idempotency_key: idempotencyKey,
      processed: false,
    });
    const saved = await this.webhooks.save(row);

    await this.enqueueProcessing(saved.id, tenant);
    return { accepted: true, id: saved.id };
  }

  /**
   * Hand the persisted event to the worker.
   *
   * Enqueue failure is logged, NOT thrown: the event is already durably stored,
   * so failing the request would make Meta redeliver something we already have.
   * The row stays `processed = false` and can be re-queued via `retry`.
   */
  private async enqueueProcessing(
    webhookEventId: string,
    tenantId: string | undefined,
  ): Promise<void> {
    try {
      await this.queue.enqueueWhatsappWebhook({ webhookEventId, tenantId: tenantId ?? null });
    } catch (err) {
      this.logger.error(
        `Failed to enqueue webhook event ${webhookEventId} (stored, unprocessed): ${(err as Error)?.message}`,
      );
    }
  }

  /** Extract Meta statuses and forward each to the notification delivery axis. */
  private async applyDeliveryStatuses(body: WhatsappWebhookBody): Promise<void> {
    const value = this.firstChangeValue(body);
    const statuses = (value?.statuses ?? []) as Array<{ id?: string; status?: string }>;
    for (const st of statuses) {
      const event = this.mapDeliveryStatus(st?.status);
      if (event && st?.id) await this.notifDelivery.recordDelivery(st.id, event);
    }
  }

  private mapDeliveryStatus(status?: string): DeliveryStatus | null {
    switch (status) {
      case 'sent':
        return DELIVERY_STATUS.ACCEPTED;
      case 'delivered':
        return DELIVERY_STATUS.DELIVERED;
      case 'read':
        return DELIVERY_STATUS.READ;
      case 'failed':
        return DELIVERY_STATUS.FAILED;
      default:
        return null;
    }
  }

  /** Authenticated manual create of a webhook log entry. */
  create(tenantId: string, dto: CreateWhatsappWebhookDto): Promise<WhatsappWebhook> {
    const row = this.webhooks.create({
      tenant: { id: tenantId } as Tenant,
      event_type: dto.eventType,
      payload: dto.payload,
      idempotency_key: dto.idempotencyKey,
      processed: dto.processed ?? false,
    });
    return this.webhooks.save(row);
  }

  async findAll(tenantId: string, filter: WhatsappWebhookFilterDto) {
    const where: FindOptionsWhere<WhatsappWebhook> = { tenant: { id: tenantId } };
    if (filter.eventType) where.event_type = filter.eventType;
    if (filter.processed !== undefined) where.processed = filter.processed === 'true';
    if (filter.from && filter.to) {
      where.created_at = Between(new Date(filter.from), new Date(filter.to));
    } else if (filter.from) {
      where.created_at = MoreThanOrEqual(new Date(filter.from));
    } else if (filter.to) {
      where.created_at = LessThan(new Date(filter.to));
    }

    const [data, total] = await this.webhooks.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<WhatsappWebhook> {
    const row = await this.webhooks.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Webhook event not found' });
    }
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWhatsappWebhookDto,
  ): Promise<WhatsappWebhook> {
    const row = await this.findOne(tenantId, id);
    if (dto.eventType !== undefined) row.event_type = dto.eventType;
    if (dto.payload !== undefined) row.payload = dto.payload;
    if (dto.idempotencyKey !== undefined) row.idempotency_key = dto.idempotencyKey;
    if (dto.processed !== undefined) row.processed = dto.processed;
    return this.webhooks.save(row);
  }

  /**
   * Re-queues a webhook event for processing: marks it unprocessed and enqueues
   * a real job. (Before the worker existed this only flipped the flag, and
   * nothing ever consumed it — the "retry" silently did nothing.)
   *
   * The queue de-dupes on the event id, so a burst of retry clicks collapses
   * onto one job rather than replaying a patient's message repeatedly.
   */
  async retry(tenantId: string, id: string): Promise<WhatsappWebhook> {
    const row = await this.findOne(tenantId, id);
    row.processed = false;
    const saved = await this.webhooks.save(row);
    await this.queue.enqueueWhatsappWebhook({ webhookEventId: id, tenantId });
    return saved;
  }

  /**
   * WORKER ENTRY POINT: process one stored event.
   *
   * Loaded by id rather than trusting the job payload, so the row remains the
   * source of truth and a replayed job can't smuggle different content.
   * Idempotent: an already-processed event is skipped, and the underlying
   * handlers are themselves idempotent (delivery status is forward-only; the AI
   * turn is keyed on the wamid).
   */
  async processEvent(webhookEventId: string): Promise<{ processed: boolean; reason?: string }> {
    const event = await this.webhooks.findOne({
      where: { id: webhookEventId },
      relations: { tenant: true },
    });
    if (!event) return { processed: false, reason: 'event-missing' };
    if (event.processed) return { processed: false, reason: 'already-processed' };

    const tenantId = event.tenant?.id;
    if (!tenantId) {
      // Unresolvable events are kept for diagnostics but must never be guessed
      // at — without a tenant there is no safe place to put the message.
      await this.markProcessed(event.id);
      return { processed: false, reason: 'no-tenant' };
    }

    const body = event.payload as WhatsappWebhookBody;

    switch (event.event_type) {
      case 'message_status':
        await this.applyDeliveryStatuses(body);
        break;
      case 'messages': {
        const value = this.firstChangeValue(body);
        if (value) await this.inboundAi.handleInboundValue(tenantId, value);
        break;
      }
      default:
        this.logger.debug(`Webhook event ${event.id} has no handler for "${event.event_type}"`);
    }

    await this.markProcessed(event.id);
    return { processed: true };
  }

  /** Guarded so a concurrent duplicate job can't double-count the transition. */
  private async markProcessed(id: string): Promise<void> {
    await this.webhooks.update({ id, processed: false }, { processed: true });
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /**
   * Resolves the owning tenant from a Meta webhook payload.
   *
   * This is THE trusted mapping (`metadata.phone_number_id` → WhatsappAccount →
   * tenant) — the only thing deciding whose conversation an inbound patient
   * message belongs to. It must therefore be exact, not best-effort:
   *  - soft-deleted accounts are excluded (a disconnected number must not keep
   *    routing a clinic's messages to its former owner);
   *  - `phone_number_id` is unique among live accounts (partial unique index),
   *    so this lookup resolves to at most one tenant rather than an arbitrary
   *    row among several claimants.
   * Unresolvable events are still stored (tenant-less) for diagnostics, and
   * never guessed at.
   */
  private async resolveTenantFromPayload(
    payload: Record<string, unknown> | undefined,
  ): Promise<string | undefined> {
    const phoneNumberId = this.extractPhoneNumberId(payload);
    if (!phoneNumberId) return undefined;
    const account = await this.accounts.findOne({
      where: { phone_number_id: phoneNumberId, deleted_at: IsNull() },
      relations: { tenant: true },
    });
    if (!account) {
      this.logger.warn(
        `Inbound webhook for unknown/disconnected phone_number_id — event stored without a tenant`,
      );
      return undefined;
    }
    return account.tenant?.id;
  }

  private extractPhoneNumberId(
    payload: Record<string, unknown> | undefined,
  ): string | undefined {
    try {
      const entry = (payload as any)?.entry?.[0];
      const value = entry?.changes?.[0]?.value;
      return value?.metadata?.phone_number_id as string | undefined;
    } catch {
      return undefined;
    }
  }

  /** First entry/change of a Meta payload, regardless of wrapper shape. */
  private firstChangeValue(body: WhatsappWebhookBody) {
    const entries: MetaWebhookEntry[] | undefined =
      body?.entry ?? (body?.payload as { entry?: MetaWebhookEntry[] })?.entry;
    return entries?.[0]?.changes?.[0]?.value;
  }

  /**
   * Maps a Meta change into a coarse event type the worker can branch on:
   * `messages` (inbound message) or `message_status` (sent/delivered/read/failed).
   */
  private deriveEventType(body: WhatsappWebhookBody): string | undefined {
    const value = this.firstChangeValue(body);
    if (!value) return undefined;
    if (Array.isArray(value.statuses) && value.statuses.length > 0) return 'message_status';
    if (Array.isArray(value.messages) && value.messages.length > 0) return 'messages';
    const field = body?.entry?.[0]?.changes?.[0]?.field;
    return field ?? undefined;
  }

  /**
   * Idempotency key = the WhatsApp message id (`wamid`) of the first message or
   * status in the payload. Meta redelivers events on the same wamid, so this
   * de-duplicates safely. Undefined when the payload carries no wamid.
   */
  private deriveIdempotencyKey(body: WhatsappWebhookBody): string | undefined {
    const value = this.firstChangeValue(body);
    if (!value) return undefined;
    const statusId = value.statuses?.[0]?.id;
    if (statusId) return `status:${statusId}`;
    const messageId = value.messages?.[0]?.id;
    if (messageId) return `message:${messageId}`;
    return undefined;
  }
}
