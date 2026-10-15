import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { NotificationDeliveryService } from './notification-delivery.service';
import { DELIVERY_STATUS, DeliveryStatus } from './notification.constants';
import { constantTimeEqual } from '../../common/utils/constant-time.util';

/**
 * Meta WhatsApp Cloud webhook for DELIVERY status updates.
 *
 *  - GET  : Meta verification handshake (hub.challenge) against WHATSAPP_VERIFY_TOKEN.
 *  - POST : signed status callbacks. Verifies `X-Hub-Signature-256` (HMAC-SHA256
 *           of the RAW body with WHATSAPP_APP_SECRET — requires `rawBody:true`,
 *           already enabled in main.ts), then maps each status to the delivery
 *           axis via NotificationDeliveryService (matched by provider_ref = wamid).
 *
 * Public (no JWT) — providers can't authenticate; the HMAC signature is the auth.
 */
@ApiExcludeController()
@Controller('webhooks/notifications/whatsapp')
export class NotificationWebhookController {

  constructor(
    private readonly config: ConfigService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  @Public()
  @Get()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (
      mode === 'subscribe' &&
      token &&
      expected &&
      constantTimeEqual(token, expected)
    ) {
      return challenge ?? '';
    }
    throw new ForbiddenException('verification failed');
  }

  @Public()
  @Post()
  async receive(@Req() req: Request): Promise<{ processed: number }> {
    this.verifySignature(req);

    const body = req.body as MetaWebhookBody;
    const statuses = this.extractStatuses(body);
    let processed = 0;
    for (const s of statuses) {
      const event = this.mapStatus(s.status);
      if (!event || !s.id) continue;
      const res = await this.delivery.recordDelivery(s.id, event);
      if (res.updated) processed += 1;
    }
    return { processed };
  }

  // ──────────────────────────── internals ──────────────────────────── //

  private verifySignature(req: Request): void {
    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) {
      // No secret configured → refuse rather than accept unverified callbacks.
      throw new ForbiddenException('webhook secret not configured');
    }
    const header = req.header('x-hub-signature-256');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!header || !raw)
      throw new BadRequestException('missing signature or raw body');

    const expected =
      'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('invalid signature');
    }
  }

  private extractStatuses(body: MetaWebhookBody): MetaStatus[] {
    const out: MetaStatus[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const st of change?.value?.statuses ?? []) out.push(st);
      }
    }
    return out;
  }

  private mapStatus(status?: string): DeliveryStatus | null {
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
}

interface MetaStatus {
  id?: string; // wamid (our provider_ref)
  status?: string; // sent | delivered | read | failed
  recipient_id?: string;
}
interface MetaWebhookBody {
  entry?: { changes?: { value?: { statuses?: MetaStatus[] } }[] }[];
}
