import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
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
import { Message } from '../../entities/Conversations/Message';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import {
  DELIVERY_STATUS,
  DeliveryStatus,
} from '../notifications/notification.constants';
import { RecipientDeliveryService } from '../campaigns/recipient-delivery.service';
import { RecipientDelivery } from '../../entities/enums';
import { MessageStatusService } from '../conversations/message-status.service';
import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WebhookSignatureVerifier } from './webhooks/webhook-signature.verifier';
import { MetaConfig } from './meta/meta.config';
import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { MetricsService } from '../../metrics/metrics.service';
import type {
  WhatsappWebhookBody,
  MetaWebhookEntry,
} from './webhooks/whatsapp-webhook.types';
import { contentHashKey } from './webhooks/coexistence-webhook.adapter';
import { WhatsappCoexistenceEchoService } from './meta/whatsapp-coexistence-echo.service';
import { CreateWhatsappWebhookDto } from './dto/create-whatsapp-webhook.dto';
import { UpdateWhatsappWebhookDto } from './dto/update-whatsapp-webhook.dto';
import { WhatsappWebhookFilterDto } from './dto/whatsapp-webhook-filter.dto';
import { verifyTimestamp } from '../integration-platform/inbound/inbound-signature';
import { WEBHOOK_SIGNATURE_SCHEME } from '../integration-platform/integration-platform.constants';
import { COEXISTENCE_SYNC_STATUS } from './whatsapp.constants';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * ZT-H02 — Meta webhook replay-freshness tolerance.
 *
 * Sourced from Meta's own documentation, not intuition (spec edge case: "a
 * webhook freshness window sized by intuition"): "If a webhook request to
 * your endpoint receives an HTTP status code other than 200, or if the
 * webhook cannot be delivered for another reason, Meta retries delivery
 * with decreasing frequency until the request succeeds, for up to 7 days."
 * (Meta for Developers, WhatsApp Cloud API — Set up webhooks guide,
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/,
 * verified 2026-08-12). The tolerance MUST be at least this wide or a
 * legitimate late retry would be rejected as stale — a narrower,
 * intuition-sized window (minutes) would silently break real Meta
 * redelivery during an incident, exactly the failure mode the freshness
 * window must not create.
 */
