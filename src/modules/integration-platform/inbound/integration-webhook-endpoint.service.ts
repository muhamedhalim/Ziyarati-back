import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';

import { IntegrationWebhookEndpoint } from '../../../entities/Integration/IntegrationWebhookEndpoint';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';

import {
  DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
  INBOUND_EVENTS,
  WEBHOOK_ENDPOINT_STATUS,
  WEBHOOK_MAX_TOLERANCE_SECONDS,
  WEBHOOK_SIGNATURE_SCHEMES,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '../integration-platform.constants';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from '../dto/webhook-endpoint.dto';

interface Actor {
  userId?: string;
  ip?: string;
}

/** Length of a generated signing secret, in random bytes (→ 64 hex chars). */
const SECRET_BYTES = 32;

/**
 * Inbound webhook endpoint management (Phase 4).
 *
 * One endpoint per connection. The signing secret is generated HERE (never
 * accepted from a client, so it always has full entropy), stored encrypted, and
 * returned in PLAINTEXT EXACTLY ONCE — at creation and at rotation. Every later
 * read exposes only a short prefix. The event allowlist is validated against the
 * compiled INBOUND_EVENTS set, and the signature scheme against the compiled
 * scheme list, so neither can ever carry tenant-supplied behaviour.
 */
@Injectable()
export class IntegrationWebhookEndpointService {
  private readonly logger = new Logger(IntegrationWebhookEndpointService.name);

  constructor(
    @InjectRepository(IntegrationWebhookEndpoint)
    private readonly repo: Repository<IntegrationWebhookEndpoint>,
    private readonly encryption: EncryptionService,
    private readonly connections: IntegrationConnectionService,
    private readonly audit: IntegrationAuditService,
  ) {}

  /**
   * Create the endpoint for a connection. Returns the plaintext secret ONCE —
   * the caller must show it to the user immediately; it is unrecoverable after.
   */
  async create(tenantId: string, dto: CreateWebhookEndpointDto, actor: Actor) {
    // The connection must exist and belong to this tenant. A DISCONNECTED
    // connection cannot receive inbound events, so it cannot own an endpoint.
    await this.connections.requireActive(tenantId, dto.connectionId);

    const events = this.assertEvents(dto.allowedEvents);
    const scheme = this.assertScheme(dto.signatureScheme);
    const tolerance = this.assertTolerance(dto.toleranceSeconds);
    const secret = this.generateSecret();

    let saved: IntegrationWebhookEndpoint;
    try {
      saved = await this.repo.save(
        this.repo.create({
          tenant: { id: tenantId } as Tenant,
          connection: { id: dto.connectionId } as IntegrationConnection,
          status: WEBHOOK_ENDPOINT_STATUS.ACTIVE,
          secret_ciphertext: this.encryption.encrypt(secret),
          secret_prefix: secret.slice(0, 12),
          secret_rotated_at: new Date(),
          signature_scheme: scheme,
          allowed_events: events,
          tolerance_seconds: tolerance,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'This connection already has an inbound webhook endpoint',
        });
      }
      throw err;
    }

    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.WEBHOOK_ENDPOINT_CREATE,
      tenantId,
      'IntegrationWebhookEndpoint',
      saved.id,
      actor,
      { connectionId: dto.connectionId, signatureScheme: scheme, allowedEvents: events, toleranceSeconds: tolerance },
    );

    // Show-once secret. Never returned again by any other method.
    return { ...this.toView(saved), secret };
  }

  async list(tenantId: string) {
    const rows = await this.repo.find({
      where: { tenant: { id: tenantId } },
      relations: { connection: true },
      order: { created_at: 'DESC' },
    });
    return { data: rows.map((r) => this.toView(r)), total: rows.length };
  }

  async get(tenantId: string, id: string) {
    return this.toView(await this.findOrThrow(tenantId, id));
  }

  async update(tenantId: string, id: string, dto: UpdateWebhookEndpointDto, actor: Actor) {
    const e = await this.findOrThrow(tenantId, id);
    if (dto.allowedEvents !== undefined) e.allowed_events = this.assertEvents(dto.allowedEvents);
    if (dto.signatureScheme !== undefined) e.signature_scheme = this.assertScheme(dto.signatureScheme);
    if (dto.toleranceSeconds !== undefined) e.tolerance_seconds = this.assertTolerance(dto.toleranceSeconds);
    if (dto.active !== undefined) {
      e.status = dto.active ? WEBHOOK_ENDPOINT_STATUS.ACTIVE : WEBHOOK_ENDPOINT_STATUS.INACTIVE;
    }
    const saved = await this.repo.save(e);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.WEBHOOK_ENDPOINT_UPDATE,
      tenantId,
      'IntegrationWebhookEndpoint',
      id,
      actor,
      {
        allowedEvents: dto.allowedEvents ?? null,
        signatureScheme: dto.signatureScheme ?? null,
        toleranceSeconds: dto.toleranceSeconds ?? null,
        active: dto.active ?? null,
      },
    );
    return this.toView(saved);
  }

  /** Rotate the signing secret. Returns the new plaintext ONCE. */
  async rotateSecret(tenantId: string, id: string, actor: Actor) {
    const e = await this.findOrThrow(tenantId, id);
    const secret = this.generateSecret();
    e.secret_ciphertext = this.encryption.encrypt(secret);
    e.secret_prefix = secret.slice(0, 12);
    e.secret_rotated_at = new Date();
    const saved = await this.repo.save(e);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.WEBHOOK_SECRET_ROTATE,
      tenantId,
      'IntegrationWebhookEndpoint',
      id,
      actor,
    );
    return { ...this.toView(saved), secret };
  }

  async remove(tenantId: string, id: string, actor: Actor): Promise<{ deleted: true }> {
    const e = await this.findOrThrow(tenantId, id);
    // Delivery history survives: `integration_inbound_events.endpoint` is SET NULL.
    await this.repo.delete({ id: e.id });
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.WEBHOOK_ENDPOINT_DELETE,
      tenantId,
      'IntegrationWebhookEndpoint',
      id,
      actor,
    );
    return { deleted: true };
  }

  // ── Receiver-side helpers (no tenant context — the URL identifies it) ──────

  /**
   * Look up the endpoint for an inbound delivery by connection id ALONE. The
   * tenant is taken from the row, never from the request, so a caller cannot
   * address another tenant's connection by guessing a tenant id.
   */
  findByConnectionId(connectionId: string): Promise<IntegrationWebhookEndpoint | null> {
    return this.repo.findOne({
      where: { connection: { id: connectionId } },
      relations: { tenant: true, connection: { tenant: true } },
    });
  }

  /** Decrypt the signing secret for verification. In memory, for one call only. */
  secretOf(endpoint: IntegrationWebhookEndpoint): string | null {
    try {
      return this.encryption.decrypt(endpoint.secret_ciphertext);
    } catch {
      return null;
    }
  }

  /** Best-effort counters for the endpoint health view. Never throws. */
  async recordOutcome(id: string, accepted: boolean, reason?: string | null): Promise<void> {
    const patch = accepted
      ? { accepted_count: () => '"accepted_count" + 1', last_accepted_at: new Date() }
      : {
          rejected_count: () => '"rejected_count" + 1',
          last_rejected_at: new Date(),
          last_rejection_reason: reason ?? null,
        };
    await this.repo
      .createQueryBuilder()
      .update(IntegrationWebhookEndpoint)
      .set(patch as never)
      .where('id = :id', { id })
      .execute()
      .catch(() => undefined);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private generateSecret(): string {
    return randomBytes(SECRET_BYTES).toString('hex');
  }

  private assertEvents(events: string[] | undefined): string[] {
    const list = events ?? [];
    if (list.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Select at least one event type for this endpoint',
      });
    }
    const unknown = list.filter((e) => !INBOUND_EVENTS.includes(e as never));
    if (unknown.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Unsupported event type',
        publicContext: { unsupported: unknown.sort(), supported: INBOUND_EVENTS },
      });
    }
    return [...new Set(list)];
  }

  private assertScheme(scheme: string | undefined): string {
    // New endpoints default to v2, which signs the event id and type (SEC-01).
    const value = scheme ?? DEFAULT_WEBHOOK_SIGNATURE_SCHEME;
    if (!WEBHOOK_SIGNATURE_SCHEMES.includes(value as never)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Unsupported signature scheme' });
    }
    return value;
  }

  private assertTolerance(seconds: number | undefined): number {
    const value = seconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
    if (!Number.isFinite(value) || value < 30 || value > WEBHOOK_MAX_TOLERANCE_SECONDS) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Replay tolerance must be between 30 and ${WEBHOOK_MAX_TOLERANCE_SECONDS} seconds`,
      });
    }
    return Math.floor(value);
  }

  private async findOrThrow(tenantId: string, id: string): Promise<IntegrationWebhookEndpoint> {
    const e = await this.repo.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { connection: true },
    });
    if (!e) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Webhook endpoint not found' });
    return e;
  }

  /** Safe projection — NEVER the secret ciphertext or plaintext. */
  private toView(e: IntegrationWebhookEndpoint) {
    return {
      id: e.id,
      connectionId: e.connection?.id ?? null,
      status: e.status,
      /** Relative path the external system posts to (no host — env-dependent). */
      path: `/integrations/inbound/${e.connection?.id ?? ''}`,
      signatureScheme: e.signature_scheme,
      allowedEvents: e.allowed_events ?? [],
      toleranceSeconds: e.tolerance_seconds,
      secretPrefix: e.secret_prefix,
      secretRotatedAt: e.secret_rotated_at ?? null,
      counts: { accepted: e.accepted_count, rejected: e.rejected_count },
      lastAcceptedAt: e.last_accepted_at ?? null,
      lastRejectedAt: e.last_rejected_at ?? null,
      lastRejectionReason: e.last_rejection_reason ?? null,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    };
  }
}
