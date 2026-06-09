import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { WhatsappWebhook } from '../../entities/WhatsApp/WhatsappWebhook';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { WebhookSignatureVerifier } from './webhooks/webhook-signature.verifier';
import { WhatsappWebhookEventDto } from './dto/whatsapp-webhook-event.dto';
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
  constructor(
    @InjectRepository(WhatsappWebhook)
    private readonly webhooks: Repository<WhatsappWebhook>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly verifier: WebhookSignatureVerifier,
    private readonly config: ConfigService,
  ) {}

  /** GET verification handshake — returns the challenge to echo, or null. */
  resolveChallenge(
    mode?: string,
    verifyToken?: string,
    challenge?: string,
  ): string | null {
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    return this.verifier.resolveChallenge(mode, verifyToken, challenge, expected);
  }

  /**
   * Public ingestion: verify signature, dedupe by idempotency key, resolve the
   * tenant from the payload, and persist the event (processed = false).
   */
  async ingest(
    dto: WhatsappWebhookEventDto,
    signatureHeader?: string,
  ): Promise<{ accepted: boolean; id?: string; deduplicated?: boolean }> {
    if (!this.verifier.verify(signatureHeader, dto.payload)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'Invalid webhook signature' });
    }

    if (dto.idempotencyKey) {
      const existing = await this.webhooks.findOne({
        where: { idempotency_key: dto.idempotencyKey },
      });
      if (existing) return { accepted: true, id: existing.id, deduplicated: true };
    }

    const tenant = await this.resolveTenantFromPayload(dto.payload);
    const row = this.webhooks.create({
      tenant: tenant ? ({ id: tenant } as Tenant) : undefined,
      event_type: dto.eventType,
      payload: dto.payload,
      idempotency_key: dto.idempotencyKey,
      processed: false,
    });
    const saved = await this.webhooks.save(row);
    return { accepted: true, id: saved.id };
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
   * Re-queues a webhook event for processing (architecture seam): sets
   * `processed = false`. A future worker scans unprocessed events and handles
   * them with backoff.
   */
  async retry(tenantId: string, id: string): Promise<WhatsappWebhook> {
    const row = await this.findOne(tenantId, id);
    row.processed = false;
    return this.webhooks.save(row);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Best-effort tenant resolution from a Meta webhook payload. */
  private async resolveTenantFromPayload(
    payload: Record<string, unknown> | undefined,
  ): Promise<string | undefined> {
    const phoneNumberId = this.extractPhoneNumberId(payload);
    if (!phoneNumberId) return undefined;
    const account = await this.accounts.findOne({
      where: { phone_number_id: phoneNumberId },
      relations: { tenant: true },
    });
    return account?.tenant?.id;
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
}