const META_WEBHOOK_FRESHNESS_TOLERANCE_SECONDS = 7 * 24 * 60 * 60; // 604800 — 7 days

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
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly verifier: WebhookSignatureVerifier,
    private readonly meta: MetaConfig,
    @Inject(forwardRef(() => NotificationDeliveryService))
    private readonly notifDelivery: NotificationDeliveryService,
    private readonly recipientDelivery: RecipientDeliveryService,
    private readonly messageStatus: MessageStatusService,
    private readonly inboundAi: WhatsappInboundAiService,
    private readonly coexistenceEcho: WhatsappCoexistenceEchoService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
    // Optional: a missing counter must never cost an inbound event.
    @Optional() private readonly metrics?: MetricsService,
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
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'Invalid webhook signature',
      });
    }

    // ZT-H02 — freshness check, AFTER signature verification (so an invalid
    // signature is refused first — signature is the outer gate) and BEFORE
    // the dedup lookup. Reuses `verifyTimestamp` from the integration
    // platform's inbound-signature module rather than a second
    // implementation (Constitution V). Passing HMAC_SHA256_TIMESTAMPED
    // (not HMAC_SHA256_BODY) selects the branch that actually performs the
    // comparison — HMAC_SHA256_BODY always short-circuits to 'ok', which is
    // correct for THAT scheme's own callers (whose timestamp genuinely is
    // not bound into their MAC) but not for Meta: Meta's HMAC covers the
    // entire raw body, and the message/status timestamp is a field INSIDE
    // that signed body, so it is cryptographically bound to the signature
    // even though it is not literally concatenated as `{ts}.{body}` the way
    // the integration platform's own TIMESTAMPED scheme constructs its MAC.
    this.enforceEventFreshness(body);

    // One stored event per (entry, change). Meta may batch several into one
    // POST — different WABAs (so different clinics) or several change fields —
    // and an event row carries ONE tenant and is processed as ONE change, so a
    // batch must be split here, where each unit's tenant is resolved from its
    // OWN `phone_number_id`. A single-unit body (today's normal traffic, and the
    // legacy `{ payload }` wrapper) is stored exactly as before.
    const units = this.splitIntoUnits(body);
    const results: { id: string; deduplicated: boolean }[] = [];
    for (const unit of units) {
      results.push(await this.persistUnit(unit));
    }
    return {
      accepted: true,
      id: results[0].id,
      ...(results.every((r) => r.deduplicated) ? { deduplicated: true } : {}),
    };
  }

  /**
   * The bodies to store for one POST. The legacy wrapper and anything with fewer
   * than two changes stay a single unit holding the ORIGINAL body (same payload,
   * same idempotency key as before). A batch becomes one single-change body per
   * (entry, change), keeping the entry's own `id` so nothing else about the
   * payload is rewritten. No cap is applied: the body-size limit already bounds a
   * batch, and dropping a unit would drop a patient's message.
   */
  private splitIntoUnits(body: WhatsappWebhookBody): WhatsappWebhookBody[] {
    if (body?.payload || body?.eventType || body?.idempotencyKey) return [body];
    const units: WhatsappWebhookBody[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        units.push({
          ...(body.object !== undefined ? { object: body.object } : {}),
          entry: [{ ...entry, changes: [change] }],
        });
      }
    }
    return units.length > 1 ? units : [body];
  }

  /**
   * Dedupe → resolve tenant → persist → enqueue, for ONE unit. Exactly the
   * steps `ingest` has always run for a body, now applied per unit.
   */
  private async persistUnit(
    body: WhatsappWebhookBody,
  ): Promise<{ id: string; deduplicated: boolean }> {
    // Accept both the Meta-native body and the legacy `{ payload }` wrapper.
    const payload: Record<string, unknown> =
      body?.payload ?? (body as unknown as Record<string, unknown>);
    const eventType = body?.eventType ?? this.deriveEventType(body);
    const idempotencyKey =
      body?.idempotencyKey ?? this.deriveIdempotencyKey(body);

    if (idempotencyKey) {
      const existing = await this.webhooks.findOne({
        where: { idempotency_key: idempotencyKey },
      });
      if (existing) {
        this.metrics?.recordWhatsappInboundEvent('deduplicated');
        return { id: existing.id, deduplicated: true };
      }
    }

    const tenant = await this.resolveTenantFromPayload(payload);
    const row = this.webhooks.create({
      tenant: tenant ? ({ id: tenant } as Tenant) : undefined,
      event_type: eventType,
      payload,
      idempotency_key: idempotencyKey,
      processed: false,
    });

    let saved: WhatsappWebhook;
    try {
      saved = await this.webhooks.save(row);
    } catch (err) {
      // The `findOne` check above is a fast-path only — it cannot see a
      // concurrent redelivery still mid-insert. `UQ_whatsapp_webhook_idempotency_key`
      // is what actually serializes that race; a 23505 here means another
      // request just won it, so this is a duplicate, not a failure.
      if (
        idempotencyKey &&
        (err as { code?: string })?.code === PG_UNIQUE_VIOLATION
      ) {
        const existing = await this.webhooks.findOne({
          where: { idempotency_key: idempotencyKey },
        });
        if (existing) {
          this.metrics?.recordWhatsappInboundEvent('deduplicated');
          return { id: existing.id, deduplicated: true };
        }
      }
      throw err;
    }

    this.metrics?.recordWhatsappInboundEvent(tenant ? 'accepted' : 'no_tenant');
    await this.enqueueProcessing(saved.id, tenant);
    return { id: saved.id, deduplicated: false };
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
      // correlationId is auto-stamped from the current context by
      // QueueService if omitted — no need to pass it explicitly here.
      await this.queue.enqueueWhatsappWebhook({
        webhookEventId,
        tenantId: tenantId ?? null,
      });
    } catch (err) {
      this.logger.error(
        `[cid=${this.ctx.getCorrelationId() ?? '-'}] Failed to enqueue webhook event ${webhookEventId} (stored, unprocessed): ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Extract Meta statuses and forward each to THREE delivery axes that key
   * off `provider_ref`/`wamid`:
   *  - NotificationDeliveryService (`notification_logs` — template sends via
   *    WhatsappTemplateController/ExecutionService);
   *  - RecipientDeliveryService (`campaign_recipients` — campaign sends);
   *  - the unified conversation timeline (`messages.wa_message_id` — agent
   *    and bot replies, FND-023).
   * A given `wamid` only ever matches rows in ONE of the three tables, so
   * calling all three unconditionally is safe: the non-matching ones are a
   * cheap, harmless no-op. Without the second call campaign delivery/read
   * counters never move past `sent`; without the third, an agent's or bot's
   * reply never shows delivered/read ticks in the conversation UI, no matter
   * how many Meta status events arrive — both were real gaps this closes.
   */
  private async applyDeliveryStatuses(
    body: WhatsappWebhookBody,
    tenantId: string,
  ): Promise<void> {
    const value = this.firstChangeValue(body);
    const statuses = (value?.statuses ?? []) as Array<{
      id?: string;
      status?: string;
    }>;
    for (const st of statuses) {
      if (!st?.id) continue;
      const notifEvent = this.mapDeliveryStatus(st.status);
      if (notifEvent)
        await this.notifDelivery.recordDelivery(st.id, notifEvent);

      const recipientEvent = this.mapRecipientDelivery(st.status);
      if (recipientEvent) {
        // FND-004 — tenantId is THIS webhook event's own resolved tenant
        // (event.tenant.id, above), never client input.
        await this.recipientDelivery.recordDelivery({
          providerRef: st.id,
          event: recipientEvent,
          tenantId,
        });
      }

      await this.applyMessageTimelineStatus(tenantId, st.id, st.status);
    }
  }

  /**
   * FND-023 — the conversation-timeline axis. `sent` is not forwarded: the
   * initial SENT status log is already written at message-creation time
   * (ConversationExecutionService), before any provider callback can arrive.
   * `MessageStatusService`'s own forward-only transition guard makes an
   * out-of-order or duplicate webhook (at-least-once delivery) safe to call
   * unconditionally here too.
   */
  private async applyMessageTimelineStatus(
    tenantId: string,
    waMessageId: string,
    status?: string,
  ): Promise<void> {
    if (status !== 'delivered' && status !== 'read' && status !== 'failed')
      return;

    const message = await this.messages.findOne({
      where: { tenant: { id: tenantId }, wa_message_id: waMessageId },
    });
    if (!message) return;

    if (status === 'delivered')
      await this.messageStatus.markDelivered(tenantId, message.id);
    else if (status === 'read')
      await this.messageStatus.markRead(tenantId, message.id);
    else await this.messageStatus.markFailed(tenantId, message.id);
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

  /** Meta's status string -> the campaign recipient's delivery axis (see RecipientDeliveryService). */
  private mapRecipientDelivery(status?: string): RecipientDelivery | null {
    switch (status) {
      case 'sent':
        return RecipientDelivery.ACCEPTED;
      case 'delivered':
        return RecipientDelivery.DELIVERED;
      case 'read':
        return RecipientDelivery.READ;
      case 'failed':
        // A carrier-reported failure after the send succeeded — a hard
        // bounce, not a dispatch failure (that's `processing`, owned by the
        // worker). Terminal; see RecipientDeliveryService.
        return RecipientDelivery.BOUNCED;
      default:
        return null;
    }
  }

  /** Authenticated manual create of a webhook log entry. */
  create(
    tenantId: string,
    dto: CreateWhatsappWebhookDto,
  ): Promise<WhatsappWebhook> {
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
    const where: FindOptionsWhere<WhatsappWebhook> = {
      tenant: { id: tenantId },
    };
    if (filter.eventType) where.event_type = filter.eventType;
    if (filter.processed !== undefined)
      where.processed = filter.processed === 'true';
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
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Webhook event not found',
      });
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
    if (dto.idempotencyKey !== undefined)
      row.idempotency_key = dto.idempotencyKey;
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
  async processEvent(
    webhookEventId: string,
  ): Promise<{ processed: boolean; reason?: string }> {
    const event = await this.webhooks.findOne({
      where: { id: webhookEventId },
      relations: { tenant: true },
    });
    if (!event) return { processed: false, reason: 'event-missing' };
    if (event.processed)
      return { processed: false, reason: 'already-processed' };

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
        await this.applyDeliveryStatuses(body, tenantId);
        break;
      case 'messages': {
        const value = this.firstChangeValue(body);
        if (value) await this.inboundAi.handleInboundValue(tenantId, value);
        break;
      }
      case 'smb_message_echoes': {
        const value = this.firstChangeValue(body);
        if (value) await this.coexistenceEcho.handleEchoes(tenantId, value);
        break;
      }
      case 'smb_app_state_sync':
        await this.confirmCoexistenceSync(
          tenantId,
          body,
          'coexistence_state_sync_status',
          'coexistence_state_sync_at',
        );
        break;
      case 'history':
        await this.confirmCoexistenceSync(
          tenantId,
          body,
          'coexistence_history_sync_status',
          'coexistence_history_sync_at',
        );
        break;
      default:
        this.logger.debug(
          `[cid=${this.ctx.getCorrelationId() ?? '-'}] Webhook event ${event.id} has no handler for "${event.event_type}"`,
        );
    }

    await this.markProcessed(event.id);
    return { processed: true };
  }

  /** Guarded so a concurrent duplicate job can't double-count the transition. */
  private async markProcessed(id: string): Promise<void> {
    await this.webhooks.update({ id, processed: false }, { processed: true });
  }

  /**
   * Coexistence: an inbound `smb_app_state_sync`/`history` webhook is Meta's
   * CONFIRMATION that a sync this platform triggered (`WhatsappCoexistenceSyncService`)
   * actually completed — the outbound POST accepting the request is not the
   * same fact. Resolves the account the SAME trusted way every inbound event
   * does (`metadata.phone_number_id` → live account, tenant-scoped), then
   * advances the status ONLY from IN_PROGRESS to COMPLETED.
   *
   * That guard is what makes a redelivered/duplicate confirmation webhook a
   * safe no-op: a status already COMPLETED (an earlier delivery already
   * applied it) or FAILED (a later real failure must not be silently
   * overwritten by a stale, now out-of-order confirmation) is left alone.
   */
  private async confirmCoexistenceSync(
    tenantId: string,
    body: WhatsappWebhookBody,
    statusField:
      | 'coexistence_state_sync_status'
      | 'coexistence_history_sync_status',
    atField: 'coexistence_state_sync_at' | 'coexistence_history_sync_at',
  ): Promise<void> {
    const phoneNumberId = this.extractPhoneNumberId(
      body as unknown as Record<string, unknown>,
    );
    if (!phoneNumberId) {
      this.logger.warn(
        `[cid=${this.ctx.getCorrelationId() ?? '-'}] Coexistence sync confirmation carried no phone_number_id (tenant=${tenantId}) — cannot update sync status`,
      );
      return;
    }
    const account = await this.accounts.findOne({
      where: {
        phone_number_id: phoneNumberId,
        tenant: { id: tenantId },
        deleted_at: IsNull(),
      },
    });
    if (
      !account ||
      account[statusField] !== COEXISTENCE_SYNC_STATUS.IN_PROGRESS
    ) {
      return;
    }
    await this.accounts.update(account.id, {
      [statusField]: COEXISTENCE_SYNC_STATUS.COMPLETED,
      [atField]: new Date(),
    });
    this.logger.log(
      `COEXISTENCE_SYNC_CONFIRMED account=${account.id} field=${statusField}`,
    );
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
        `[cid=${this.ctx.getCorrelationId() ?? '-'}] Inbound webhook for unknown/disconnected phone_number_id — event stored without a tenant`,
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
   * ZT-H02 — the authenticated timestamp the freshness check compares
   * against the clock. Read from the first message's or status's own
   * `timestamp` field (Unix seconds) inside the signed body — confirmed
   * present on both shapes by Meta's own webhook payload reference
   * (message and status objects each document a `timestamp` field). Not
   * read from any request header: only a value that is actually inside the
   * HMAC-covered raw body counts as authenticated.
   */
  private extractEventTimestamp(body: WhatsappWebhookBody): string | undefined {
    const value = this.firstChangeValue(body);
    const statusTimestamp = value?.statuses?.[0]?.timestamp;
    if (statusTimestamp) return statusTimestamp;
    const messageTimestamp = value?.messages?.[0]?.timestamp;
    if (messageTimestamp) return messageTimestamp;
    // Coexistence — Meta documents `message_echoes` items as message objects
    // (same fields, including `timestamp`), so the same extraction applies.
    const echoTimestamp = value?.message_echoes?.[0]?.timestamp;
    if (echoTimestamp) return echoTimestamp;
    return undefined;
  }

  /**
   * ZT-H02 — refuses a signature-valid payload whose authenticated
   * timestamp falls outside `META_WEBHOOK_FRESHNESS_TOLERANCE_SECONDS`.
   * Every `TimestampVerdict` is handled explicitly; none falls through
   * unhandled (FR-050).
   */
  private enforceEventFreshness(body: WhatsappWebhookBody): void {
    const presented = this.extractEventTimestamp(body);

    // Coexistence — `history`/`smb_app_state_sync` payload schemas are not
    // asserted anywhere in this codebase (see coexistence-webhook.adapter.ts
    // docblock: no verified sample payload was available), so no field name
    // is guessed for a timestamp inside them. The HMAC signature check above
    // (over the exact raw body) still authenticates the request either way;
    // this only means the additional anti-replay freshness window cannot be
    // evaluated for these two specific fields, so it is skipped — scoped
    // exactly to them, so no other event type's protection weakens, and
    // narrower than the fail-closed "missing" branch below, which stays in
    // effect for every field type this codebase DOES assert a timestamp for.
    if (presented === undefined) {
      const field = body?.entry?.[0]?.changes?.[0]?.field;
      if (field === 'history' || field === 'smb_app_state_sync') {
        this.logger.debug(
          `Skipping freshness check for "${field}" — no asserted timestamp field for this Coexistence event type`,
        );
        return;
      }
    }

    const verdict = verifyTimestamp(
      WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED,
      presented,
      META_WEBHOOK_FRESHNESS_TOLERANCE_SECONDS,
    );
    switch (verdict) {
      case 'ok':
        return;
      case 'stale':
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message:
            'Webhook event timestamp is outside the accepted freshness window',
        });
      case 'future':
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message: 'Webhook event timestamp is in the future',
        });
      case 'malformed':
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message: 'Webhook event timestamp is malformed',
        });
      case 'missing':
        // A payload shape carrying no discoverable timestamp must not
        // silently bypass the freshness window (spec FR-051) — every
        // event type this integration actually processes (`messages`,
        // `message_status`) reliably carries one (Meta's own webhook
        // reference), so requiring it here is a fail-closed choice on a
        // genuinely anomalous shape, not a gap for a real event type.
        throw new AppError(ErrorCode.UNAUTHORIZED, {
          message: 'Webhook event carries no verifiable timestamp',
        });
    }
  }

  /**
   * Maps a Meta change into a coarse event type the worker can branch on:
   * `messages` (inbound message) or `message_status` (sent/delivered/read/failed).
   */
  private deriveEventType(body: WhatsappWebhookBody): string | undefined {
    const value = this.firstChangeValue(body);
    if (!value) return undefined;
    if (Array.isArray(value.statuses) && value.statuses.length > 0)
      return 'message_status';
    if (Array.isArray(value.messages) && value.messages.length > 0)
      return 'messages';
    const field = body?.entry?.[0]?.changes?.[0]?.field;
    return field ?? undefined;
  }

  /**
   * Idempotency key = the WhatsApp message id (`wamid`) of the first message or
   * status in the payload. Meta redelivers events on the same wamid, so this
   * de-duplicates safely. Undefined when the payload carries no wamid.
   *
   * Patient Journey plan (2026-09-16) — the status branch used to be
   * `status:{wamid}` with no status VALUE in the key. Meta sends `sent`,
   * `delivered` and `read` as three separate webhooks for the SAME wamid, so
   * the old key collapsed all three onto one idempotency row: whichever
   * arrived first (almost always `sent`) was stored, and the later
   * `delivered`/`read` events came back as duplicates and were dropped
   * before `applyDeliveryStatuses` ever ran — `scheduled_notifications
   * .delivery_status` essentially never reached DELIVERED/READ, and neither
   * did the campaign-recipient or conversation-timeline axes. Including the
   * status VALUE in the key lets each of the three status events be
   * ingested and processed once, while still deduplicating a genuine Meta
   * redelivery of the identical status. Safe to widen: all three downstream
   * consumers (`NotificationDeliveryService.recordDelivery`,
   * `RecipientDeliveryService`, `MessageStatusService`) are forward-only —
   * see their own docblocks — so an out-of-order or repeated status can
   * never regress or double-apply state. Existing rows keep their old-format
   * key; only the SHAPE of new keys changes.
   */
  private deriveIdempotencyKey(body: WhatsappWebhookBody): string | undefined {
    const value = this.firstChangeValue(body);
    if (!value) return undefined;
    const statusId = value.statuses?.[0]?.id;
    if (statusId) {
      const status = value.statuses?.[0]?.status ?? 'unknown';
      return `status:${statusId}:${status}`;
    }
    const messageId = value.messages?.[0]?.id;
    if (messageId) return `message:${messageId}`;

    // Coexistence — `message_echoes` items carry their own wamid, same as an
    // ordinary message, so the same natural key applies.
    const echoId = value.message_echoes?.[0]?.id;
    if (echoId) return `echo:${echoId}`;

    // Coexistence — `history`/`smb_app_state_sync` have no asserted schema
    // (see coexistence-webhook.adapter.ts), so a content hash of the whole
    // change value is the key: identical redeliveries dedupe, a genuinely
    // new chunk/state does not.
    const field = body?.entry?.[0]?.changes?.[0]?.field;
    if (field === 'history' || field === 'smb_app_state_sync') {
      return contentHashKey(field, value);
    }
    return undefined;
  }
}
