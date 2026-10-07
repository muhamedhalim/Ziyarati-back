import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { Conversation } from '../../entities/Conversations/Conversation';
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
import { AiWsRateLimitService } from '../ai-realtime/ai-ws-rate-limit.service';
import { MetricsService } from '../../metrics/metrics.service';
import { MessageStatusService } from '../conversations/message-status.service';
import { AppError, ErrorCode } from '../../common/errors';
import { isOptOutMessage } from './opt-out.util';
import { WhatsappAiPolicyService } from './whatsapp-ai-policy.service';
import {
  AI_POLICY_REASON,
  AiPolicyReason,
  AiPolicySubject,
} from './whatsapp-ai-policy.constants';
import {
  ContactTurnBusyError,
  ContactTurnLockService,
} from './contact-turn-lock.service';
import type {
  WhatsappListSection,
  WhatsappSessionPayload,
} from './providers/whatsapp-message.provider.interface';
import type {
  MetaWebhookChangeValue,
  MetaWebhookMessage,
} from './webhooks/whatsapp-webhook.types';

const PG_UNIQUE_VIOLATION = '23505';

/** An ISO-8601 instant with an offset, e.g. `2026-10-12T10:30:00.000Z`. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * What the STORE step (see `handleInboundValue`) learned about one inbound
 * message, for the AI step that may follow it.
 *  - `skip`   — nothing for the AI to do (no actionable content, or the patient
 *               opted out); the message itself is already stored.
 *  - `failed` — the message could not be stored/resolved; carries the error.
 *  - `ready`  — stored; `conversationId` is its timeline thread (`null` only
 *               when no thread could be resolved).
 */
type IngestedMessage =
  | { kind: 'skip'; message: MetaWebhookMessage }
  | { kind: 'failed'; message: MetaWebhookMessage; error: unknown }
  | {
      kind: 'ready';
      message: MetaWebhookMessage;
      waId: string;
      content: string;
      contact: WhatsappContact;
      conversationId: string | null;
      /**
       * The clinic's connected account (number) the patient wrote TO — the one
       * every bot message of this turn must leave from. `null` when the
       * receiving number matches no live account of this tenant.
       */
      accountId: string | null;
    };

/**
 * Sent when an AI turn throws (see `onTurnFailed`). Bilingual because no
 * language has been established at that point; deliberately free of any clinic
 * fact, time or price.
 */
const TURN_FAILED_FALLBACK_TEXT =
  'Sorry, I could not process your message just now. Please try again in a moment, or contact the clinic directly.\n' +
  'عذرًا، لم أتمكن من معالجة رسالتك الآن. يُرجى المحاولة مرة أخرى بعد قليل أو التواصل مع العيادة مباشرة.';

/**
 * F-16. Sent ONCE, to the message that first crosses a contact's limit — the
 * flood behind it gets silence, not a reply per message (a reply is a
 * WhatsApp send, and the point of the limit is to stop spending). Bilingual for
 * the same reason as TURN_FAILED_FALLBACK_TEXT; no clinic fact in either.
 */
const CONTACT_RATE_LIMITED_TEXT =
  'You are sending messages faster than I can answer. Please wait a moment and try again, or contact the clinic directly.\n' +
  'أنت ترسل الرسائل أسرع مما أستطيع الرد عليه. يُرجى الانتظار قليلًا ثم المحاولة مرة أخرى، أو التواصل مع العيادة مباشرة.';
const CONTACT_DAILY_LIMIT_TEXT =
  'You have reached the limit for automated replies today. Please contact the clinic directly.\n' +
  'لقد بلغت الحد الأقصى للردود الآلية اليوم. يُرجى التواصل مع العيادة مباشرة.';

