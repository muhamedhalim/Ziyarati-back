import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';

import { WebhookEndpoint } from '../../entities/System/WebhookEndpoint';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { EncryptionService } from '../../common/crypto/encryption.service';

import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { QueryWebhookEndpointsDto } from './dto/query-webhook-endpoints.dto';
import { generateWebhookSecret, normalizeWebhookEvents, webhookSecretPrefix } from './webhook.constants';
import { assertSafeWebhookUrl } from './webhook-url-guard';
import { WebhookAuditService, WEBHOOK_AUDIT_ACTION } from './webhook-audit.service';

/** Webhook endpoint with the secret ciphertext stripped — the shape returned to clients. */
export type SafeWebhookEndpoint = Omit<WebhookEndpoint, 'secret_ciphertext'>;

export interface WebhookActor {
  userId?: string;
  ip?: string;
}

/**
 * Tenant-owned outbound webhook endpoints (Phase 2 — Integration platform).
 *
 * Tenant isolation: every query filters `where: { tenant: { id: tenantId } }`.
 * The signing secret is stored ENCRYPTED (EncryptionService, reversible — see
 * WebhookEndpoint entity docstring for why, unlike ApiKey's one-way hash) and
 * returned in PLAINTEXT exactly once, at create/rotate. `secret_ciphertext`
 * is never serialized to any client response.
 *
 * Every mutating method records a best-effort audit row (WebhookAuditService).
 */
@Injectable()
export class WebhookEndpointService {
  private readonly logger = new Logger('WebhookEndpointService');

  constructor(
    @InjectRepository(WebhookEndpoint)
    private readonly endpoints: Repository<WebhookEndpoint>,
    private readonly encryption: EncryptionService,
    private readonly audit: WebhookAuditService,
  ) {}

