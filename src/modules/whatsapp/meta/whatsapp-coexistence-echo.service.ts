import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Message } from '../../../entities/Conversations/Message';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';

import { WhatsappInboundAiService } from '../whatsapp-inbound-ai.service';
import { ConversationExecutionService } from '../../conversations/conversation-execution.service';
import { ConversationAiTakeoverService } from '../../conversations/conversation-ai-takeover.service';
import type {
  MetaWebhookChangeValue,
  MetaWebhookMessage,
} from '../webhooks/whatsapp-webhook.types';
import {
  extractMessageEchoes,
  resolveEchoRecipientWaId,
} from '../webhooks/coexistence-webhook.adapter';

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
 *    the partial UNIQUE `messages(tenantId, wa_message_id)` index (absorbed
 *    by `recordChannelMessageOnce`) additionally stop two DIFFERENT webhook
 *    deliveries that happen to embed the same echo.
 *  - A NEW echo means a person answered from the Business App, so the AI steps
 *    aside for the clinic's takeover window on that conversation (the same rule
 *    as a reply typed in the Ziyarati inbox). An echo that was already on the
 *    timeline — a redelivery, or the mirror of a message Ziyarati sent itself —
 *    does not.
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
    private readonly takeover: ConversationAiTakeoverService,
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

    // The SAME thread the patient's own messages and the AI session use: the
    // takeover below is only worth anything if it lands on the conversation the
    // AI policy will look at.
    const conversation = await this.inboundContacts.resolveThreadForContact(
      tenantId,
      contact,
      account.id,
    );

    const { created } = await this.timeline.recordChannelMessageOnce(
      tenantId,
      conversation.id,
      'AGENT',
      content,
      undefined,
      { waMessageId: echo.id, messageType: echo.type },
    );

    // A person answered from the Business App: the AI steps aside for the
    // clinic's window. Only for a message that was NEW — an echo already on the
    // timeline is either a redelivery or the mirror of a message Ziyarati sent
    // itself (its provider id is recorded), and neither is a person taking over.
    if (created) {
      await this.takeover.stampStaffReply(tenantId, conversation.id);
    }
  }
}
