import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import type {
  MetaWebhookChangeValue,
  MetaWebhookMessage,
} from './webhooks/whatsapp-webhook.types';

/**
 * WhatsApp inbound → AI automation bridge (Feature 3).
 *
 * When an inbound WhatsApp `messages` event is received (tenant already resolved
 * from the phone number id), this drives it through the SAME cross-channel AI
 * pipeline the website and dashboard use:
 *
 *   inbound message → resolve/create contact → resolve the contact's SINGLE AI
 *   conversation → AiOrchestratorService.handle (WHATSAPP channel) → reply via
 *   the WhatsApp Cloud API session message.
 *
 * It owns NO AI logic: RAG, tool-calling (discovery + booking), agent routing,
 * long-term memory and usage/cost metering all stay in AiExecutionService /
 * AiOrchestratorService. Binding the conversation to the contact keeps history,
 * session, memory and agent consistent across every inbound turn from a number.
 *
 * Fails soft: any error is logged and swallowed so a bad turn never breaks the
 * webhook (Meta only needs a fast 200) or blocks later messages.
 */
@Injectable()
export class WhatsappInboundAiService {
  private readonly logger = new Logger('WhatsappInboundAiService');

  constructor(
    @InjectRepository(WhatsappContact)
    private readonly contacts: Repository<WhatsappContact>,
    private readonly orchestrator: AiOrchestratorService,
    private readonly messaging: WhatsappMessagingService,
    private readonly router: WhatsappMessageRouter,
  ) {}

  /** Process the inbound messages in a resolved Meta change value. */
  async handleInboundValue(tenantId: string, value: MetaWebhookChangeValue): Promise<void> {
    const messages = value?.messages ?? [];
    for (const message of messages) {
      await this.handleOne(tenantId, value, message).catch((err) =>
        this.logger.error(`inbound AI turn failed: ${(err as Error)?.message}`),
      );
    }
  }

  private async handleOne(
    tenantId: string,
    value: MetaWebhookChangeValue,
    message: MetaWebhookMessage,
  ): Promise<void> {
    const waId = message.from?.replace(/[^\d]/g, '');
    if (!waId) return;

    const content = this.extractContent(message);
    if (!content) {
      this.logger.debug(`inbound ${message.type ?? 'unknown'} from ${waId} had no actionable content`);
      return;
    }

    const displayName = value?.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
    const contact = await this.findOrCreateContact(tenantId, waId, displayName);

    // Continue the contact's single conversation (shared history/session/memory/
    // agent). First inbound turn has none → the orchestrator creates + routes one.
    const result = await this.orchestrator.handle(tenantId, {
      channel: 'WHATSAPP',
      content,
      aiConversationId: contact.ai_conversation_id ?? undefined,
      autoRoute: Boolean(contact.ai_conversation_id),
      useMemory: true,
    });

    if (!contact.ai_conversation_id && result.aiConversationId) {
      contact.ai_conversation_id = result.aiConversationId;
      await this.contacts.save(contact);
    }

    const reply = result.reply?.content?.trim();
    if (reply) await this.sendReply(tenantId, waId, reply);
  }

  /** Send the AI reply back over WhatsApp as a free-form session text message. */
  private async sendReply(tenantId: string, to: string, text: string): Promise<void> {
    let accountId = 'platform-env';
    let phoneNumberId: string | undefined;
    let mode: string | undefined;
    try {
      const account = await this.router.resolveForSend(tenantId, {});
      accountId = account.id ?? 'platform-env';
      phoneNumberId = account.phoneNumberId;
      mode = account.mode;
    } catch (err) {
      this.logger.warn(`reply account resolution failed, using env fallback: ${(err as Error)?.message}`);
    }

    const res = await this.messaging.sendSession({ tenantId, accountId, phoneNumberId, mode, to, text });
    if (!res.success) this.logger.warn(`WhatsApp reply send failed: ${res.error}`);
  }

  private async findOrCreateContact(
    tenantId: string,
    waId: string,
    displayName?: string,
  ): Promise<WhatsappContact> {
    const existing = await this.contacts.findOne({
      where: { wa_id: waId, tenant: { id: tenantId } },
    });
    if (existing) {
      if (displayName && !existing.display_name) {
        existing.display_name = displayName;
        await this.contacts.save(existing);
      }
      return existing;
    }
    return this.contacts.save(
      this.contacts.create({
        tenant: { id: tenantId } as Tenant,
        wa_id: waId,
        display_name: displayName,
      }),
    );
  }

  /**
   * Flatten a Meta inbound message into the text the AI turns on. Interactive
   * replies (tapped buttons / selected list rows) become their title so the
   * model sees the user's choice; media/location/voice become a descriptor so
   * the AI can respond helpfully (native STT/OCR is a provider add-on).
   */
  private extractContent(message: MetaWebhookMessage): string | undefined {
    switch (message.type) {
      case 'text':
        return message.text?.body?.trim() || undefined;
      case 'interactive': {
        const i = message.interactive;
        const picked = i?.button_reply?.title ?? i?.list_reply?.title;
        return picked?.trim() || undefined;
      }
      case 'button':
        return message.button?.text?.trim() || undefined;
      case 'image':
        return message.image?.caption?.trim() || '[The user sent an image.]';
      case 'document':
        return (
          message.document?.caption?.trim() ||
          `[The user sent a document${message.document?.filename ? `: ${message.document.filename}` : ''}.]`
        );
      case 'audio':
        return message.audio?.voice ? '[The user sent a voice message.]' : '[The user sent an audio message.]';
      case 'video':
        return message.video?.caption?.trim() || '[The user sent a video.]';
      case 'location': {
        const l = message.location;
        if (l?.latitude == null || l?.longitude == null) return '[The user shared a location.]';
        const label = l.name ?? l.address ?? `${l.latitude},${l.longitude}`;
        return `[The user shared a location: ${label}]`;
      }
      default:
        return undefined;
    }
  }
}
