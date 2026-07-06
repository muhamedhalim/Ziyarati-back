import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { CustomerService } from '../crm/customer.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WhatsappBotActorService } from './whatsapp-bot-actor.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import type {
  WhatsappListSection,
  WhatsappSessionPayload,
} from './providers/whatsapp-message.provider.interface';
import type {
  MetaWebhookChangeValue,
  MetaWebhookMessage,
} from './webhooks/whatsapp-webhook.types';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * WhatsApp inbound → AI automation bridge (Feature 3), driven by the tenant's
 * dedicated AI Bot Actor (Feature: WhatsApp Bot Actor).
 *
 * When an inbound WhatsApp `messages` event is received (tenant already resolved
 * from the phone number id), this drives it through the SAME cross-channel AI
 * pipeline the website and dashboard use:
 *
 *   inbound message → resolve/create WhatsApp contact + linked CRM customer →
 *   restore the tenant's AI Bot Actor as the real authenticated principal →
 *   AiOrchestratorService.handleStream (WHATSAPP channel, tool-calling +
 *   memory + RAG — same engine, same permission checks as every other channel)
 *   → reply via the WhatsApp Cloud API session message (text, or an
 *   interactive list when the AI's last tool call returned presentable
 *   options: clinics, branches or time slots).
 *
 * It owns NO AI logic and NO booking logic: RAG, tool-calling, agent routing,
 * long-term memory, usage/cost metering and the booking/discovery tools
 * themselves all stay in AiExecutionService / AiToolDispatchService. This
 * bridge only maps WhatsApp ⇄ orchestrator and resolves the acting identity.
 * Binding the conversation to the contact keeps history, session, memory and
 * agent consistent across every inbound turn from a number.
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
    private readonly botActor: WhatsappBotActorService,
    private readonly customers: CustomerService,
    private readonly ctx: TenantContextService,
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

    // Restore the tenant's AI Bot Actor as a REAL authenticated principal for
    // the whole turn — every downstream check (booking permission gates,
    // actorUserId on the appointment row) sees a real, auditable user instead
    // of an anonymous context, exactly as an HTTP request would.
    const bot = await this.botActor.ensureBotActor(tenantId);
    await this.ctx.run(async () => {
      this.ctx.setPrincipal(bot);
      await this.processTurn(tenantId, value, message, waId, content);
    });
  }

  private async processTurn(
    tenantId: string,
    value: MetaWebhookChangeValue,
    message: MetaWebhookMessage,
    waId: string,
    content: string,
  ): Promise<void> {
    const displayName = value?.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
    const contact = await this.findOrCreateContact(tenantId, waId, displayName);

    // Continue the contact's single conversation (shared history/session/memory/
    // agent). First inbound turn has none → the orchestrator creates + routes one.
    // `handleStream` reuses the SAME tool-capable streaming path as the website/
    // dashboard widgets (real usage accounting, no duplicated AI logic) — the
    // token deltas aren't forwarded anywhere (WhatsApp has no live-edit UX), only
    // the final assistant reply is sent.
    const result = await this.orchestrator.handleStream(
      tenantId,
      {
        channel: 'WHATSAPP',
        content,
        aiConversationId: contact.ai_conversation_id ?? undefined,
        autoRoute: Boolean(contact.ai_conversation_id),
        useMemory: true,
        sessionPatch: contact.customer?.id ? { context: { customerId: contact.customer.id } } : undefined,
      },
      () => undefined,
    );

    if (!contact.ai_conversation_id && result.aiConversationId) {
      contact.ai_conversation_id = result.aiConversationId;
      await this.contacts.save(contact);
    }

    // Live Agent Handover: the conversation is owned by a human agent — the
    // customer's message was already persisted (AI history + unified timeline)
    // by the orchestrator, but the bot must NOT reply. The assigned agent
    // replies through the Agent Inbox, which dispatches over WhatsApp itself
    // (HandoverChatService.sendAgentReply) — same channel, no duplicated send.
    if (result.handedOver) return;

    const reply = result.reply?.content?.trim();
    if (!reply) return;
    const interactive = this.buildInteractive(result.lastTool);
    await this.sendReply(tenantId, waId, reply, interactive);
  }

  /** Send the AI reply back over WhatsApp as a free-form session message. */
  private async sendReply(
    tenantId: string,
    to: string,
    text: string,
    interactive?: WhatsappSessionPayload['interactive'],
  ): Promise<void> {
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

    const res = await this.messaging.sendSession({ tenantId, accountId, phoneNumberId, mode, to, text, interactive });
    if (!res.success) this.logger.warn(`WhatsApp reply send failed: ${res.error}`);
  }

  /**
   * Renders the AI's last tool call as a tappable WhatsApp list when it
   * returned presentable options (clinics / branches / free time slots) —
   * the interactive-reply support this bridge exposes. Any other tool (or no
   * tool call this turn) falls back to plain text only.
   */
  private buildInteractive(
    lastTool: { name: string; result: Record<string, unknown> } | undefined,
  ): WhatsappSessionPayload['interactive'] | undefined {
    if (!lastTool || lastTool.result?.success === false) return undefined;

    switch (lastTool.name) {
      case 'search_clinics': {
        const clinics = Array.isArray(lastTool.result.clinics) ? lastTool.result.clinics : [];
        const rows = clinics
          .slice(0, 10)
          .map((c: Record<string, unknown>) => ({
            id: String(c.id ?? ''),
            title: this.clip(String(c.name ?? 'Clinic'), 24),
            description: c.services ? this.clip(String(c.services), 72) : undefined,
          }))
          .filter((r) => r.id);
        return this.list('Choose a clinic', rows, 'Clinics found');
      }
      case 'get_clinic_details': {
        const branches = Array.isArray(lastTool.result.branches) ? lastTool.result.branches : [];
        const rows = branches
          .slice(0, 10)
          .map((b: Record<string, unknown>) => ({ id: String(b.id ?? ''), title: this.clip(String(b.name ?? 'Branch'), 24) }))
          .filter((r) => r.id);
        return this.list('Choose a branch', rows, 'Branches');
      }
      case 'search_public_availability':
      case 'check_availability': {
        const windows = Array.isArray(lastTool.result.windows) ? lastTool.result.windows : [];
        const rows = windows
          .slice(0, 10)
          .map((w: Record<string, unknown>) => {
            const start = String(w.startTime ?? '');
            const label = start ? new Date(start).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Slot';
            return { id: start, title: this.clip(label, 24) };
          })
          .filter((r) => r.id);
        return this.list('Choose a time', rows, 'Available slots');
      }
      default:
        return undefined;
    }
  }

  private list(
    buttonText: string,
    rows: { id: string; title: string; description?: string }[],
    sectionTitle: string,
  ): WhatsappSessionPayload['interactive'] | undefined {
    if (!rows.length) return undefined;
    const sections: WhatsappListSection[] = [{ title: sectionTitle, rows }];
    return { list: { buttonText, sections } };
  }

  private clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /**
   * Find-or-create the WhatsApp contact AND its linked CRM customer (needed so
   * the bot can actually book an appointment on the visitor's behalf — the
   * customer id is bound into the AI session, see `processTurn`). A synthetic,
   * globally-unique email is used since `customers.email` has no NULL/blank
   * fallback in this schema and WhatsApp never supplies one.
   */
  private async findOrCreateContact(
    tenantId: string,
    waId: string,
    displayName?: string,
  ): Promise<WhatsappContact> {
    const existing = await this.contacts.findOne({
      where: { wa_id: waId, tenant: { id: tenantId } },
      relations: { customer: true },
    });
    if (existing) {
      if (displayName && !existing.display_name) {
        existing.display_name = displayName;
        await this.contacts.save(existing);
      }
      if (!existing.customer) {
        existing.customer = await this.findOrCreateCustomer(tenantId, waId, displayName);
        await this.contacts.save(existing);
      }
      return existing;
    }

    const customer = await this.findOrCreateCustomer(tenantId, waId, displayName);
    return this.contacts.save(
      this.contacts.create({
        tenant: { id: tenantId } as Tenant,
        wa_id: waId,
        display_name: displayName,
        customer,
      }),
    );
  }

  private async findOrCreateCustomer(tenantId: string, waId: string, displayName?: string) {
    const search = await this.customers.search(tenantId, { q: waId, page: 1, limit: 5 } as never);
    const match = search.data.find((c) => c.phone === waId || c.whatsapp_id === waId);
    if (match) return match;

    return this.customers.create(tenantId, {
      full_name: displayName,
      phone: waId,
      // Globally-unique synthetic address (schema requires a non-null, unique
      // email); tenantId+waId guarantees no collision across tenants.
      email: `whatsapp+${tenantId}-${waId}@bot.internal`,
      whatsapp_id: waId,
      whatsapp_name: displayName,
      source: 'whatsapp',
    });
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
