import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Message } from '../../entities/Conversations/Message';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { CustomerService } from '../crm/customer.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WhatsappBotActorService } from './whatsapp-bot-actor.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { WhatsappMediaService } from './meta/whatsapp-media.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { isOptOutMessage } from './opt-out.util';
import type {
  WhatsappListSection,
  WhatsappSessionPayload,
} from './providers/whatsapp-message.provider.interface';
import type {
  MetaWebhookChangeValue,
  MetaWebhookMessage,
} from './webhooks/whatsapp-webhook.types';

const PG_UNIQUE_VIOLATION = '23505';

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
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly media: WhatsappMediaService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly conversationExecution: ConversationExecutionService,
    private readonly messaging: WhatsappMessagingService,
    private readonly router: WhatsappMessageRouter,
    private readonly botActor: WhatsappBotActorService,
    private readonly customers: CustomerService,
    private readonly ctx: TenantContextService,
    private readonly settings: SystemSettingService,
    private readonly access: AccessControlService,
  ) {}

  /**
   * Process the inbound messages in a resolved Meta change value.
   *
   * INGEST vs EXECUTE. The webhook job itself (`whatsapp.webhookProcess`) is
   * deliberately NOT entitlement-gated — inbound events must keep being
   * accepted and persisted while a clinic is blocked, or a suspension would
   * silently destroy customer messages the clinic never gets to read. What is
   * gated is what this bridge DOES with them: driving an AI turn and sending a
   * reply. Checked once here rather than per message so a blocked tenant's
   * batch produces one log line instead of one error per inbound message —
   * `AiExecutionService` and `WhatsappMessagingService.sendSession` still
   * refuse independently, so this is an early-out, not the enforcement.
   */
  async handleInboundValue(
    tenantId: string,
    value: MetaWebhookChangeValue,
  ): Promise<void> {
    const messages = value?.messages ?? [];
    if (messages.length === 0) return;
    if (!(await this.mayAutoReply(tenantId))) return;
    for (const message of messages) {
      await this.handleOne(tenantId, value, message).catch((err) =>
        this.logger.error(`inbound AI turn failed: ${(err as Error)?.message}`),
      );
    }
  }

  /**
   * Both capabilities this bridge exercises: the AI turn and the WhatsApp
   * reply. Fails CLOSED — a webhook path that cannot read the decision must not
   * proceed to run AI and send messages on the clinic's behalf.
   */
  private async mayAutoReply(tenantId: string): Promise<boolean> {
    for (const key of [FeatureKey.AI_ASSISTANT, FeatureKey.WHATSAPP]) {
      let decision;
      try {
        decision = await this.access.resolve(tenantId, key);
      } catch (err) {
        this.logger.error(
          `Access check failed for inbound WhatsApp AI (tenant=${tenantId}, feature=${key}) — ` +
            `skipping the auto-reply (fail closed): ${(err as Error)?.message}`,
        );
        return false;
      }
      if (decision.allowed) continue;
      if (
        !this.access.shouldBlock(decision, {
          surface: 'webhook',
          detail: 'whatsapp.inbound.aiReply',
        })
      ) {
        continue; // ACCESS_POLICY_MODE=shadow — recorded, not enforced
      }
      this.logger.warn(
        `Skipping inbound WhatsApp AI auto-reply for tenant ${tenantId}: not entitled to "${key}" ` +
          `(source=${decision.source}). The inbound message itself is still stored.`,
      );
      return false;
    }
    return true;
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
      this.logger.debug(
        `inbound ${message.type ?? 'unknown'} had no actionable content (tenant=${tenantId})`,
      );
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
    const displayName = value?.contacts?.find((c) => c.wa_id === message.from)
      ?.profile?.name;
    const contact = await this.findOrCreateContact(tenantId, waId, displayName);

    // FND-024: an inbound opt-out is recorded and the turn stops HERE — no AI
    // reply, no booking turn. Checked before the orchestrator call so a
    // customer who just said "STOP" never gets a chatbot response back
    // (confusing at best, a compliance problem at worst). Keyword set is data
    // (whatsapp.opt_out_keywords), never hardcoded — extensible without a
    // deploy (AD-05-adjacent: exact-message match only, not substring, so an
    // unrelated sentence containing a keyword-shaped word is never mistaken
    // for an opt-out).
    if (contact.customer?.id) {
      const keywordsCsv = await this.settings.getTyped<string>(
        SettingKey.WHATSAPP_OPT_OUT_KEYWORDS,
      );
      if (isOptOutMessage(content, keywordsCsv)) {
        await this.customers.recordOptOut(
          tenantId,
          contact.customer.id,
          'inbound_keyword',
        );
        this.logger.log(
          `Customer ${contact.customer.id} opted out via inbound WhatsApp keyword`,
        );
        return;
      }
    }

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
        // TRUSTED, not `sessionPatch`: this bridge is trusted server code
        // restoring the bot actor's own principal (see `handleOne` above),
        // and `context.customerId` is the server-bound booking subject every
        // write tool prefers over a model-supplied id
        // (`AiExecutionService.sessionCustomerId`). `sessionPatch` always
        // passes through `patchFromClient`, which strips `context.customerId`
        // as one of `SESSION_CONTEXT_SERVER_ONLY_KEYS` — so setting it there
        // silently never took effect, and every WhatsApp booking's
        // `customerId` argument came from the model instead of this binding.
        trustedSessionPatch: contact.customer?.id
          ? { context: { customerId: contact.customer.id } }
          : undefined,
        // Record the provider facts on the mirrored timeline message: the
        // `wamid` (which finally makes the messages(tenantId, wa_message_id)
        // dedupe index effective, and is how media is matched back to its
        // message) and the real message type instead of a blanket "text".
        origin: { waMessageId: message.id, messageType: message.type },
      },
      () => undefined,
    );

    // Fetch any attached media on its own queue — see WhatsappMediaService for
    // why this cannot happen inline. Never blocks or fails the AI turn.
    await this.attachMedia(tenantId, message);

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
    await this.sendReply(
      tenantId,
      waId,
      reply,
      interactive,
      result.mirroredMessageId,
    );
  }

  /**
   * Queue downloads for any media on this inbound message.
   *
   * Resolves the persisted timeline message by its `wamid` — the mirror wrote
   * it as part of this same turn. Best-effort throughout: media is an
   * enrichment, and losing a photo must never cost the patient their reply.
   */
  private async attachMedia(
    tenantId: string,
    message: MetaWebhookMessage,
  ): Promise<void> {
    if (!WhatsappMediaService.isMediaMessage(message) || !message.id) return;

    try {
      const stored = await this.messages.findOne({
        where: { tenant: { id: tenantId }, wa_message_id: message.id },
        relations: { conversation: { whatsapp_account: true } },
      });
      if (!stored) return;

      // Prefer the account the conversation actually arrived on; fall back to
      // the tenant's default. A media id is only readable with the token of the
      // WABA that received it, so the right account matters.
      const accountId =
        stored.conversation?.whatsapp_account?.id ??
        (await this.router.resolveForSend(tenantId, {})).id;

      await this.media.enqueueForMessage(
        tenantId,
        accountId,
        stored.id,
        message,
      );
    } catch (err) {
      this.logger.warn(
        `Could not queue inbound media for message ${message.id}: ${(err as Error)?.message}`,
      );
    }
  }

  /** Send the AI reply back over WhatsApp as a free-form session message. */
  private async sendReply(
    tenantId: string,
    to: string,
    text: string,
    interactive?: WhatsappSessionPayload['interactive'],
    mirroredMessageId?: string | null,
  ): Promise<void> {
    // A reply can only go out from THIS clinic's own connected number — there is
    // no shared platform number to fall back to. If the tenant has no usable
    // account, abort loudly rather than attempting a send that cannot succeed.
    let account;
    try {
      account = await this.router.resolveForSend(tenantId, {});
    } catch (err) {
      this.logger.warn(
        `Cannot send AI reply for tenant ${tenantId}: ${(err as Error)?.message}`,
      );
      return;
    }

    const res = await this.messaging.sendSession({
      tenantId,
      accountId: account.id,
      phoneNumberId: account.phoneNumberId,
      mode: account.mode,
      to,
      text,
      interactive,
    });
    if (!res.success) {
      this.logger.warn(`WhatsApp reply send failed: ${res.error}`);
      return;
    }
    if (mirroredMessageId && res.providerMessageId) {
      // FND-023 — lets a later delivery/read webhook (matched by wamid) find
      // its way back to this bot reply on the unified timeline.
      await this.conversationExecution
        .recordProviderMessageId(
          tenantId,
          mirroredMessageId,
          res.providerMessageId,
        )
        .catch((err) =>
          this.logger.warn(
            `could not record provider message id: ${(err as Error)?.message}`,
          ),
        );
    }
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
        const clinics = Array.isArray(lastTool.result.clinics)
          ? lastTool.result.clinics
          : [];
        const rows = clinics
          .slice(0, 10)
          .map((c: Record<string, unknown>) => ({
            id: String(c.id ?? ''),
            title: this.clip(String(c.name ?? 'Clinic'), 24),
            description: c.services
              ? this.clip(String(c.services), 72)
              : undefined,
          }))
          .filter((r) => r.id);
        return this.list('Choose a clinic', rows, 'Clinics found');
      }
      case 'get_clinic_details': {
        const branches = Array.isArray(lastTool.result.branches)
          ? lastTool.result.branches
          : [];
        const rows = branches
          .slice(0, 10)
          .map((b: Record<string, unknown>) => ({
            id: String(b.id ?? ''),
            title: this.clip(String(b.name ?? 'Branch'), 24),
          }))
          .filter((r) => r.id);
        return this.list('Choose a branch', rows, 'Branches');
      }
      case 'list_clinic_branches': {
        const branches = Array.isArray(lastTool.result.branches)
          ? lastTool.result.branches
          : [];
        const rows = branches
          .slice(0, 10)
          .map((b: Record<string, unknown>) => ({
            id: String(b.id ?? ''),
            title: this.clip(String(b.name ?? 'Branch'), 24),
            description: b.address
              ? this.clip(String(b.address), 72)
              : undefined,
          }))
          .filter((r) => r.id);
        return this.list('Choose a branch', rows, 'Branches');
      }
      case 'list_clinic_doctors': {
        const doctors = Array.isArray(lastTool.result.doctors)
          ? lastTool.result.doctors
          : [];
        const rows = doctors
          .slice(0, 10)
          .map((d: Record<string, unknown>) => ({
            id: String(d.id ?? ''),
            title: this.clip(String(d.name ?? 'Doctor'), 24),
            description: d.title ? this.clip(String(d.title), 72) : undefined,
          }))
          .filter((r) => r.id);
        return this.list('Choose a doctor', rows, 'Doctors');
      }
      case 'list_clinic_services': {
        const services = Array.isArray(lastTool.result.services)
          ? lastTool.result.services
          : [];
        const rows = services
          .slice(0, 10)
          .map((s: Record<string, unknown>) => ({
            id: String(s.id ?? ''),
            title: this.clip(String(s.name ?? 'Service'), 24),
            description: this.clip(this.serviceLine(s), 72) || undefined,
          }))
          .filter((r) => r.id);
        return this.list('Choose a service', rows, 'Services');
      }
      case 'search_public_availability':
      case 'check_availability': {
        const windows = Array.isArray(lastTool.result.windows)
          ? lastTool.result.windows
          : [];
        const rows = windows
          .slice(0, 10)
          .map((w: Record<string, unknown>) => {
            const start = String(w.startTime ?? '');
            const label = start
              ? new Date(start).toLocaleString('en-GB', {
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Slot';
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
   * `list_clinic_services` row description: price and/or duration, whichever
   * `PublicDiscoveryService.listBranchServices` actually returned (`price`
   * is `null` for a service with no `service_prices`/`base_price` set —
   * never omit the row over it, just describe what is known).
   */
  private serviceLine(service: Record<string, unknown>): string {
    const parts: string[] = [];
    if (typeof service.price === 'number') parts.push(`${service.price}`);
    if (typeof service.durationMinutes === 'number') {
      parts.push(`${service.durationMinutes} min`);
    }
    return parts.join(' · ');
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
        existing.customer = await this.findOrCreateCustomer(
          tenantId,
          waId,
          displayName,
        );
        await this.contacts.save(existing);
      }
      return existing;
    }

    const customer = await this.findOrCreateCustomer(
      tenantId,
      waId,
      displayName,
    );
    try {
      return await this.contacts.save(
        this.contacts.create({
          tenant: { id: tenantId } as Tenant,
          wa_id: waId,
          display_name: displayName,
          customer,
        }),
      );
    } catch (err) {
      // Two inbound messages from the same contact can be picked up by
      // different worker jobs concurrently (webhook worker concurrency > 1);
      // both can find no existing contact and both attempt to create one.
      // `UQ_whatsapp_contact_tenant_wa_id` lets exactly one insert win — the
      // loser re-fetches rather than erroring the whole AI turn.
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        const winner = await this.contacts.findOne({
          where: { wa_id: waId, tenant: { id: tenantId } },
          relations: { customer: true },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async findOrCreateCustomer(
    tenantId: string,
    waId: string,
    displayName?: string,
  ) {
    const search = await this.customers.search(tenantId, {
      q: waId,
      page: 1,
      limit: 5,
    } as never);
    const match = search.data.find(
      (c) => c.phone === waId || c.whatsapp_id === waId,
    );
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
        return message.audio?.voice
          ? '[The user sent a voice message.]'
          : '[The user sent an audio message.]';
      case 'video':
        return message.video?.caption?.trim() || '[The user sent a video.]';
      case 'sticker':
        return '[The user sent a sticker.]';
      case 'location': {
        const l = message.location;
        if (l?.latitude == null || l?.longitude == null)
          return '[The user shared a location.]';
        const label = l.name ?? l.address ?? `${l.latitude},${l.longitude}`;
        return `[The user shared a location: ${label}]`;
      }
      default:
        return undefined;
    }
  }
}