  async create(
    tenantId: string,
    dto: CreateWebhookEndpointDto,
    actor: WebhookActor,
  ): Promise<SafeWebhookEndpoint & { secret: string }> {
    assertSafeWebhookUrl(dto.url);
    const events = normalizeWebhookEvents(dto.events);
    if (events.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'At least one valid event must be selected',
      });
    }

    const plaintext = generateWebhookSecret();
    const saved = await this.endpoints.save(
      this.endpoints.create({
        tenant: { id: tenantId } as Tenant,
        name: dto.name,
        url: dto.url,
        secret_ciphertext: this.encryption.encrypt(plaintext),
        secret_prefix: webhookSecretPrefix(plaintext),
        events,
        is_active: true,
      }),
    );
    this.logger.log(`Webhook endpoint ${saved.id} created for tenant ${tenantId}`);
    await this.audit.record(
      WEBHOOK_AUDIT_ACTION.CREATE,
      tenantId,
      actor.userId,
      'WebhookEndpoint',
      saved.id,
      actor.ip,
      { name: dto.name ?? null, events, urlHost: this.safeHost(dto.url) },
    );
    return { ...this.toSafe(saved), secret: plaintext };
  }

  async list(tenantId: string, query: QueryWebhookEndpointsDto) {
    const where: FindOptionsWhere<WebhookEndpoint> = { tenant: { id: tenantId }, deleted_at: IsNull() };
    if (query.isActive !== undefined) where.is_active = query.isActive;

    const [rows, total] = await this.endpoints.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: rows.map((e) => this.toSafe(e)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async get(tenantId: string, id: string): Promise<SafeWebhookEndpoint> {
    return this.toSafe(await this.findOneOrThrow(tenantId, id));
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWebhookEndpointDto,
    actor: WebhookActor,
  ): Promise<SafeWebhookEndpoint> {
    const endpoint = await this.findOneOrThrow(tenantId, id);
    if (dto.name !== undefined) endpoint.name = dto.name;

    let urlChanged = false;
    if (dto.url !== undefined && dto.url !== endpoint.url) {
      // Re-run the exact same SSRF check used at creation — the URL is fully
      // editable, so every edit is itself a new untrusted write of attacker-
      // influenced (tenant-influenced) data.
      assertSafeWebhookUrl(dto.url);
      endpoint.url = dto.url;
      urlChanged = true;
    }

    let events: string[] | undefined;
    if (dto.events !== undefined) {
      events = normalizeWebhookEvents(dto.events);
      if (events.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message: 'At least one valid event must be selected',
        });
      }
      endpoint.events = events;
    }

    const saved = await this.endpoints.save(endpoint);
    await this.audit.record(
      WEBHOOK_AUDIT_ACTION.UPDATE,
      tenantId,
      actor.userId,
      'WebhookEndpoint',
      id,
      actor.ip,
      {
        name: dto.name ?? null,
        events: events ?? null,
        urlChanged,
        urlHost: urlChanged ? this.safeHost(dto.url!) : null,
      },
    );
    return this.toSafe(saved);
  }

  /** Issue a new signing secret for an existing endpoint. Returned once. */
  async rotateSecret(
    tenantId: string,
    id: string,
    actor: WebhookActor,
  ): Promise<SafeWebhookEndpoint & { secret: string }> {
    const endpoint = await this.findOneOrThrow(tenantId, id);
    const plaintext = generateWebhookSecret();
    endpoint.secret_ciphertext = this.encryption.encrypt(plaintext);
    endpoint.secret_prefix = webhookSecretPrefix(plaintext);
    const saved = await this.endpoints.save(endpoint);
    await this.audit.record(
      WEBHOOK_AUDIT_ACTION.ROTATE_SECRET,
      tenantId,
      actor.userId,
      'WebhookEndpoint',
      id,
      actor.ip,
    );
    return { ...this.toSafe(saved), secret: plaintext };
  }

  async setActive(
    tenantId: string,
    id: string,
    isActive: boolean,
    actor: WebhookActor,
  ): Promise<SafeWebhookEndpoint> {
    const endpoint = await this.findOneOrThrow(tenantId, id);
    endpoint.is_active = isActive;
    const saved = await this.endpoints.save(endpoint);
    await this.audit.record(
      isActive ? WEBHOOK_AUDIT_ACTION.ENABLE : WEBHOOK_AUDIT_ACTION.DISABLE,
      tenantId,
      actor.userId,
      'WebhookEndpoint',
      id,
      actor.ip,
    );
    return this.toSafe(saved);
  }

  /**
   * SOFT delete — sets `deleted_at` + `is_active = false` rather than
   * removing the row. Delivery history and audit evidence must survive an
   * endpoint's deletion; a soft-deleted endpoint behaves as 404 to every
   * tenant-facing read (`findOneOrThrow`/`list` both filter it out) and stops
   * receiving deliveries immediately (same `is_active` check the processor
   * already uses to skip disabled endpoints).
   */
  async remove(tenantId: string, id: string, actor: WebhookActor): Promise<{ deleted: true }> {
    const endpoint = await this.findOneOrThrow(tenantId, id);
    endpoint.deleted_at = new Date();
    endpoint.is_active = false;
    await this.endpoints.save(endpoint);
    await this.audit.record(
      WEBHOOK_AUDIT_ACTION.DELETE,
      tenantId,
      actor.userId,
      'WebhookEndpoint',
      id,
      actor.ip,
      { name: endpoint.name ?? null, urlHost: this.safeHost(endpoint.url) },
    );
    return { deleted: true };
  }

  /**
   * Internal accessor for the delivery pipeline: loads an ACTIVE endpoint with
   * its decrypted secret. Never exposed via a controller response.
   */
  async findActiveWithSecret(
    id: string,
  ): Promise<{ endpoint: WebhookEndpoint; secret: string } | null> {
    const endpoint = await this.endpoints.findOne({
      where: { id },
      relations: { tenant: true },
    });
    if (!endpoint || !endpoint.is_active) return null;
    return { endpoint, secret: this.encryption.decrypt(endpoint.secret_ciphertext) };
  }

  /** Active endpoints for a tenant subscribed to a given event — used by WebhookEventListener. */
  async findActiveSubscribers(tenantId: string, eventType: string): Promise<WebhookEndpoint[]> {
    const rows = await this.endpoints.find({ where: { tenant: { id: tenantId }, is_active: true } });
    return rows.filter((e) => Array.isArray(e.events) && e.events.includes(eventType));
  }

  private async findOneOrThrow(tenantId: string, id: string): Promise<WebhookEndpoint> {
    const endpoint = await this.endpoints.findOne({
      where: { id, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!endpoint) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Webhook endpoint not found' });
    }
    return endpoint;
  }

  /** Strip the secret ciphertext before returning an endpoint to any client. */
  private toSafe(endpoint: WebhookEndpoint): SafeWebhookEndpoint {
    const { secret_ciphertext, ...safe } = endpoint;
    void secret_ciphertext;
    return safe;
  }

  /** Host only (no path/query) — safe to log/audit without leaking URL secrets some tenants embed in query strings. */
  private safeHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return 'invalid-url';
    }
  }
}
