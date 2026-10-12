import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In, LessThan, Repository } from 'typeorm';

import { IntegrationInboundEvent } from '../../../entities/Integration/IntegrationInboundEvent';
import { IntegrationWebhookEndpoint } from '../../../entities/Integration/IntegrationWebhookEndpoint';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { OutboxJob } from '../../../entities/Campaigns/OutboxJob';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';
import { QueueService } from '../../../queue/queue.service';
import { QUEUE, JOB } from '../../../queue/queue.constants';

import {
  ADMISSION_OP,
  CONNECTION_STATUS,
  INBOUND_EVENT_MAP,
  INBOUND_EVENTS,
  INBOUND_REJECTION,
  INBOUND_STATUS,
  INBOUND_EVENT_RETENTION_DAYS,
  InboundEvent,
  InboundRejection,
  IntegrationResource,
  MAX_WEBHOOK_BODY_BYTES,
  TERMINAL_INBOUND_STATUSES,
  UPSERT_LIFECYCLE,
  UPSERT_OUTCOME,
  WEBHOOK_ENDPOINT_STATUS,
  WEBHOOK_SIGNATURE_SCHEME,
  WebhookSignatureScheme,
} from '../integration-platform.constants';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationIdempotencyService } from '../idempotency/integration-idempotency.service';
import { IntegrationUpsertService } from '../write/integration-upsert.service';
import { IntegrationServiceAccountService } from '../write/integration-service-account.service';
import { sanitizeExternalInput } from '../write/source-of-truth';
import { resolveProviderAdapter } from '../providers/provider.registry';
import { IntegrationWebhookEndpointService } from './integration-webhook-endpoint.service';
import { QueryInboundEventsDto } from '../dto/webhook-endpoint.dto';
import {
  InboundHeaders,
  readInboundHeaders,
  verifyInboundSignature,
  verifyTimestamp,
} from './inbound-signature';

/**
 * Read-only hints an inbound event may carry through to the shared pipeline.
 * These are NOT writable fields (the source-of-truth engine ignores them) — they
 * only tell an adapter which existing record to match. Anything outside this
 * list and the resource allowlist is dropped.
 *
 * `action` is deliberately NOT here: the lifecycle an event may perform is
 * decided by its authorised EVENT TYPE alone (see INBOUND_EVENT_MAP and
 * `process()`), never by a field in the body — otherwise an endpoint that only
 * allows `appointment.created` could still cancel or move appointments.
 * (`branchExternalId` is gone too: branches have no external-id mapping.)
 */
const SAFE_INBOUND_HINTS = [
  'matchEmail',
  'customerExternalId',
  'staffExternalId',
  'serviceExternalIds',
  'reason',
] as const;

/** Attempts before an event is parked as `failed` rather than retried again. */
const MAX_INBOUND_ATTEMPTS = 5;

export interface InboundReceipt {
  /** HTTP status to ack with. */
  status: number;
  body: { received: true; eventId: string | null; status: string; reason?: string };
}

/**
 * Inbound webhook receiver + worker (Phase 4).
 *
 * ONE mutation path: an accepted event is applied by `IntegrationUpsertService`
 * — the same pipeline the M2M API, async imports and sync runs use — so
 * source-of-truth enforcement, protected-field rejection, external-id mapping,
 * conflict persistence and audit are shared, not reimplemented.
 *
 * ACK SEMANTICS. The receiver persists the event AND its enqueue-intent in one
 * DB transaction (the transactional outbox — see OutboxJob/OutboxRelayService)
 * and only then acks 202. Enqueuing is now a pure database write, not a Redis
 * call — a Redis outage at accept time can no longer produce a durably-recorded
 * event that never gets processed (the prior failure mode this section used to
 * describe): the worker-side relay is what talks to Redis, on its own schedule,
 * with its own recovery for a mid-publish crash. Only a genuine database
 * failure rolls back the whole accept (nothing was ever committed). Rejections
 * are acked with an
 * explicit 4xx and a safe reason CODE so a provider can fix its integration; a
 * duplicate is acked 200 (the provider did nothing wrong).
 *
 * REJECTION HISTORY. Rejections that occur AFTER signature verification are
 * persisted as `rejected` rows — those come from a legitimate partner holding a
 * valid secret and are the actionable ones. A delivery that fails signature or
 * timestamp verification is NOT given a history row (an unauthenticated caller
 * must not be able to fill a tenant's table); it is counted on the endpoint and
 * written to the audit log, which admission control already bounds.
 */