/**
 * WhatsApp inbound → AI automation bridge (Feature 3), driven by the tenant's
 * dedicated AI Bot Actor (Feature: WhatsApp Bot Actor).
 *
 * When an inbound WhatsApp `messages` event is received (tenant already resolved
 * from the phone number id), this drives it through the SAME cross-channel AI
 * pipeline the website and dashboard use:
 *
 *   inbound message → resolve/create WhatsApp contact + linked CRM customer →
 *   STORE it on the unified timeline (always, whatever the AI settings) →
 *   [only if the clinic's assistant is on and entitled] restore the tenant's AI Bot Actor as the real authenticated principal →
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
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly media: WhatsappMediaService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly conversationExecution: ConversationExecutionService,
    private readonly messaging: WhatsappMessagingService,
    private readonly router: WhatsappMessageRouter,
    private readonly botActor: WhatsappBotActorService,
    private readonly customers: CustomerService,
    private readonly ctx: TenantContextService,
    private readonly settings: SystemSettingService,
    private readonly metrics: MetricsService,
    /** The single decision on whether the AI may answer — see its docblock. */
    private readonly policy: WhatsappAiPolicyService,
    /** Serializes AI turns per contact. */
    private readonly turnLock: ContactTurnLockService,
    /** Marks a bot reply the policy stopped at the last moment as FAILED. */
    private readonly messageStatus: MessageStatusService,
    /**
     * F-16: per-contact admission. The same stateless class the realtime gateway
     * uses, provided again by this module (importing AiRealtimeModule would be a
     * cycle — it imports this one).
     */
    private readonly rateLimit: AiWsRateLimitService,
  ) {}

  /**
   * Process the inbound messages in a resolved Meta change value.
   *
   * STORE FIRST, DECIDE AFTER. Every inbound message is stored on the unified
   * timeline (and its media queued, and a STOP honoured) BEFORE any decision
   * about the AI is taken. Before, the timeline copy was written only as part
   * of an AI turn, so a clinic that switched the assistant off (or was not
   * entitled to it) never saw the patient's message in the inbox at all — it
   * survived only as a raw `whatsapp_webhooks` row. Disabling the AI must
   * change who ANSWERS, never whether staff can SEE.
   *
   * What is gated is what this bridge DOES afterwards — driving an AI turn and
   * sending a reply. Checked once per batch (not per message) so a blocked
   * tenant's batch produces one log line instead of one per inbound message —
   * `AiExecutionService` and `WhatsappMessagingService.sendSession` still
   * refuse independently, so this is an early-out, not the enforcement. The
   * webhook job itself (`whatsapp.webhookProcess`) is deliberately NOT
   * entitlement-gated for the same reason: a blocked clinic must keep
   * receiving what its patients send.
   */
  async handleInboundValue(
    tenantId: string,
    value: MetaWebhookChangeValue,
  ): Promise<void> {
    const messages = value?.messages ?? [];
    if (messages.length === 0) return;

    const ingested: IngestedMessage[] = [];
    for (const message of messages) {
      ingested.push(await this.ingestOne(tenantId, value, message));
    }

    for (const item of ingested) {
      if (item.kind === 'skip') continue;
      if (item.kind === 'failed') {
        await this.onStoreFailed(tenantId, item.message, item.error);
        continue;
      }
      await this.handleOne(tenantId, item).catch((err) => {
        // A turn that only had to wait its turn, or that raced an identical
        // in-flight attempt, has run and sent nothing: failing the job lets
        // BullMQ retry it with backoff. Answering the patient with an apology
        // for something that is still going to work would be wrong.
        if (this.shouldRetryJob(err)) throw err;
        return this.onTurnFailed(
          tenantId,
          item.message,
          err,
          this.subjectOf(item),
          item.accountId,
        );
      });
    }
  }

  /** What the policy needs to know about a stored message's conversation. */
  private subjectOf(
    item: Extract<IngestedMessage, { kind: 'ready' }>,
  ): AiPolicySubject {
    return {
      conversationId: item.conversationId,
      customerId: item.contact.customer?.id ?? null,
      aiConversationId: item.contact.ai_conversation_id,
    };
  }

  /**
   * True for the two failures that mean "not now" rather than "this failed":
   * another turn for the same contact still holds the lock, or an identical AI
   * request is already in flight / has an unverified outcome (the AI request
   * claim raises CONFLICT for both).
   */
  private shouldRetryJob(err: unknown): boolean {
    return (
      err instanceof ContactTurnBusyError ||
      (err instanceof AppError && err.code === ErrorCode.CONFLICT)
    );
  }

  /**
   * A message that could not be stored. If the assistant may answer, behave as
   * for any turn that throws (ERROR log, counter, one plain "we could not
   * answer" message). If it may not, the patient must not be answered — but a
   * message that never reached the inbox is still worth an alert. Nothing is
   * known about the thread here, so only the clinic-wide rules can apply.
   */
  private async onStoreFailed(
    tenantId: string,
    message: MetaWebhookMessage,
    error: unknown,
  ): Promise<void> {
    const decision = await this.policy.evaluate(tenantId, {}, 'pre_ai');
    if (decision.allowed) {
      await this.onTurnFailed(tenantId, message, error, {});
      return;
    }
    this.logger.error(
      `inbound message could not be stored on the timeline (tenant=${tenantId}): ${(error as Error)?.message}`,
    );
  }

  /**
   * The STORE step for one message. Runs for every clinic whatever its AI
   * settings, so it never calls the bot actor, the orchestrator or the model,
   * and never sends anything. Never throws — a failure comes back as
   * `kind: 'failed'` so one bad message cannot lose the rest of the batch.
   */
  private async ingestOne(
    tenantId: string,
    value: MetaWebhookChangeValue,
    message: MetaWebhookMessage,
  ): Promise<IngestedMessage> {
    try {
      const waId = message.from?.replace(/[^\d]/g, '');
      if (!waId) return { kind: 'skip', message };

      const content = this.extractContent(message);
      if (!content) {
        this.logger.debug(
          `inbound ${message.type ?? 'unknown'} had no actionable content (tenant=${tenantId})`,
        );
        return { kind: 'skip', message };
      }

      const displayName = value?.contacts?.find((c) => c.wa_id === message.from)
        ?.profile?.name;
      const contact = await this.findOrCreateContact(
        tenantId,
        waId,
        displayName,
      );

      // Resolved ONCE per message: the thread, the media download token and every
      // reply of this turn all belong to the number the patient wrote to.
      const account = await this.resolveInboundAccount(
        tenantId,
        value?.metadata?.phone_number_id,
      );

      const conversationId = await this.storeOnTimeline(
        tenantId,
        message,
        contact,
        content,
        account,
      );

      // Fetch any attached media on its own queue — see WhatsappMediaService for
      // why this cannot happen inline. Needs the timeline message stored above.
      // Never blocks or fails the message.
      await this.attachMedia(tenantId, message, account?.id);

      // FND-024: an inbound opt-out is recorded here, ahead of every AI gate —
      // a "STOP" must be honoured even when the clinic has the assistant off,
      // and a customer who just said it must never get a chatbot response back
      // (confusing at best, a compliance problem at worst). Keyword set is data
      // (whatsapp.opt_out_keywords), never hardcoded — extensible without a
      // deploy (AD-05-adjacent: exact-message match only, not substring, so an
      // unrelated sentence containing a keyword-shaped word is never mistaken
      // for an opt-out).
      if (await this.recordOptOutIfRequested(tenantId, contact, content)) {
        return { kind: 'skip', message };
      }

      return {
        kind: 'ready',
        message,
        waId,
        content,
        contact,
        conversationId,
        accountId: account?.id ?? null,
      };
    } catch (error) {
      return { kind: 'failed', message, error };
    }
  }

  /**
   * Stores the patient's message on the timeline thread of this contact and
   * returns that thread's id (`null` when it could not be placed).
   *
   * Idempotent on the `wamid`: a job retry, or the AI engine's own mirror of
   * the same message later in the turn, finds the row and writes nothing. A
   * message that already existed is NOT a reason to stop — the first attempt
   * may have died before the reply went out, and the AI request claim (keyed on
   * the same `wamid`) is what prevents a second model run.
   */
  private async storeOnTimeline(
    tenantId: string,
    message: MetaWebhookMessage,
    contact: WhatsappContact,
    content: string,
    account: WhatsappAccount | null,
  ): Promise<string | null> {
    const customerId = contact.customer?.id;
    if (!customerId || !account) {
      this.logger.warn(
        `inbound message not stored on the timeline (tenant=${tenantId}): ${
          customerId
            ? 'no connected WhatsApp account matches the receiving number'
            : 'contact has no linked customer'
        }`,
      );
      return null;
    }

    const thread = await this.resolveThreadForContact(
      tenantId,
      contact,
      account.id,
    );
    await this.conversationExecution.recordChannelMessageOnce(
      tenantId,
      thread.id,
      'CUSTOMER',
      content,
      undefined,
      { waMessageId: message.id, messageType: message.type },
    );
    return thread.id;
  }

  /**
   * The timeline thread this contact's WhatsApp conversation lives on — the one
   * place that is decided, so the patient's messages, the AI session, the agent
   * inbox and a staff reply sent from the WhatsApp Business App (a coexistence
   * echo) all land on, and are judged against, the same thread.
   *
   * The thread the contact's AI session is already bound to wins; otherwise the
   * customer's thread for this account, created if there is none.
   */
  async resolveThreadForContact(
    tenantId: string,
    contact: WhatsappContact,
    accountId: string,
  ): Promise<Conversation> {
    const customerId = contact.customer?.id;
    if (!customerId) {
      throw new Error('contact has no linked customer');
    }
    const aiSession = contact.ai_conversation_id
      ? await this.aiConversations.findOne({
          where: {
            id: contact.ai_conversation_id,
            tenant: { id: tenantId },
          },
          relations: { conversation: true },
        })
      : null;
    return this.conversationExecution.resolveWhatsappThread(
      tenantId,
      customerId,
      accountId,
      aiSession?.conversation?.id,
    );
  }

  /**
   * The clinic's own connected account for the number that received the
   * message. Tenant-scoped and live-only, like every other inbound lookup of
   * `phone_number_id` — the tenant itself was already resolved from it.
   */
  private async resolveInboundAccount(
    tenantId: string,
    phoneNumberId: string | undefined,
  ): Promise<WhatsappAccount | null> {
    if (!phoneNumberId) return null;
    return this.accounts.findOne({
      where: {
        phone_number_id: phoneNumberId,
        tenant: { id: tenantId },
        deleted_at: IsNull(),
      },
    });
  }

  /** Records the opt-out and returns true when `content` is an opt-out keyword. */
  private async recordOptOutIfRequested(
    tenantId: string,
    contact: WhatsappContact,
    content: string,
  ): Promise<boolean> {
    if (!contact.customer?.id) return false;
    const keywordsCsv = await this.settings.getTyped<string>(
      SettingKey.WHATSAPP_OPT_OUT_KEYWORDS,
    );
    if (!isOptOutMessage(content, keywordsCsv)) return false;
    await this.customers.recordOptOut(
      tenantId,
      contact.customer.id,
      'inbound_keyword',
    );
    this.logger.log(
      `Customer ${contact.customer.id} opted out via inbound WhatsApp keyword`,
    );
    return true;
  }

  /**
   * A turn that threw must not vanish. Before, this was one log line and the
   * patient heard nothing — indistinguishable from an unread inbox, and a
   * permanent failure (F-25) stayed invisible for as long as it lasted. Now:
   * an ERROR log carrying the tenant, a counter to alert on, and one plain
   * "we could not answer" message to the patient.
   *
   * The message carries no clinic data, time or price — nothing that could be
   * wrong — and promises no follow-up that no one has been asked to make.
   * Best-effort: a failed fallback is logged, never rethrown, so one bad turn
   * still cannot block the batch.
   */
  private async onTurnFailed(
    tenantId: string,
    message: MetaWebhookMessage,
    err: unknown,
    subject: AiPolicySubject,
    accountId?: string | null,
  ): Promise<void> {
    this.logger.error(
      `inbound AI turn failed (tenant=${tenantId}): ${(err as Error)?.message}`,
    );
    const waId = message.from?.replace(/[^\d]/g, '');
    let sent = false;
    if (waId) {
      try {
        // The fallback is a message to the patient like any other: if the
        // policy stops it (switched off, a person owns the chat), it is not sent.
        sent = await this.sendReply(
          tenantId,
          waId,
          TURN_FAILED_FALLBACK_TEXT,
          subject,
          undefined,
          undefined,
          accountId,
        );
      } catch (sendErr) {
        this.logger.warn(
          `could not send the turn-failed fallback (tenant=${tenantId}): ${(sendErr as Error)?.message}`,
        );
      }
    }
    this.metrics.recordWhatsappAiTurnFailure(sent ? 'sent' : 'not_sent');
  }

  /**
   * The AI step for one stored message. First the policy decides — before
   * anything is spent and before a bot user could be provisioned. Only a message
   * the assistant may answer restores the tenant's AI Bot Actor as a REAL
   * authenticated principal for the whole turn: every downstream check (booking
   * permission gates, actorUserId on the appointment row) sees a real, auditable
   * user instead of an anonymous context, exactly as an HTTP request would. A
   * clinic that never uses the AI never gets a bot user provisioned.
   */
  private async handleOne(
    tenantId: string,
    item: Extract<IngestedMessage, { kind: 'ready' }>,
  ): Promise<void> {
    const decision = await this.policy.evaluate(
      tenantId,
      this.subjectOf(item),
      'pre_ai',
    );
    if (!decision.allowed) {
      await this.recordSuppressed(tenantId, item, decision.reason);
      return;
    }

    const bot = await this.botActor.ensureBotActor(tenantId);
    await this.ctx.run(async () => {
      this.ctx.setPrincipal(bot);
      await this.processTurn(tenantId, item);
    });
  }

  /**
   * A message the assistant must not answer. Where the conversation is one the
   * AI is expected to come back to — a person owns it, or staff paused it — the
   * message still belongs in the AI's own history (so nothing is missing when
   * the chat is returned or resumed) and, when someone is assigned, they are
   * notified that the customer replied: exactly what a handed-over turn did
   * inside the orchestrator before the policy stopped it earlier. Any other
   * reason (the clinic switched the assistant off, the patient is excluded)
   * needs nothing beyond what storing already did — and an excluded patient's
   * message is deliberately not fed into an AI history. Best-effort.
   */
  private async recordSuppressed(
    tenantId: string,
    item: Extract<IngestedMessage, { kind: 'ready' }>,
    reason: AiPolicyReason,
  ): Promise<void> {
    const aiConversationId = item.contact.ai_conversation_id;
    const resumable =
      reason === AI_POLICY_REASON.HUMAN_TAKEOVER ||
      reason === AI_POLICY_REASON.CONVERSATION_AI_DISABLED;
    if (!resumable || !aiConversationId) return;
    try {
      await this.orchestrator.recordInboundWithoutAnswer(
        tenantId,
        aiConversationId,
        item.content,
        { waMessageId: item.message.id, messageType: item.message.type },
      );
    } catch (err) {
      this.logger.warn(
        `could not record an unanswered inbound message (tenant=${tenantId}): ${(err as Error)?.message}`,
      );
    }
  }

  private async processTurn(
    tenantId: string,
    item: Extract<IngestedMessage, { kind: 'ready' }>,
  ): Promise<void> {
    const { waId } = item;

    // One AI turn per contact at a time, so a second message sees the first
    // turn's reply in its history and replies leave in order.
    await this.turnLock.run(tenantId, waId, async ({ waited }) => {
      // The contact was loaded BEFORE the lock, so its AI-session binding may
      // predate a turn that finished while this one was queued or being picked
      // up. Every read below (policy, history, the session the model resumes)
      // must see the binding as it is now, not as it was at ingest.
      await this.refreshAiBinding(tenantId, item.contact);

      // A turn that queued behind another may now be looking at a different
      // world: staff can have paused the AI or taken the chat while it waited.
      if (waited) {
        const again = await this.policy.evaluate(
          tenantId,
          this.subjectOf(item),
          'pre_ai',
        );
        if (!again.allowed) {
          await this.recordSuppressed(tenantId, item, again.reason);
          return;
        }
      }

      // F-16: after the opt-out check (a "STOP" must always be honoured) and
      // before anything that costs money. Counted here, inside the lock, and
      // only for FRESH work: a lock-busy retry never got this far, and a replay
      // (an already-claimed wamid: a queue retry, a re-delivered webhook) is the
      // same message, not another one. A refused message is already stored on
      // the timeline, so a human can still read it.
      const replay = item.message.id
        ? await this.orchestrator.hasRequestClaim(tenantId, item.message.id)
        : false;
      if (
        !replay &&
        !(await this.admitContactTurn(
          tenantId,
          waId,
          this.subjectOf(item),
          item.accountId,
        ))
      ) {
        return;
      }
      await this.runTurn(tenantId, item);
    });
  }

  private async runTurn(
    tenantId: string,
    item: Extract<IngestedMessage, { kind: 'ready' }>,
  ): Promise<void> {
    const { message, waId, content, contact, conversationId } = item;

    // Continue the contact's single conversation (shared history/session/memory/
    // agent). First inbound turn has none → the orchestrator creates + routes one,
    // bound to the timeline thread the message was just stored on. `handleStream`
    // reuses the SAME tool-capable streaming path as the website/dashboard
    // widgets (real usage accounting, no duplicated AI logic) — the token deltas
    // aren't forwarded anywhere (WhatsApp has no live-edit UX), only the final
    // assistant reply is sent.
    const result = await this.orchestrator.handleStream(
      tenantId,
      {
        channel: 'WHATSAPP',
        // F-13: this bridge IS the WhatsApp channel; nothing else may claim it.
        trustedChannel: true,
        content,
        aiConversationId: contact.ai_conversation_id ?? undefined,
        // Only honoured because `trustedChannel` is set: binds a new session —
        // or a resumed one that has no thread yet — to the timeline thread, so
        // the AI's replies are mirrored where the patient's messages already are.
        conversationId: conversationId ?? undefined,
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

    if (!contact.ai_conversation_id && result.aiConversationId) {
      await this.bindAiConversation(tenantId, contact, result.aiConversationId);
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
      this.subjectOf(item),
      interactive,
      result.mirroredMessageId,
      item.accountId,
    );
  }

  /**
   * Re-reads the contact's AI-session binding (tenant-scoped, one narrow
   * column) and applies it to the in-memory contact. Called inside the
   * per-contact lock, where it is authoritative: no other turn for this contact
   * can change it until the lock is released.
   */
  private async refreshAiBinding(
    tenantId: string,
    contact: WhatsappContact,
  ): Promise<void> {
    const fresh = await this.contacts.findOne({
      where: { id: contact.id, tenant: { id: tenantId } },
      select: { id: true, ai_conversation_id: true },
    });
    if (fresh)
      contact.ai_conversation_id = fresh.ai_conversation_id ?? undefined;
  }

  /**
   * Records the AI session this turn created as the contact's one session —
   * compare-and-set on "no session yet", never a whole-row save, so a stale
   * in-memory contact can neither overwrite a session another turn bound nor
   * write back a stale copy of its other columns.
   *
   * The lock already serializes turns, so losing the race means the lock was
   * lost mid-turn (TTL) — logged, and the winner's binding is adopted so the
   * NEXT turn resumes the winner. The session this turn created stays (it holds
   * the reply already sent) but is no longer the contact's.
   */
  private async bindAiConversation(
    tenantId: string,
    contact: WhatsappContact,
    aiConversationId: string,
  ): Promise<void> {
    const res = await this.contacts
      .createQueryBuilder()
      .update(WhatsappContact)
      .set({ ai_conversation_id: aiConversationId })
      .where('id = :id', { id: contact.id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('ai_conversation_id IS NULL')
      .execute();
    if (res.affected) {
      contact.ai_conversation_id = aiConversationId;
      return;
    }
    await this.refreshAiBinding(tenantId, contact);
    this.logger.warn(
      `contact already bound to another AI session — keeping it (tenant=${tenantId}, contact=${contact.id})`,
    );
  }

  /**
   * F-16: may this contact have another AI turn? Two windows — a short one that
   * stops a burst, and a daily one that stops a slow drip — both keyed to the
   * tenant AND the number (one clinic's line never spends another's allowance,
   * and the same person messaging two clinics is two contacts).
   *
   * The message that first crosses a limit gets ONE notice; every later one in
   * the window is dropped silently. Nothing here throws: the limiter degrades to
   * a stricter local count when Redis is down, and a failed notice is logged.
   */
  private async admitContactTurn(
    tenantId: string,
    waId: string,
    subject: AiPolicySubject,
    accountId: string | null,
  ): Promise<boolean> {
    for (const tier of ['whatsapp-contact', 'whatsapp-contact-day'] as const) {
      const decision = await this.rateLimit.checkAndRecord(
        `${tenantId}:${waId}`,
        tier,
      );
      if (decision.allowed) continue;
      // No phone number in the log line — tenant and tier are enough to alert on.
      this.logger.warn(
        `WhatsApp AI turn refused (tenant=${tenantId}, limit=${tier}, ` +
          `count=${decision.count}/${decision.limit})`,
      );
      if (decision.count === (decision.limit ?? 0) + 1) {
        try {
          await this.sendReply(
            tenantId,
            waId,
            tier === 'whatsapp-contact'
              ? CONTACT_RATE_LIMITED_TEXT
              : CONTACT_DAILY_LIMIT_TEXT,
            subject,
            undefined,
            undefined,
            accountId,
          );
        } catch (err) {
          this.logger.warn(
            `could not send the rate-limit notice (tenant=${tenantId}): ${(err as Error)?.message}`,
          );
        }
      }
      return false;
    }
    return true;
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
    inboundAccountId?: string,
  ): Promise<void> {
    if (!WhatsappMediaService.isMediaMessage(message) || !message.id) return;

    try {
      const stored = await this.messages.findOne({
        where: { tenant: { id: tenantId }, wa_message_id: message.id },
        relations: { conversation: { whatsapp_account: true } },
      });
      if (!stored) return;

      // Prefer the account this message actually arrived on, then the one its
      // conversation is bound to; fall back to the tenant's default. A media id
      // is only readable with the token of the WABA that received it, so the
      // right account matters.
      const accountId =
        inboundAccountId ??
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

  /**
   * Send a bot message back over WhatsApp as a free-form session message — the
   * ONE place this bridge sends, so every kind of bot message (the AI's answer,
   * the "could not process" fallback, the rate-limit notice) passes the same two
   * gates:
   *
   *  1. The policy, asked AGAIN here. The decision taken before the model ran can
   *     be stale by the time the answer is ready: staff may have paused the AI,
   *     taken the chat or switched the assistant off during the turn. A refusal
   *     sends nothing and marks the already-mirrored bot message FAILED, so the
   *     inbox does not show a reply as sent that the patient never received.
   *  2. De-duplication: a replayed turn (job retry) gets the stored answer back
   *     from the AI request claim, and its mirrored message already carries the
   *     provider id once the first attempt sent it. Sending again would deliver
   *     the same answer twice.
   */
  private async sendReply(
    tenantId: string,
    to: string,
    text: string,
    subject: AiPolicySubject,
    interactive?: WhatsappSessionPayload['interactive'],
    mirroredMessageId?: string | null,
    accountId?: string | null,
  ): Promise<boolean> {
    const decision = await this.policy.evaluate(tenantId, subject, 'pre_send');
    if (!decision.allowed) {
      await this.markReplySuppressed(tenantId, mirroredMessageId);
      return false;
    }
    if (
      mirroredMessageId &&
      (await this.alreadySent(tenantId, mirroredMessageId))
    ) {
      this.logger.log(
        `bot reply already delivered by an earlier attempt — not sending again (tenant=${tenantId})`,
      );
      return true;
    }

    // A reply can only go out from THIS clinic's own connected number — there is
    // no shared platform number to fall back to. If the tenant has no usable
    // account, abort loudly rather than attempting a send that cannot succeed.
    let account;
    try {
      account = await this.resolveSendAccount(tenantId, accountId);
    } catch (err) {
      this.logger.warn(
        `Cannot send AI reply for tenant ${tenantId}: ${(err as Error)?.message}`,
      );
      return false;
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
      return false;
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
    return true;
  }

  /**
   * The number a bot message leaves from: the one the patient wrote to. A clinic
   * can connect several, and an answer from a different number than the one
   * that was messaged is a different conversation to the patient — outside that
   * number's own 24 h window Meta also refuses a free-form message.
   *
   * Only when that account is gone or unusable (disconnected, expired, removed
   * since the message arrived) does it fall back to the clinic's default —
   * logged, since which number a patient is answered from is worth seeing. The
   * lookup is tenant-scoped (`byId`), so an id can never name another clinic's
   * number.
   */
  private async resolveSendAccount(
    tenantId: string,
    accountId?: string | null,
  ) {
    if (accountId) {
      try {
        return await this.router.resolveForSend(tenantId, { accountId });
      } catch (err) {
        this.logger.warn(
          `receiving account is not usable for the reply — using the clinic default (tenant=${tenantId}, account=${accountId}): ${(err as Error)?.message}`,
        );
      }
    }
    return this.router.resolveForSend(tenantId, {});
  }

  /** Whether this mirrored bot message already went out (it carries the provider id). */
  private async alreadySent(
    tenantId: string,
    mirroredMessageId: string,
  ): Promise<boolean> {
    try {
      const row = await this.messages.findOne({
        where: { id: mirroredMessageId, tenant: { id: tenantId } },
        select: { id: true, wa_message_id: true },
      });
      return Boolean(row?.wa_message_id);
    } catch (err) {
      this.logger.warn(
        `could not check whether a bot reply was already sent (tenant=${tenantId}) — sending: ${(err as Error)?.message}`,
      );
      return false;
    }
  }

  /** Best-effort: a reply the policy stopped must not stay shown as sent. */
  private async markReplySuppressed(
    tenantId: string,
    mirroredMessageId?: string | null,
  ): Promise<void> {
    if (!mirroredMessageId) return;
    try {
      await this.messageStatus.markFailed(tenantId, mirroredMessageId);
    } catch (err) {
      this.logger.warn(
        `could not mark a suppressed bot reply as failed (tenant=${tenantId}): ${(err as Error)?.message}`,
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
        // Shape from `availabilityPayload`: days[].slots[] for the asked day,
        // nextAvailable[] only when that day was empty. `localTime` is already
        // in the branch's zone; `startAt` is the ISO instant booking takes.
        const rows = this.slotRows(lastTool.result).slice(0, 10);
        return this.list('Choose a time', rows, 'Available slots');
      }
      default:
        return undefined;
    }
  }

  private slotRows(
    result: Record<string, unknown>,
  ): { id: string; title: string }[] {
    const rows: { id: string; title: string }[] = [];
    for (const key of ['days', 'nextAvailable']) {
      const days = Array.isArray(result[key]) ? result[key] : [];
      for (const day of days as Record<string, unknown>[]) {
        const slots = Array.isArray(day?.slots) ? day.slots : [];
        for (const slot of slots as Record<string, unknown>[]) {
          const id = String(slot?.startAt ?? '');
          if (!ISO_INSTANT.test(id)) continue;
          rows.push({
            id,
            title: this.clip(
              `${this.dayLabel(String(day.date ?? ''))} ${String(slot.localTime ?? '')}`.trim(),
              24,
            ),
          });
        }
      }
    }
    return rows;
  }

  /** `2026-10-12` -> `Mon 12 Oct`; the date is branch-local, so no zone shift. */
  private dayLabel(date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
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
   *
   * Public: also reused by `WhatsappCoexistenceEchoService` to resolve the
   * same contact/customer identity for a `smb_message_echo`'s recipient —
   * one contact per (tenant, wa_id), never a second lookup implementation.
   */
  async findOrCreateContact(
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
   *
   * Public: also reused by `WhatsappCoexistenceEchoService` to render a
   * `smb_message_echo`'s content for the unified timeline — same message
   * object shape, same rendering rules, one implementation.
   */
  extractContent(message: MetaWebhookMessage): string | undefined {
    switch (message.type) {
      case 'text':
        return message.text?.body?.trim() || undefined;
      case 'interactive': {
        const i = message.interactive;
        const picked = i?.button_reply?.title ?? i?.list_reply?.title;
        const title = picked?.trim();
        if (!title) return undefined;
        // A tapped time slot carries only its label ("Mon 12 Oct 14:30"), which
        // loses the instant booking needs. Forward the row id solely when it is
        // an ISO instant — never an arbitrary id string.
        const rowId = i?.list_reply?.id;
        return typeof rowId === 'string' && ISO_INSTANT.test(rowId)
          ? `${title} (${rowId})`
          : title;
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
