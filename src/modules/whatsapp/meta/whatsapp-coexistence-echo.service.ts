import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Message } from '../../../entities/Conversations/Message';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';

import { WhatsappInboundAiService } from '../whatsapp-inbound-ai.service';
import { ConversationExecutionService } from '../../conversations/conversation-execution.service';
import type {
  MetaWebhookChangeValue,
  MetaWebhookMessage,
} from '../webhooks/whatsapp-webhook.types';
import {
  extractMessageEchoes,
  resolveEchoRecipientWaId,
} from '../webhooks/coexistence-webhook.adapter';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Coexistence `smb_message_echoes` — a message the clinic staff sent from
 * the native WhatsApp Business App (NOT through ZiyaraTech). Mirrors it onto
 * the unified Conversation/Message timeline so agents see the full
 * back-and-forth, without ever touching the AI/patient-inbound pipeline:
 *
 *  - `sender_type: 'AGENT'`, never `'CUSTOMER'` — an echo is never routed
 *    through `WhatsappInboundAiService.handleInboundValue` (different webhook
 *    field, different processEvent branch — see WhatsappWebhookService), so
 *    it can never trigger a bot reply, opt-out handling, or a booking turn.
 *  - Tenant isolation is inherited, not re-derived: `WhatsappWebhookService`
 *    already resolved `tenantId` from the webhook's own trusted
 *    `metadata.phone_number_id` → account lookup before this runs.
 *  - Deduplication is two layers: the webhook-log idempotency key
 *    (`echo:{wamid}`, `WhatsappWebhookService.deriveIdempotencyKey`) stops a
 *    REDELIVERED event from reaching here twice; the `wa_message_id` check +
 *    the partial UNIQUE `messages(tenantId, wa_message_id)` index (caught
 *    below) additionally stop two DIFFERENT webhook deliveries that happen
 *    to embed the same echo.
 *  - Fails soft per echo (like `WhatsappInboundAiService.handleInboundValue`):
 *    one bad/unattributable echo must not lose the rest of the batch, and
 *    must never fail the webhook worker job.
 */
@Injectable()
export class WhatsappCoexistenceEchoService {
  private readonly logger = new Logger('WhatsappCoexistenceEchoService');

  constructor(
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly inboundContacts: WhatsappInboundAiService,
    private readonly timeline: ConversationExecutionService,
  ) {}

  async handleEchoes(
    tenantId: string,
    value: MetaWebhookChangeValue,
  ): Promise<void> {
    const echoes = extractMessageEchoes(value);
    for (const echo of echoes) {
      await this.handleOne(tenantId, value, echo).catch((err) =>
        this.logger.error(
          `smb_message_echo handling failed (tenant=${tenantId}, id=${echo.id ?? 'unknown'}): ${(err as Error)?.message}`,
        ),
      );
    }
  }

  private async handleOne(
    tenantId: string,
    value: MetaWebhookChangeValue,
    echo: MetaWebhookMessage,
  ): Promise<void> {
    if (!echo.id) {
      this.logger.warn(
        `smb_message_echo with no wamid (tenant=${tenantId}) — cannot dedupe safely, skipping`,
      );
      return;
    }

    const existing = await this.messages.findOne({
      where: { tenant: { id: tenantId }, wa_message_id: echo.id },
    });
    if (existing) return; // already mirrored by an earlier delivery

    const content = this.inboundContacts.extractContent(echo);
    if (!content) {
      this.logger.debug(
        `smb_message_echo ${echo.id} had no renderable content (tenant=${tenantId})`,
      );
      return;
    }

    const waId = resolveEchoRecipientWaId(value, echo);
    if (!waId) {
      this.logger.warn(
        `smb_message_echo ${echo.id} has no attributable recipient (tenant=${tenantId}) — skipping`,
      );
      return;
    }

    const phoneNumberId = value.metadata?.phone_number_id;
    const account = phoneNumberId
      ? await this.accounts.findOne({
          where: {
            phone_number_id: phoneNumberId,
            tenant: { id: tenantId },
            deleted_at: IsNull(),
          },
        })
      : null;
    if (!account) {
      this.logger.warn(
        `smb_message_echo ${echo.id} carried no resolvable connected account (tenant=${tenantId}) — skipping`,
      );
      return;
    }

    // Same contact/customer resolution the patient-inbound path uses — one
    // WhatsApp identity per (tenant, wa_id) regardless of which side sent.
    const contact = await this.inboundContacts.findOrCreateContact(
      tenantId,
      waId,
    );
    if (!contact.customer?.id) return;

    const conversation = await this.timeline.findOrCreateForWhatsapp(
      tenantId,
      contact.customer.id,
      account.id,
    );

    try {
      await this.timeline.recordChannelMessage(
        tenantId,
        conversation.id,
        'AGENT',
        content,
        undefined,
        { waMessageId: echo.id, messageType: echo.type },
      );
    } catch (err) {
      // Lost a race with another concurrent delivery of the SAME echo — the
      // partial unique index (tenantId, wa_message_id) is what actually
      // serializes this; the findOne above is only a fast-path.
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) return;
      throw err;
    }
  }
}