@Injectable()
export class IntegrationInboundService {
  private readonly logger = new Logger(IntegrationInboundService.name);

  constructor(
    @InjectRepository(IntegrationInboundEvent)
    private readonly events: Repository<IntegrationInboundEvent>,
    private readonly endpoints: IntegrationWebhookEndpointService,
    private readonly connections: IntegrationConnectionService,
    private readonly admission: IntegrationAdmissionService,
    private readonly idempotency: IntegrationIdempotencyService,
    private readonly upsert: IntegrationUpsertService,
    private readonly serviceAccount: IntegrationServiceAccountService,
    private readonly audit: IntegrationAuditService,
    private readonly queue: QueueService,
    private readonly dataSource: DataSource,
  ) {}

  // ── Receive (public HTTP path) ────────────────────────────────────────────

  /**
   * Verify and accept one delivery. `rawBody` MUST be the exact received bytes —
   * signatures are computed over them, never over a re-serialized object.
   */
  async receive(
    connectionId: string,
    rawBody: string,
    headers: InboundHeaders,
    ip?: string,
  ): Promise<InboundReceipt> {
    // 1. Size — checked on the raw bytes, before any parse or DB work.
    if (Buffer.byteLength(rawBody ?? '', 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Webhook body exceeds the maximum size of ${Math.floor(MAX_WEBHOOK_BODY_BYTES / 1024)} KB`,
        publicContext: { reason: INBOUND_REJECTION.PAYLOAD_TOO_LARGE },
      });
    }

    // 2. Endpoint — the URL alone identifies tenant + connection. A caller can
    //    never assert a tenant id.
    const endpoint = await this.endpoints.findByConnectionId(connectionId);
    if (!endpoint) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No inbound webhook endpoint is configured for this connection',
        publicContext: { reason: INBOUND_REJECTION.NO_ENDPOINT },
      });
    }
    const tenantId = (endpoint.tenant as Tenant)?.id;

    const h = readInboundHeaders(headers);
    const scheme = endpoint.signature_scheme as WebhookSignatureScheme;

    // 3. Authenticate FIRST (pure in-memory HMAC — no persistence). The verdict
    //    decides WHICH admission budget is charged: a delivery that fails here
    //    must not consume the connection budget reserved for signed events, or
    //    anyone who knows the (non-secret) connection id could lock the real
    //    partner out.
    const authFailure = this.authenticate(endpoint, scheme, h, rawBody, headers);
    if (authFailure) {
      // Own per-source-IP / per-connection bucket. Fail-closed 503 if the
      // limiter is unreachable; 429 + Retry-After when exhausted — in which case
      // NOTHING is written (no counter, no audit row), bounding DB work.
      await this.admission.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId, connectionId, ip });
      return this.rejectUnauthenticated(endpoint, tenantId, authFailure, ip);
    }

    // 4. Admission for AUTHENTICATED traffic — fail-closed, before any persistence.
    await this.admission.admit(ADMISSION_OP.INBOUND_WEBHOOK, { tenantId, connectionId });

    // ── Authenticated from here: rejections get a history row ───────────────

    // 6. Parse. Malformed JSON from an authenticated partner is worth recording.
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, null, null, INBOUND_REJECTION.MALFORMED, ip);
    }

    // SEC-01: the body is covered by every scheme's MAC, the headers are not (under
    // the legacy schemes). If the body states its own event id/type, a header that
    // disagrees is a tampered or replayed delivery — refuse it rather than let the
    // unsigned header win. (`id`/`type` are only fallbacks, not explicit claims.)
    const bodyEventId = asString(body.eventId);
    const bodyEventType = asString(body.event);
    if (
      (h.eventId && bodyEventId && h.eventId !== bodyEventId) ||
      (h.eventType && bodyEventType && h.eventType !== bodyEventType)
    ) {
      return this.rejectAuthenticated(
        endpoint, tenantId, connectionId, null, null, INBOUND_REJECTION.HEADER_BODY_MISMATCH, ip,
      );
    }

    const eventId = h.eventId ?? bodyEventId ?? asString(body.id);
    const eventType = h.eventType ?? bodyEventType ?? asString(body.type);
    const externalId = asString(body.externalId);

    if (!eventId) {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, null, eventType, INBOUND_REJECTION.MISSING_EVENT_ID, ip);
    }

    // 7. Event allowlist — compiled set first, then the endpoint's subset.
    if (!eventType || !INBOUND_EVENTS.includes(eventType as never)) {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, eventId, eventType, INBOUND_REJECTION.UNSUPPORTED_EVENT, ip);
    }
    if (!(endpoint.allowed_events ?? []).includes(eventType)) {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, eventId, eventType, INBOUND_REJECTION.EVENT_NOT_ALLOWED, ip);
    }
    if (!externalId) {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, eventId, eventType, INBOUND_REJECTION.MISSING_EXTERNAL_ID, ip);
    }

    // 8. Connection must be able to receive. A deactivated or disconnected
    //    connection may not write, sync, or accept inbound events.
    const connection = endpoint.connection as IntegrationConnection | undefined;
    if (!connection || connection.status !== CONNECTION_STATUS.ACTIVE || connection.deleted_at) {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, eventId, eventType, INBOUND_REJECTION.CONNECTION_INACTIVE, ip);
    }
    if (endpoint.status !== WEBHOOK_ENDPOINT_STATUS.ACTIVE) {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, eventId, eventType, INBOUND_REJECTION.ENDPOINT_INACTIVE, ip);
    }

    // 9. Sanitize at the DOOR: protected fields are refused outright and never
    //    persisted; unknown fields are dropped. Only the allowlisted writable
    //    fields plus the compiled read-only hints are staged.
    const mapped = INBOUND_EVENT_MAP[eventType as InboundEvent];
    let payload: Record<string, unknown>;
    try {
      payload = this.stagePayload(mapped.resource, body.data, mapped.action);
    } catch {
      return this.rejectAuthenticated(endpoint, tenantId, connectionId, eventId, eventType, INBOUND_REJECTION.PROTECTED_FIELDS, ip);
    }

    // 9b. Replay pre-check. The unique index below stays the RACE guard (two
    //     concurrent deliveries can both pass a read), but it is not the only
    //     line of defence: a database missing that index (schema drift — see the
    //     dev-DB notes) would otherwise accept a replay and process it twice.
    //     Same key as the index: (tenant, endpoint, provider event id).
    const alreadySeen = await this.events.findOne({
      where: {
        tenant: { id: tenantId },
        endpoint: { id: endpoint.id },
        provider_event_id: eventId,
      },
      select: { id: true },
    });
    if (alreadySeen) {
      await this.endpoints.recordOutcome(endpoint.id, true);
      return {
        status: 200,
        body: { received: true, eventId, status: INBOUND_STATUS.DUPLICATE, reason: INBOUND_REJECTION.REPLAYED },
      };
    }

    // 10. Persist + enqueue-intent in ONE transaction via the transactional
    //     outbox (Phase 0 — see docs/CACHING_QUEUES_AUDIT.md §0.5 item 4 /
    //     original audit H6). The unique (tenant, endpoint, event id) index is
    //     the replay guard — not a service-level "seen it?" check that two
    //     concurrent deliveries could both pass — and it fires on the INSERT
    //     inside this transaction exactly as it did on the old standalone save.
    let event: IntegrationInboundEvent;
    try {
      event = await this.dataSource.transaction(async (mgr) => {
        const saved = await mgr.save(
          mgr.create(IntegrationInboundEvent, {
            tenant: { id: tenantId } as Tenant,
            endpoint: { id: endpoint.id } as IntegrationWebhookEndpoint,
            connection: { id: connectionId } as IntegrationConnection,
            provider_event_id: eventId,
            event_type: eventType,
            resource_type: mapped.resource,
            external_id: externalId,
            status: INBOUND_STATUS.ACCEPTED,
            payload,
            signature_timestamp: h.timestamp ?? null,
          }),
        );
        await mgr.save(
          mgr.create(OutboxJob, {
            queue: QUEUE.INTEGRATION_INBOUND,
            job_name: JOB.INTEGRATION_INBOUND,
            dedupe_key: `integration-inbound-${saved.id}`,
            payload: { tenantId, inboundEventId: saved.id },
          }),
        );
        return saved;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Already received — the provider re-delivered. Ack 200; do NOT process
        // twice and do NOT report an error the provider cannot act on.
        await this.endpoints.recordOutcome(endpoint.id, true);
        return {
          status: 200,
          body: { received: true, eventId, status: INBOUND_STATUS.DUPLICATE, reason: INBOUND_REJECTION.REPLAYED },
        };
      }
      throw err;
    }

    await this.endpoints.recordOutcome(endpoint.id, true);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.WEBHOOK_ACCEPTED,
      tenantId,
      'IntegrationInboundEvent',
      event.id,
      { ip },
      { connectionId, eventType, externalId, providerEventId: eventId },
    );

    return { status: 202, body: { received: true, eventId, status: INBOUND_STATUS.ACCEPTED } };
  }

  // ── Worker path ───────────────────────────────────────────────────────────

  /**
   * Apply one accepted event through the SHARED write pipeline. Idempotent and
   * retry-safe: a terminal event short-circuits, and the integration idempotency
   * service dedupes a redelivered queue job for the same event.
   */
  async process(inboundEventId: string): Promise<void> {
    const event = await this.events.findOne({
      where: { id: inboundEventId },
      relations: { tenant: true, connection: true, endpoint: true },
    });
    if (!event) {
      this.logger.warn(`inbound event ${inboundEventId} not found — skipping`);
      return;
    }
    if (TERMINAL_INBOUND_STATUSES.includes(event.status as never)) {
      this.logger.log(`inbound event ${inboundEventId} already terminal (${event.status}) — skipping`);
      return;
    }

    const tenantId = (event.tenant as Tenant).id;
    const connectionId = event.connection?.id ?? null;

    // AUTHORITATIVE authorisation, at APPLY time. The receiver already checked
    // the allow-list, but this is the path that mutates data: it re-derives what
    // the event may do from its type alone and re-checks the endpoint as it is
    // NOW (allow-list narrowed, endpoint disabled or removed since acceptance).
    const mapped = INBOUND_EVENT_MAP[event.event_type as InboundEvent];
    const ep = event.endpoint;
    const denied = !mapped
      ? INBOUND_REJECTION.UNSUPPORTED_EVENT
      : !ep || ep.status !== WEBHOOK_ENDPOINT_STATUS.ACTIVE
        ? INBOUND_REJECTION.ENDPOINT_INACTIVE
        : !(ep.allowed_events ?? []).includes(event.event_type)
          ? INBOUND_REJECTION.EVENT_NOT_ALLOWED
          : null;
    if (denied) {
      event.rejection_reason = denied;
      await this.finish(event, INBOUND_STATUS.REJECTED, `Not applied: ${denied}`, null, null);
      return;
    }
    // Lifecycle comes ONLY from the event type; any `action` that may be in a
    // payload staged by an older build is discarded here.
    const applyPayload: Record<string, unknown> = { ...((event.payload ?? {}) as Record<string, unknown>) };
    delete applyPayload.action;
    if (mapped.action) applyPayload.action = mapped.action;
    const lifecycle =
      mapped.resource === 'appointment' ? (mapped.action ?? UPSERT_LIFECYCLE.CREATE) : undefined;

    event.status = INBOUND_STATUS.PROCESSING;
    event.attempts += 1;
    await this.events.save(event);

    try {
      if (!connectionId) throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Connection was removed' });
      // Re-check at APPLY time: a connection deactivated between receipt and
      // processing must not be written through.
      const connection = await this.connections.requireActive(tenantId, connectionId);
      const policy = this.connections.conflictPolicyOf(connection);

      // Machine-originated write → attribute to the tenant's verified
      // integration service account (never a fabricated or API-key id).
      const userId = await this.serviceAccount.resolve(tenantId);

      // Reuse the SHARED idempotency service, keyed on the provider's event id,
      // so a redelivered queue job cannot double-apply.
      const endpointName = `INBOUND ${event.event_type}`;
      const requestHash = this.idempotency.hashPayload({
        endpointName,
        connectionId,
        externalId: event.external_id,
        payload: event.payload ?? {},
      });
      const begin = await this.idempotency.begin(
        tenantId,
        connectionId,
        `inbound:${event.id}`,
        endpointName,
        requestHash,
      );
      if (begin.replay) {
        await this.finish(event, INBOUND_STATUS.PROCESSED, null, null, null);
        return;
      }

      let result;
      try {
        result = await this.upsert.upsertOne(
          tenantId,
          event.resource_type as IntegrationResource,
          connectionId,
          policy,
          event.external_id as string,
          applyPayload,
          { userId },
          { safe: false, lifecycle },
        );
      } catch (err) {
        await this.idempotency.fail(begin.recordId);
        throw err;
      }

      await this.idempotency.complete(begin.recordId, 200, {
        outcome: result.outcome,
        externalId: result.externalId,
        internalId: result.internalId,
      });

      const status =
        result.outcome === UPSERT_OUTCOME.CONFLICTED ? INBOUND_STATUS.CONFLICTED : INBOUND_STATUS.PROCESSED;
      await this.finish(event, status, null, result.outcome, result.internalId);
      await this.connections.markSuccess(connectionId);
    } catch (err) {
      const message = (err as Error)?.message ?? 'Inbound event processing failed';
      if (event.attempts >= MAX_INBOUND_ATTEMPTS) {
        // Out of retries — park it as failed WITH its reason, and drop the
        // staged payload. It is visible in history; nothing disappears silently.
        await this.finish(event, INBOUND_STATUS.FAILED, message, null, null);
        if (connectionId) await this.connections.markError(connectionId, message);
        return;
      }
      // Retryable: keep the payload and let BullMQ back off and redeliver.
      event.status = INBOUND_STATUS.ACCEPTED;
      event.error_summary = message.slice(0, 500);
      await this.events.save(event);
      throw err;
    }
  }

  /**
   * Re-enqueue events left un-processed by a dead worker (a row stuck
   * `PROCESSING`, or `ACCEPTED` past the point the outbox relay should have
   * picked it up). NOTE (Phase 0): `receive()` no longer has an enqueue-failure
   * path — see the identical note on `IntegrationImportJobService.recoverStale`.
   * Scheduled every 2 minutes by IntegrationRecoveryProcessor.
   */
  async recoverStale(olderThanMs = 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.events.find({
      where: {
        status: In([INBOUND_STATUS.ACCEPTED, INBOUND_STATUS.PROCESSING]),
        updated_at: LessThan(cutoff),
      },
      relations: { tenant: true },
      take: 100,
    });
    let requeued = 0;
    for (const e of stale) {
      await this.queue
        .enqueueIntegrationInbound({ tenantId: (e.tenant as Tenant)?.id ?? null, inboundEventId: e.id })
        .then(() => (requeued += 1))
        .catch(() => undefined);
    }
    return requeued;
  }

  /** Retention sweep — history (and its replay guard) is bounded. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - INBOUND_EVENT_RETENTION_DAYS * 24 * 3600 * 1000);
    const res = await this.events
      .createQueryBuilder()
      .delete()
      .from(IntegrationInboundEvent)
      .where('received_at < :cutoff', { cutoff })
      .andWhere('status IN (:...terminal)', { terminal: TERMINAL_INBOUND_STATUSES })
      .execute()
      .catch(() => ({ affected: 0 } as { affected?: number | null }));
    return res.affected ?? 0;
  }

  // ── History (tenant-facing) ───────────────────────────────────────────────

  async list(tenantId: string, query: QueryInboundEventsDto) {
    const where: FindOptionsWhere<IntegrationInboundEvent> = { tenant: { id: tenantId } };
    if (query.connectionId) where.connection = { id: query.connectionId };
    if (query.status) where.status = query.status;
    if (query.eventType) where.event_type = query.eventType;
    if (query.externalId) where.external_id = query.externalId;

    const [rows, total] = await this.events.findAndCount({
      where,
      relations: { connection: true },
      order: { received_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data: rows.map((e) => this.toView(e)), total, page: query.page, limit: query.limit };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Pure authentication verdict for one delivery: `null` when the signature and
   * timestamp are valid, otherwise the rejection code. No I/O.
   */
  private authenticate(
    endpoint: IntegrationWebhookEndpoint,
    scheme: WebhookSignatureScheme,
    h: ReturnType<typeof readInboundHeaders>,
    rawBody: string,
    headers: InboundHeaders,
  ): InboundRejection | null {
    if (!h.signature) return INBOUND_REJECTION.MISSING_SIGNATURE;
    // v2 signs the event id and type, so both headers are mandatory — say which
    // is missing rather than reporting a bare "invalid signature". (A provider
    // adapter that owns verification has its own scheme; this does not apply.)
    if (scheme === WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED_V2 && !this.hasAdapterVerifier(endpoint)) {
      if (!h.eventId) return INBOUND_REJECTION.MISSING_EVENT_ID;
      if (!h.eventType) return INBOUND_REJECTION.MISSING_EVENT_TYPE;
    }
    const secret = this.endpoints.secretOf(endpoint);
    if (!secret || !this.verifySignature(endpoint, scheme, secret, h, rawBody, headers)) {
      return INBOUND_REJECTION.INVALID_SIGNATURE;
    }
    // Replay window — a stale or far-future timestamp is refused even with a
    // valid MAC, because the timestamp is bound INTO the MAC.
    const verdict = verifyTimestamp(scheme, h.timestamp, endpoint.tolerance_seconds);
    if (verdict === 'ok') return null;
    return verdict === 'stale'
      ? INBOUND_REJECTION.STALE_TIMESTAMP
      : verdict === 'future'
        ? INBOUND_REJECTION.FUTURE_TIMESTAMP
        : INBOUND_REJECTION.MISSING_TIMESTAMP;
  }

  /** Provider adapter verification when it defines one; otherwise the compiled scheme. */
  private verifySignature(
    endpoint: IntegrationWebhookEndpoint,
    scheme: WebhookSignatureScheme,
    secret: string,
    h: ReturnType<typeof readInboundHeaders>,
    rawBody: string,
    headers: InboundHeaders,
  ): boolean {
    const providerKey = (endpoint.connection as IntegrationConnection | undefined)?.provider;
    const adapter = providerKey ? resolveProviderAdapter(providerKey) : undefined;
    // A provider adapter may implement its own verification — but only from
    // COMPILED adapter code. A tenant can never supply a verifier.
    if (adapter?.verifyWebhook) {
      return adapter.verifyWebhook(headers, rawBody, secret);
    }
    return verifyInboundSignature(scheme, secret, h.timestamp, rawBody, h.signature as string, {
      eventId: h.eventId,
      eventType: h.eventType,
    });
  }

  /** True when the endpoint's provider adapter supplies its own verifier. */
  private hasAdapterVerifier(endpoint: IntegrationWebhookEndpoint): boolean {
    const providerKey = (endpoint.connection as IntegrationConnection | undefined)?.provider;
    return !!(providerKey && resolveProviderAdapter(providerKey)?.verifyWebhook);
  }

  /**
   * Narrow an inbound payload to what may be staged: the resource's allowlisted
   * writable fields (protected fields throw) plus the compiled read-only hints.
   * Nothing else is persisted.
   */
  private stagePayload(
    resource: IntegrationResource,
    data: unknown,
    action?: 'reschedule' | 'cancel',
  ): Record<string, unknown> {
    const raw = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    const { clean } = sanitizeExternalInput(resource, raw); // throws on protected fields
    const staged: Record<string, unknown> = { ...clean };
    for (const hint of SAFE_INBOUND_HINTS) {
      if (raw[hint] !== undefined) staged[hint] = raw[hint];
    }
    // The EVENT TYPE decides the lifecycle action, never the caller's own field.
    if (action) staged.action = action;
    return staged;
  }

  /** Terminal transition: record the outcome and DROP the staged payload. */
  private async finish(
    event: IntegrationInboundEvent,
    status: string,
    error: string | null,
    outcome: string | null,
    internalId: string | null,
  ): Promise<void> {
    event.status = status;
    event.payload = null; // history keeps only safe metadata
    event.processed_at = new Date();
    if (error) event.error_summary = error.slice(0, 500);
    if (outcome) event.upsert_outcome = outcome;
    if (internalId) event.internal_resource_id = internalId;
    await this.events.save(event);
  }

  /**
   * Refused before authentication: no history row (an unauthenticated caller must
   * not be able to write to a tenant's table), but counted + audited.
   */
  private async rejectUnauthenticated(
    endpoint: IntegrationWebhookEndpoint,
    tenantId: string,
    reason: InboundRejection,
    ip?: string,
  ): Promise<never> {
    await this.endpoints.recordOutcome(endpoint.id, false, reason);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.WEBHOOK_REJECTED,
      tenantId,
      'IntegrationWebhookEndpoint',
      endpoint.id,
      { ip },
      { reason, authenticated: false },
    );
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: 'Webhook delivery rejected',
      publicContext: { reason },
    });
  }

  /** Refused after a valid signature: recorded in history so the partner can fix it. */
  private async rejectAuthenticated(
    endpoint: IntegrationWebhookEndpoint,
    tenantId: string,
    connectionId: string,
    eventId: string | null,
    eventType: string | null,
    reason: InboundRejection,
    ip?: string,
  ): Promise<never> {
    await this.events
      .save(
        this.events.create({
          tenant: { id: tenantId } as Tenant,
          endpoint: { id: endpoint.id } as IntegrationWebhookEndpoint,
          connection: { id: connectionId } as IntegrationConnection,
          provider_event_id: eventId ?? `rejected:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
          event_type: (eventType ?? 'unknown').slice(0, 60),
          status: INBOUND_STATUS.REJECTED,
          rejection_reason: reason,
          payload: null, // nothing from a rejected delivery is ever persisted
        }),
      )
      .catch((e) => this.logger.warn(`inbound rejection record failed: ${(e as Error)?.message}`));

    await this.endpoints.recordOutcome(endpoint.id, false, reason);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.WEBHOOK_REJECTED,
      tenantId,
      'IntegrationInboundEvent',
      endpoint.id,
      { ip },
      { reason, authenticated: true, connectionId, eventType },
    );
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message: 'Webhook delivery rejected',
      publicContext: { reason },
    });
  }

  /** Safe projection — ids, codes and counters. NEVER the staged payload. */
  private toView(e: IntegrationInboundEvent) {
    return {
      id: e.id,
      connectionId: e.connection?.id ?? null,
      providerEventId: e.provider_event_id,
      eventType: e.event_type,
      resourceType: e.resource_type ?? null,
      externalId: e.external_id ?? null,
      status: e.status,
      rejectionReason: e.rejection_reason ?? null,
      upsertOutcome: e.upsert_outcome ?? null,
      internalResourceId: e.internal_resource_id ?? null,
      attempts: e.attempts,
      errorSummary: e.error_summary ?? null,
      receivedAt: e.received_at,
      processedAt: e.processed_at ?? null,
    };
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
