import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { Message } from '../../entities/Conversations/Message';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { Conversation } from '../../entities/Conversations/Conversation';
import { Customer } from '../../entities/CRM/Customer';
import { WhatsappAiPolicyService } from './whatsapp-ai-policy.service';
import {
  ContactTurnBusyError,
  ContactTurnLockService,
} from './contact-turn-lock.service';
import { AppError, ErrorCode } from '../../common/errors';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { MessageStatusService } from '../conversations/message-status.service';
import { WhatsappMediaService } from './meta/whatsapp-media.service';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { WhatsappBotActorService } from './whatsapp-bot-actor.service';
import { CustomerService } from '../crm/customer.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { MetricsService } from '../../metrics/metrics.service';
import { AiWsRateLimitService } from '../ai-realtime/ai-ws-rate-limit.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import {
  AccessSource,
  QuotaPolicy,
} from '../subscription-billing/tenant-access-decision';

const TENANT = 't1';
const KEYWORDS = 'stop,unsubscribe,إلغاء,توقف';

describe('WhatsappInboundAiService — opt-out short-circuit (FND-024)', () => {
  let service: WhatsappInboundAiService;
  let contacts: MockRepository;
  let orchestrator: {
    handleStream: jest.Mock;
    recordInboundWithoutAnswer: jest.Mock;
  };
  let locks: { acquire: jest.Mock; release: jest.Mock; renew: jest.Mock };
  let messageStatus: { markFailed: jest.Mock };
  let conversationsRepo: MockRepository;
  let customersRepo: MockRepository;
  let lockService: ContactTurnLockService;
  let customers: {
    recordOptOut: jest.Mock;
    search: jest.Mock;
    create: jest.Mock;
  };
  let settings: { getTyped: jest.Mock };
  let messaging: { sendSession: jest.Mock };
  let conversationExecution: {
    recordProviderMessageId: jest.Mock;
    resolveWhatsappThread: jest.Mock;
    recordChannelMessageOnce: jest.Mock;
  };
  let media: { enqueueForMessage: jest.Mock };
  let botActor: { ensureBotActor: jest.Mock };
  let accounts: MockRepository;
  let aiConversations: MockRepository;
  let messageRepo: MockRepository;
  let access: { resolve: jest.Mock; shouldBlock: jest.Mock };
  let tenantSettings: MockRepository;
  let metrics: {
    recordWhatsappAiTurnFailure: jest.Mock;
    recordWhatsappAiDecision: jest.Mock;
  };
  let rateLimit: { checkAndRecord: jest.Mock };

  const allowed = (featureKey: FeatureKey) => ({
    allowed: true,
    tenantId: TENANT,
    featureKey,
    source: AccessSource.FEATURE_OVERRIDE,
    quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
  });

  const CUSTOMER = { id: 'cust-1' };
  const EXISTING_CONTACT = {
    id: 'contact-1',
    wa_id: '966500000000',
    customer: CUSTOMER,
  };

  beforeEach(async () => {
    metrics = {
      recordWhatsappAiTurnFailure: jest.fn(),
      recordWhatsappAiDecision: jest.fn(),
    };
    // No other turn holds the contact's lock unless a test says so.
    locks = {
      acquire: jest.fn().mockResolvedValue('lock-token'),
      release: jest.fn().mockResolvedValue(undefined),
      renew: jest.fn().mockResolvedValue(true),
    };
    messageStatus = { markFailed: jest.fn().mockResolvedValue(undefined) };
    conversationsRepo = createMockRepository();
    customersRepo = createMockRepository();
    // F-16: admission is open unless a test closes it.
    rateLimit = { checkAndRecord: jest.fn().mockResolvedValue({ allowed: true }) };
    contacts = createMockRepository();
    contacts.findOne.mockResolvedValue(EXISTING_CONTACT);
    // The clinic has NOT switched its AI assistant off unless a test says so.
    tenantSettings = createMockRepository();
    tenantSettings.findOne.mockResolvedValue({ id: 'ts-1', bot_enabled: true });
    orchestrator = {
      handleStream: jest
        .fn()
        .mockResolvedValue({ reply: { content: 'AI reply' } }),
      recordInboundWithoutAnswer: jest
        .fn()
        .mockResolvedValue({ handedOver: true }),
    };
    customers = {
      recordOptOut: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue({ data: [] }),
      create: jest.fn(),
    };
    settings = { getTyped: jest.fn().mockResolvedValue(KEYWORDS) };
    messaging = { sendSession: jest.fn().mockResolvedValue({ success: true }) };
    conversationExecution = {
      recordProviderMessageId: jest.fn().mockResolvedValue(undefined),
      // The thread an inbound message is stored on, and the (idempotent) write.
      resolveWhatsappThread: jest.fn().mockResolvedValue({ id: 'thread-1' }),
      recordChannelMessageOnce: jest
        .fn()
        .mockResolvedValue({ message: { id: 'msg-1' }, created: true }),
    };
    media = { enqueueForMessage: jest.fn() };
    botActor = {
      ensureBotActor: jest.fn().mockResolvedValue({
        id: 'bot-1',
        tenantId: TENANT,
        email: null,
        roles: [],
        permissions: [],
      }),
    };
    // The clinic's connected number the messages arrive on; no AI session yet.
    accounts = createMockRepository();
    accounts.findOne.mockResolvedValue({ id: 'acc-1' });
    aiConversations = createMockRepository();
    aiConversations.findOne.mockResolvedValue(null);
    messageRepo = createMockRepository();
    access = {
      resolve: jest.fn(async (_t: string, key: FeatureKey) => allowed(key)),
      shouldBlock: jest.fn().mockReturnValue(true),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappInboundAiService,
        { provide: getRepositoryToken(WhatsappContact), useValue: contacts },
        { provide: getRepositoryToken(TenantSetting), useValue: tenantSettings },
        {
          provide: getRepositoryToken(Message),
          useValue: messageRepo,
        },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        {
          provide: getRepositoryToken(AiConversation),
          useValue: aiConversations,
        },
        {
          provide: WhatsappMediaService,
          useValue: media,
        },
        { provide: AiOrchestratorService, useValue: orchestrator },
        {
          provide: ConversationExecutionService,
          useValue: conversationExecution,
        },
        { provide: WhatsappMessagingService, useValue: messaging },
        {
          provide: WhatsappMessageRouter,
          useValue: {
            resolveForSend: jest.fn().mockResolvedValue({
              id: 'acc-1',
              phoneNumberId: 'p1',
              mode: 'REAL',
            }),
          },
        },
        { provide: WhatsappBotActorService, useValue: botActor },
        { provide: CustomerService, useValue: customers },
        { provide: TenantContextService, useValue: new TenantContextService() },
        { provide: SystemSettingService, useValue: settings },
        { provide: AccessControlService, useValue: access },
        { provide: MetricsService, useValue: metrics },
        { provide: AiWsRateLimitService, useValue: rateLimit },
        // The REAL policy and lock, over mocked infrastructure: the assertions
        // below are about what the bridge does with their answers.
        WhatsappAiPolicyService,
        ContactTurnLockService,
        { provide: DistributedLockService, useValue: locks },
        { provide: MessageStatusService, useValue: messageStatus },
        {
          provide: getRepositoryToken(Conversation),
          useValue: conversationsRepo,
        },
        // The policy's patient rule. Nobody is excluded unless a test says so.
        { provide: getRepositoryToken(Customer), useValue: customersRepo },
      ],
    }).compile();
    service = moduleRef.get(WhatsappInboundAiService);
    lockService = moduleRef.get(ContactTurnLockService);
    // Real timers, so keep the lock's waits short.
    lockService.timings = { ttlMs: 1000, renewMs: 500, waitMs: 30, pollMs: 5 };
  });

  /**
   * The inbound webhook JOB is deliberately un-gated so customer messages are
   * never lost while a clinic is blocked. What this bridge DOES with them —
   * running an AI turn and replying over WhatsApp — is gated, and this is where
   * that is proved.
   */
  describe('entitlement (closes the webhook execution bypass)', () => {
    it('asks the policy for both capabilities it exercises', async () => {
      await service.handleInboundValue(TENANT, {
        messages: [
          {
            id: 'w1',
            from: '966500000000',
            type: 'text',
            text: { body: 'hi' },
          },
        ],
      } as never);

      expect(access.resolve).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.AI_ASSISTANT,
      );
      expect(access.resolve).toHaveBeenCalledWith(TENANT, FeatureKey.WHATSAPP);
    });

    it.each([FeatureKey.AI_ASSISTANT, FeatureKey.WHATSAPP])(
      'runs no AI turn and sends no reply when "%s" is denied',
      async (deniedKey) => {
        access.resolve.mockImplementation(
          async (_t: string, key: FeatureKey) =>
            key === deniedKey
              ? {
                  allowed: false,
                  tenantId: TENANT,
                  featureKey: key,
                  source: AccessSource.DENIED,
                  quotaPolicy: QuotaPolicy.BLOCKED,
                }
              : allowed(key),
        );

        await service.handleInboundValue(TENANT, {
          messages: [
            {
              id: 'w1',
              from: '966500000000',
              type: 'text',
              text: { body: 'hi' },
            },
          ],
        } as never);

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled();
      },
    );

    it('fails CLOSED when the decision cannot be resolved', async () => {
      access.resolve.mockRejectedValue(new Error('db down'));

      await service.handleInboundValue(TENANT, {
        messages: [
          {
            id: 'w1',
            from: '966500000000',
            type: 'text',
            text: { body: 'hi' },
          },
        ],
      } as never);

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
    });
  });

  /**
   * `tenant_settings.bot_enabled` (Settings → "AI assistant"). The clinic's own
   * kill-switch: distinct from the entitlement gate above, and it must actually
   * stop the bot — before this, the column was saved and displayed but read by
   * nothing that decides whether to answer.
   */
  describe('clinic AI-assistant switch (tenant_settings.bot_enabled)', () => {
    const inbound = {
      messages: [
        { id: 'w1', from: '966500000000', type: 'text', text: { body: 'hi' } },
      ],
    } as never;

    it('answers when the clinic has the assistant on', async () => {
      await service.handleInboundValue(TENANT, inbound);

      expect(orchestrator.handleStream).toHaveBeenCalledTimes(1);
      expect(messaging.sendSession).toHaveBeenCalledTimes(1);
    });

    it('runs no AI turn and sends no reply when the clinic switched it OFF', async () => {
      tenantSettings.findOne.mockResolvedValue({
        id: 'ts-1',
        bot_enabled: false,
      });

      await service.handleInboundValue(TENANT, inbound);

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(messaging.sendSession).not.toHaveBeenCalled();
      // Entitlement is decided first: a clinic's own switch can only narrow what
      // its plan allows, so the plan is the outer gate (subscription → feature →
      // clinic switch → conversation).
      expect(access.resolve).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.AI_ASSISTANT,
      );
    });

    it("reads THIS tenant's row, never another clinic's", async () => {
      await service.handleInboundValue(TENANT, inbound);

      expect(tenantSettings.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenant: { id: TENANT } } }),
      );
    });

    it('keeps the column default (on) for a clinic with no settings row yet', async () => {
      tenantSettings.findOne.mockResolvedValue(null);

      await service.handleInboundValue(TENANT, inbound);

      expect(orchestrator.handleStream).toHaveBeenCalledTimes(1);
    });

    it('fails CLOSED when the switch cannot be read', async () => {
      tenantSettings.findOne.mockRejectedValue(new Error('db down'));

      await service.handleInboundValue(TENANT, inbound);

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(messaging.sendSession).not.toHaveBeenCalled();
    });
  });

  it('[FND-024] records the opt-out and never calls the AI orchestrator when the inbound message matches a configured keyword', async () => {
    await service.handleInboundValue(TENANT, {
      messages: [
        {
          id: 'wamid-1',
          from: '966500000000',
          type: 'text',
          text: { body: 'STOP' },
        },
      ],
    } as never);

    expect(settings.getTyped).toHaveBeenCalledWith(
      SettingKey.WHATSAPP_OPT_OUT_KEYWORDS,
    );
    expect(customers.recordOptOut).toHaveBeenCalledWith(
      TENANT,
      'cust-1',
      'inbound_keyword',
    );
    expect(orchestrator.handleStream).not.toHaveBeenCalled();
    expect(messaging.sendSession).not.toHaveBeenCalled();
  });

  it('matches an Arabic opt-out keyword the same way', async () => {
    await service.handleInboundValue(TENANT, {
      messages: [
        {
          id: 'wamid-2',
          from: '966500000000',
          type: 'text',
          text: { body: 'إلغاء' },
        },
      ],
    } as never);

    expect(customers.recordOptOut).toHaveBeenCalledWith(
      TENANT,
      'cust-1',
      'inbound_keyword',
    );
    expect(orchestrator.handleStream).not.toHaveBeenCalled();
  });

  it('proceeds to the AI turn normally for an ordinary message (regression guard)', async () => {
    await service.handleInboundValue(TENANT, {
      messages: [
        {
          id: 'wamid-3',
          from: '966500000000',
          type: 'text',
          text: { body: 'What time do you open?' },
        },
      ],
    } as never);

    expect(customers.recordOptOut).not.toHaveBeenCalled();
    expect(orchestrator.handleStream).toHaveBeenCalled();
  });

  /**
   * Regression for the customer-impersonation gap this bridge used to have:
   * the WhatsApp contact's bound customer MUST reach the orchestrator via the
   * UNFILTERED `trustedSessionPatch` — not `sessionPatch`, which always
   * passes through `ConversationSessionService.patchFromClient` and silently
   * strips `context.customerId` (`SESSION_CONTEXT_SERVER_ONLY_KEYS`). Before
   * this fix, `context.customerId` was set via `sessionPatch` and never
   * persisted, so `AiToolDispatchService.bookAppointment`'s
   * `ctx.customerId ?? args.customerId` fell through to whatever `customerId`
   * the model supplied — a WhatsApp turn could book against a customer the
   * patient never proved they were.
   */
  it("F-13: marks the turn as the bridge's own — the only caller allowed to claim the WHATSAPP channel", async () => {
    await service.handleInboundValue(TENANT, {
      messages: [
        { id: 'wamid-5', from: '966500000000', type: 'text', text: { body: 'hi' } },
      ],
    } as never);

    const [, input] = orchestrator.handleStream.mock.calls[0];
    expect(input.channel).toBe('WHATSAPP');
    expect(input.trustedChannel).toBe(true);
  });

  describe('per-contact admission (F-16)', () => {
    afterEach(() => jest.restoreAllMocks());
    const inbound = {
      messages: [
        { id: 'w1', from: '966500000000', type: 'text', text: { body: 'hi' } },
      ],
    } as never;
    const refuse = (count: number, limit = 20, tier = 'whatsapp-contact') =>
      rateLimit.checkAndRecord.mockImplementation(async (_id: string, t: string) =>
        t === tier
          ? { allowed: false, code: 'RATE_LIMITED', tier, count, limit }
          : { allowed: true },
      );

    it("keys the limit to THIS clinic's line and THIS number — never a number alone", async () => {
      await service.handleInboundValue(TENANT, inbound);

      expect(rateLimit.checkAndRecord).toHaveBeenCalledWith(
        `${TENANT}:966500000000`,
        'whatsapp-contact',
      );
      expect(rateLimit.checkAndRecord).toHaveBeenCalledWith(
        `${TENANT}:966500000000`,
        'whatsapp-contact-day',
      );
    });

    it('runs no AI turn past the limit', async () => {
      refuse(21);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
    });

    it('tells the contact ONCE — on the message that first crosses the limit — in both languages', async () => {
      refuse(21); // limit 20 → this is the first refused message
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);

      expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      const sent = messaging.sendSession.mock.calls[0][0];
      expect(sent.to).toBe('966500000000');
      expect(sent.text).toMatch(/faster than I can answer/i);
      expect(sent.text).toMatch(/[؀-ۿ]/);
      expect(sent.text).not.toMatch(/\d/); // no clinic fact in it
    });

    it('stays SILENT for every message after that one — the flood gets no replies to pay for', async () => {
      refuse(22);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(messaging.sendSession).not.toHaveBeenCalled();
    });

    it('the daily limit has its own notice', async () => {
      refuse(301, 300, 'whatsapp-contact-day');
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);

      expect(messaging.sendSession.mock.calls[0][0].text).toMatch(/limit for automated replies today/i);
    });

    it('an opt-out is still honoured while the contact is over the limit', async () => {
      refuse(30);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, {
        messages: [
          { id: 'w9', from: '966500000000', type: 'text', text: { body: 'stop' } },
        ],
      } as never);

      expect(customers.recordOptOut).toHaveBeenCalledWith(TENANT, 'cust-1', 'inbound_keyword');
    });

    it('never writes the patient phone number to the refusal log line', async () => {
      refuse(21);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);

      expect(warn.mock.calls.flat().join(' ')).not.toContain('966500000000');
    });

    it('a failed notice send is contained', async () => {
      refuse(21);
      messaging.sendSession.mockRejectedValue(new Error('meta down'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(service.handleInboundValue(TENANT, inbound)).resolves.toBeUndefined();
    });
  });

  it('binds the contact\'s customer via trustedSessionPatch, never sessionPatch', async () => {
    await service.handleInboundValue(TENANT, {
      messages: [
        {
          id: 'wamid-4',
          from: '966500000000',
          type: 'text',
          text: { body: 'احجز لي كشف جلدية بكرة بعد العصر' },
        },
      ],
    } as never);

    expect(orchestrator.handleStream).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        trustedSessionPatch: { context: { customerId: CUSTOMER.id } },
      }),
      expect.any(Function),
    );
    const [, input] = orchestrator.handleStream.mock.calls[0];
    expect(input.sessionPatch).toBeUndefined();
  });

  it('[FND-023] records the provider message id onto the mirrored bot reply after a successful send', async () => {
    orchestrator.handleStream.mockResolvedValueOnce({
      reply: { content: 'We open at 9am' },
      mirroredMessageId: 'msg-bot-1',
    });
    messaging.sendSession.mockResolvedValueOnce({
      success: true,
      providerMessageId: 'wamid.bot-reply-1',
    });

    await service.handleInboundValue(TENANT, {
      messages: [
        {
          id: 'wamid-5',
          from: '966500000000',
          type: 'text',
          text: { body: 'What time do you open?' },
        },
      ],
    } as never);

    expect(conversationExecution.recordProviderMessageId).toHaveBeenCalledWith(
      TENANT,
      'msg-bot-1',
      'wamid.bot-reply-1',
    );
  });

  it('[FND-023] does not attempt to record a provider id when the orchestrator mirrored nothing (no linked conversation)', async () => {
    orchestrator.handleStream.mockResolvedValueOnce({
      reply: { content: 'We open at 9am' },
      mirroredMessageId: null,
    });
    messaging.sendSession.mockResolvedValueOnce({
      success: true,
      providerMessageId: 'wamid.bot-reply-2',
    });

    await service.handleInboundValue(TENANT, {
      messages: [
        {
          id: 'wamid-6',
          from: '966500000000',
          type: 'text',
          text: { body: 'What time do you open?' },
        },
      ],
    } as never);

    expect(
      conversationExecution.recordProviderMessageId,
    ).not.toHaveBeenCalled();
  });

  it('does not check consent (and proceeds normally) when the contact has no linked customer yet', async () => {
    contacts.findOne.mockResolvedValueOnce({
      id: 'contact-2',
      wa_id: '966500000000',
      customer: null,
    });

    await service.handleInboundValue(TENANT, {
      messages: [
        {
          id: 'wamid-4',
          from: '966500000000',
          type: 'text',
          text: { body: 'STOP' },
        },
      ],
    } as never);

    // No customer exists yet to attach the opt-out to — the pre-existing
    // findOrCreateContact() flow still creates one downstream via the normal
    // AI turn; this test only asserts the guard doesn't throw or dead-end
    // trying to record consent against a non-existent customer id.
    expect(customers.recordOptOut).not.toHaveBeenCalled();
  });

  /**
   * F-25 — a turn that throws used to leave one log line and a silent patient.
   */
  describe('a failed AI turn is never silent (F-25)', () => {
    afterEach(() => jest.restoreAllMocks()); // the Logger spies below
    const inbound = {
      messages: [
        { id: 'w1', from: '966500000000', type: 'text', text: { body: 'hi' } },
      ],
    } as never;

    it('tells the patient it could not answer, once, with no clinic data in it', async () => {
      orchestrator.handleStream.mockRejectedValue(new Error('boom'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);

      expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      const sent = messaging.sendSession.mock.calls[0][0];
      expect(sent.to).toBe('966500000000');
      expect(sent.tenantId).toBe(TENANT);
      expect(sent.text).toMatch(/could not process your message/i);
      expect(sent.text).toMatch(/[؀-ۿ]/); // Arabic half present
      expect(sent.text).not.toMatch(/\d/); // no time, price or phone in it
    });

    it('raises the alert counter, recording whether the fallback reached the patient', async () => {
      orchestrator.handleStream.mockRejectedValue(new Error('boom'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);
      expect(metrics.recordWhatsappAiTurnFailure).toHaveBeenLastCalledWith('sent');

      messaging.sendSession.mockResolvedValue({ success: false, error: 'x' });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await service.handleInboundValue(TENANT, inbound);
      expect(metrics.recordWhatsappAiTurnFailure).toHaveBeenLastCalledWith('not_sent');
    });

    it('a failing fallback send is contained and does not block the next message in the batch', async () => {
      orchestrator.handleStream
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ reply: { content: 'second reply' } });
      messaging.sendSession
        .mockRejectedValueOnce(new Error('meta down'))
        .mockResolvedValue({ success: true });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, {
        messages: [
          { id: 'w1', from: '966500000000', type: 'text', text: { body: 'a' } },
          { id: 'w2', from: '966500000000', type: 'text', text: { body: 'b' } },
        ],
      } as never);

      expect(orchestrator.handleStream).toHaveBeenCalledTimes(2);
      expect(messaging.sendSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'second reply' }),
      );
    });

    it('sends no fallback on a healthy turn', async () => {
      await service.handleInboundValue(TENANT, inbound);

      expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      expect(messaging.sendSession.mock.calls[0][0].text).toBe('AI reply');
      expect(metrics.recordWhatsappAiTurnFailure).not.toHaveBeenCalled();
    });

    it('never writes the patient phone number to the failure log (FND-016)', async () => {
      orchestrator.handleStream.mockRejectedValue(new Error('boom'));
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound);

      expect(
        errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n'),
      ).not.toContain('966500000000');
    });
  });

  /**
   * P1a — STORE FIRST, DECIDE AFTER. Switching the assistant off (or not being
   * entitled to it) must change who ANSWERS, never whether staff can SEE the
   * patient's message.
   */
  describe('store first, decide after', () => {
    afterEach(() => jest.restoreAllMocks());

    const inbound = (over: Record<string, unknown> = {}) =>
      ({
        metadata: { phone_number_id: 'p1' },
        messages: [
          {
            id: 'wamid-s1',
            from: '966500000000',
            type: 'text',
            text: { body: 'hello' },
            ...over,
          },
        ],
      }) as never;

    const assistantOff = () =>
      tenantSettings.findOne.mockResolvedValue({
        id: 'ts-1',
        bot_enabled: false,
      });

    it('stores the message on the timeline thread, keyed by its wamid', async () => {
      await service.handleInboundValue(TENANT, inbound());

      expect(
        conversationExecution.recordChannelMessageOnce,
      ).toHaveBeenCalledWith(
        TENANT,
        'thread-1',
        'CUSTOMER',
        'hello',
        undefined,
        { waMessageId: 'wamid-s1', messageType: 'text' },
      );
    });

    it('stores it, but runs no AI and sends no reply, when the clinic switched the assistant OFF', async () => {
      assistantOff();

      await service.handleInboundValue(TENANT, inbound());

      expect(
        conversationExecution.recordChannelMessageOnce,
      ).toHaveBeenCalledTimes(1);
      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(messaging.sendSession).not.toHaveBeenCalled();
      // No bot user is provisioned for a clinic that never uses the assistant.
      expect(botActor.ensureBotActor).not.toHaveBeenCalled();
    });

    it('stores it, but runs no AI and sends no reply, when the clinic is not entitled', async () => {
      access.resolve.mockImplementation(async (_t: string, key: FeatureKey) =>
        key === FeatureKey.AI_ASSISTANT
          ? {
              allowed: false,
              tenantId: TENANT,
              featureKey: key,
              source: AccessSource.DENIED,
              quotaPolicy: QuotaPolicy.BLOCKED,
            }
          : allowed(key),
      );

      await service.handleInboundValue(TENANT, inbound());

      expect(
        conversationExecution.recordChannelMessageOnce,
      ).toHaveBeenCalledTimes(1);
      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(messaging.sendSession).not.toHaveBeenCalled();
    });

    it('queues inbound media for a stored message even while the assistant is off', async () => {
      assistantOff();
      messageRepo.findOne.mockResolvedValue({
        id: 'msg-1',
        conversation: { whatsapp_account: { id: 'acc-1' } },
      });

      await service.handleInboundValue(
        TENANT,
        inbound({ type: 'image', image: { id: 'media-1' }, text: undefined }),
      );

      expect(media.enqueueForMessage).toHaveBeenCalledWith(
        TENANT,
        'acc-1',
        'msg-1',
        expect.objectContaining({ id: 'wamid-s1' }),
      );
      expect(orchestrator.handleStream).not.toHaveBeenCalled();
    });

    it('still honours a STOP while the assistant is off', async () => {
      assistantOff();

      await service.handleInboundValue(
        TENANT,
        inbound({ text: { body: 'STOP' } }),
      );

      expect(customers.recordOptOut).toHaveBeenCalledWith(
        TENANT,
        'cust-1',
        'inbound_keyword',
      );
      expect(
        conversationExecution.recordChannelMessageOnce,
      ).toHaveBeenCalledTimes(1);
      expect(messaging.sendSession).not.toHaveBeenCalled();
    });

    it('stores every message of a batch before it decides anything', async () => {
      await service.handleInboundValue(TENANT, {
        metadata: { phone_number_id: 'p1' },
        messages: [
          { id: 'w1', from: '966500000000', type: 'text', text: { body: 'a' } },
          { id: 'w2', from: '966500000000', type: 'text', text: { body: 'b' } },
        ],
      } as never);

      const lastStore = Math.max(
        ...conversationExecution.recordChannelMessageOnce.mock
          .invocationCallOrder,
      );
      const firstTurn = Math.min(
        ...orchestrator.handleStream.mock.invocationCallOrder,
      );
      expect(lastStore).toBeLessThan(firstTurn);
    });

    it('binds the AI turn to the thread the message was stored on', async () => {
      await service.handleInboundValue(TENANT, inbound());

      expect(orchestrator.handleStream).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          trustedChannel: true,
          conversationId: 'thread-1',
          origin: { waMessageId: 'wamid-s1', messageType: 'text' },
        }),
        expect.any(Function),
      );
    });

    it("prefers the thread the contact's AI session is already bound to, looked up tenant-scoped", async () => {
      contacts.findOne.mockResolvedValue({
        ...EXISTING_CONTACT,
        ai_conversation_id: 'ai-1',
      });
      aiConversations.findOne.mockResolvedValue({
        id: 'ai-1',
        conversation: { id: 'handover-thread' },
      });

      await service.handleInboundValue(TENANT, inbound());

      expect(aiConversations.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ai-1', tenant: { id: TENANT } },
        }),
      );
      expect(conversationExecution.resolveWhatsappThread).toHaveBeenCalledWith(
        TENANT,
        'cust-1',
        'acc-1',
        'handover-thread',
      );
    });

    it("resolves the account from THIS tenant's live accounts only", async () => {
      await service.handleInboundValue(TENANT, inbound());

      expect(accounts.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            phone_number_id: 'p1',
            tenant: { id: TENANT },
          }),
        }),
      );
    });

    it('still answers when no connected account matches the receiving number (nothing to store it on)', async () => {
      accounts.findOne.mockResolvedValue(null);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound());

      expect(
        conversationExecution.recordChannelMessageOnce,
      ).not.toHaveBeenCalled();
      expect(orchestrator.handleStream).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ conversationId: undefined }),
        expect.any(Function),
      );
    });

    it('a message already on the timeline (a job retry) still gets its AI turn', async () => {
      // The first attempt may have died after storing it but before replying;
      // stopping here would leave the patient unanswered for good. The AI
      // request claim (keyed on the wamid) is what prevents a second model run.
      conversationExecution.recordChannelMessageOnce.mockResolvedValue({
        message: { id: 'msg-1' },
        created: false,
      });

      await service.handleInboundValue(TENANT, inbound());

      expect(orchestrator.handleStream).toHaveBeenCalledTimes(1);
    });

    it('stays silent toward the patient, but logs an error, when storing fails and the assistant is off', async () => {
      assistantOff();
      conversationExecution.resolveWhatsappThread.mockRejectedValue(
        new Error('db down'),
      );
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound());

      expect(messaging.sendSession).not.toHaveBeenCalled();
      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not be stored on the timeline'),
      );
    });

    it('keeps the "could not answer" fallback when storing fails and the assistant is on', async () => {
      conversationExecution.resolveWhatsappThread.mockRejectedValue(
        new Error('db down'),
      );
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await service.handleInboundValue(TENANT, inbound());

      expect(orchestrator.handleStream).not.toHaveBeenCalled();
      expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      expect(messaging.sendSession.mock.calls[0][0].text).toMatch(
        /could not process your message/i,
      );
      expect(metrics.recordWhatsappAiTurnFailure).toHaveBeenCalledWith('sent');
    });

    it('never writes the patient phone number to any log while storing', async () => {
      assistantOff();
      conversationExecution.resolveWhatsappThread.mockRejectedValue(
        new Error('db down'),
      );
      const spies = (['debug', 'log', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );

      await service.handleInboundValue(TENANT, inbound());
      accounts.findOne.mockResolvedValue(null);
      await service.handleInboundValue(TENANT, inbound());

      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(logged).not.toContain('966500000000');
    });
  });

  /**
   * P1b — the policy is enforced by the backend, before the model is called AND
   * again right before the send. Checking only at the start is not enough: staff
   * can pause the AI, take the chat, or the clinic can switch the assistant off
   * while a turn is already running.
   */
  describe('policy enforcement', () => {
    afterEach(() => jest.restoreAllMocks());

    const inbound = (over: Record<string, unknown> = {}) =>
      ({
        metadata: { phone_number_id: 'p1' },
        messages: [
          {
            id: 'wamid-p1',
            from: '966500000000',
            type: 'text',
            text: { body: 'hello' },
            ...over,
          },
        ],
      }) as never;

    const thread = (owner: 'AI' | 'HUMAN') => ({
      id: 'thread-1',
      owner_type: owner,
    });
    const withAiSession = () => {
      contacts.findOne.mockResolvedValue({
        ...EXISTING_CONTACT,
        ai_conversation_id: 'ai-1',
      });
    };
    const decisions = (stage: string) =>
      metrics.recordWhatsappAiDecision.mock.calls.filter((c) => c[2] === stage);

    /**
     * P1c — staff and clinic controls, enforced here on the backend. Each case
     * proves the same three things: the model is not called, nothing is sent,
     * and the patient's message is still stored for staff to read.
     */
    describe('conversation and patient controls', () => {
      const FUTURE = () => new Date(Date.now() + 10 * 60_000);
      const answer = () =>
        orchestrator.handleStream.mockResolvedValue({
          reply: { content: 'AI reply' },
          mirroredMessageId: 'bot-msg-1',
        });
      const pausedThread = (over: Record<string, unknown> = {}) => ({
        id: 'thread-1',
        owner_type: 'AI',
        ai_mode: 'DISABLED',
        customer: { id: 'cust-1' },
        ...over,
      });

      it('a conversation paused by staff: no model call, no send, message stored', async () => {
        conversationsRepo.findOne.mockResolvedValue(pausedThread());

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(botActor.ensureBotActor).not.toHaveBeenCalled();
        expect(
          conversationExecution.recordChannelMessageOnce,
        ).toHaveBeenCalledTimes(1);
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'CONVERSATION_AI_DISABLED',
          'pre_ai',
        );
        expect(metrics.recordWhatsappAiTurnFailure).not.toHaveBeenCalled();
      });

      it('keeps a paused conversation’s messages in the AI history, so the AI is not missing them when staff resume', async () => {
        withAiSession();
        conversationsRepo.findOne.mockResolvedValue(pausedThread());

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.recordInboundWithoutAnswer).toHaveBeenCalledWith(
          TENANT,
          'ai-1',
          'hello',
          { waMessageId: 'wamid-p1', messageType: 'text' },
        );
      });

      it('a patient excluded from the AI: no model call, no send, message stored', async () => {
        customersRepo.findOne.mockResolvedValue({
          id: 'cust-1',
          ai_replies_disabled: true,
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(botActor.ensureBotActor).not.toHaveBeenCalled();
        expect(
          conversationExecution.recordChannelMessageOnce,
        ).toHaveBeenCalledTimes(1);
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'PATIENT_AI_DISABLED',
          'pre_ai',
        );
      });

      it('an excluded patient’s message is NOT fed into an AI history', async () => {
        withAiSession();
        customersRepo.findOne.mockResolvedValue({
          id: 'cust-1',
          ai_replies_disabled: true,
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.recordInboundWithoutAnswer).not.toHaveBeenCalled();
      });

      it('excluding one patient leaves another patient’s conversation answered', async () => {
        // The policy is asked about THIS message's patient: the exclusion lookup
        // is by that patient, so someone else's flag cannot reach this turn.
        customersRepo.findOne.mockImplementation(
          async ({ where }: { where: { id: string } }) => ({
            id: where.id,
            ai_replies_disabled: where.id === 'someone-else',
          }),
        );
        conversationsRepo.findOne.mockResolvedValue(thread('AI'));
        answer();

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).toHaveBeenCalledTimes(1);
        expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      });

      it('an automatic takeover window in the future: no model call, no send', async () => {
        conversationsRepo.findOne.mockResolvedValue({
          ...thread('AI'),
          ai_mode: 'DEFAULT',
          ai_paused_until: FUTURE(),
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'HUMAN_TAKEOVER',
          'pre_ai',
        );
      });

      it('the AI answers again once the window has elapsed', async () => {
        conversationsRepo.findOne.mockResolvedValue({
          ...thread('AI'),
          ai_mode: 'DEFAULT',
          ai_paused_until: new Date(Date.now() - 60_000),
        });
        answer();

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).toHaveBeenCalledTimes(1);
        expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      });

      it('does not send when staff pause the conversation while the model is answering', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('AI'));
        orchestrator.handleStream.mockImplementation(async () => {
          conversationsRepo.findOne.mockResolvedValue(pausedThread());
          return {
            reply: { content: 'AI reply' },
            mirroredMessageId: 'bot-msg-1',
          };
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).toHaveBeenCalledTimes(1);
        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(messageStatus.markFailed).toHaveBeenCalledWith(
          TENANT,
          'bot-msg-1',
        );
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'CONVERSATION_AI_DISABLED',
          'pre_send',
        );
      });

      it('does not send when a patient is excluded while the model is answering', async () => {
        orchestrator.handleStream.mockImplementation(async () => {
          customersRepo.findOne.mockResolvedValue({
            id: 'cust-1',
            ai_replies_disabled: true,
          });
          return { reply: { content: 'AI reply' }, mirroredMessageId: null };
        });
        conversationsRepo.findOne.mockResolvedValue(thread('AI'));

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'PATIENT_AI_DISABLED',
          'pre_send',
        );
      });

      it('a refused message still gets no apology — the "could not process" fallback is gated too', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('AI'));
        orchestrator.handleStream.mockImplementation(async () => {
          conversationsRepo.findOne.mockResolvedValue(pausedThread());
          throw new Error('boom');
        });
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).not.toHaveBeenCalled();
      });

      it('logs ids only — never the message, the phone number or the patient', async () => {
        const logSpy = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => undefined);
        customersRepo.findOne.mockResolvedValue({
          id: 'cust-1',
          ai_replies_disabled: true,
        });

        await service.handleInboundValue(TENANT, inbound());

        const logged = logSpy.mock.calls
          .map((c) => c.map(String).join(' '))
          .join('\n');
        expect(logged).toContain('reason=PATIENT_AI_DISABLED');
        expect(logged).not.toContain('hello');
        expect(logged).not.toContain('966500000000');
      });
    });

    describe('before the model is called', () => {
      it('stops a conversation a person owns — no model call, no send, no bot user', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(botActor.ensureBotActor).not.toHaveBeenCalled();
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'HUMAN_TAKEOVER',
          'pre_ai',
        );
        // …and it is not treated as an error.
        expect(metrics.recordWhatsappAiTurnFailure).not.toHaveBeenCalled();
      });

      it('stops an AI session that is HANDED_OVER even if the conversation still says AI', async () => {
        withAiSession();
        conversationsRepo.findOne.mockResolvedValue(thread('AI'));
        aiConversations.findOne.mockResolvedValue({
          id: 'ai-1',
          status: 'HANDED_OVER',
          conversation: { id: 'thread-1' },
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled();
      });

      it('still stores the message when a person owns the conversation', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));

        await service.handleInboundValue(TENANT, inbound());

        expect(
          conversationExecution.recordChannelMessageOnce,
        ).toHaveBeenCalledTimes(1);
      });

      it('keeps the message in the AI history and notifies the agent, as a handed-over turn always did', async () => {
        withAiSession();
        conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.recordInboundWithoutAnswer).toHaveBeenCalledWith(
          TENANT,
          'ai-1',
          'hello',
          { waMessageId: 'wamid-p1', messageType: 'text' },
        );
      });

      it('has no AI history to add to when the contact never had an AI session', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.recordInboundWithoutAnswer).not.toHaveBeenCalled();
      });

      it('adds nothing for a refusal that is not a takeover (the clinic switched the assistant off)', async () => {
        withAiSession();
        tenantSettings.findOne.mockResolvedValue({
          id: 'ts-1',
          bot_enabled: false,
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.recordInboundWithoutAnswer).not.toHaveBeenCalled();
      });

      it('contains a failure while recording it — the batch carries on', async () => {
        withAiSession();
        conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));
        orchestrator.recordInboundWithoutAnswer.mockRejectedValue(
          new Error('db hiccup'),
        );
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await expect(
          service.handleInboundValue(TENANT, inbound()),
        ).resolves.toBeUndefined();
      });
    });

    describe('again, right before the send — the AI must not reply after being paused mid-turn', () => {
      const answer = () =>
        orchestrator.handleStream.mockResolvedValue({
          reply: { content: 'AI reply' },
          mirroredMessageId: 'bot-msg-1',
        });

      it('does not send when staff take the conversation while the model is answering', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('AI'));
        orchestrator.handleStream.mockImplementation(async () => {
          // The agent takes the chat during the model call.
          conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));
          return {
            reply: { content: 'AI reply' },
            mirroredMessageId: 'bot-msg-1',
          };
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).toHaveBeenCalledTimes(1); // the model WAS spent
        expect(messaging.sendSession).not.toHaveBeenCalled(); // …but nothing reached the patient
        expect(decisions('pre_ai')).toContainEqual([
          'ALLOW',
          'ALLOWED',
          'pre_ai',
        ]);
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'HUMAN_TAKEOVER',
          'pre_send',
        );
      });

      it('does not send when the clinic switches the assistant off while the model is answering', async () => {
        orchestrator.handleStream.mockImplementation(async () => {
          tenantSettings.findOne.mockResolvedValue({
            id: 'ts-1',
            bot_enabled: false,
          });
          return {
            reply: { content: 'AI reply' },
            mirroredMessageId: 'bot-msg-1',
          };
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(metrics.recordWhatsappAiDecision).toHaveBeenCalledWith(
          'SKIP',
          'CLINIC_AI_DISABLED',
          'pre_send',
        );
      });

      it('marks the already-mirrored bot reply FAILED, so the inbox does not show it as sent', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('AI'));
        orchestrator.handleStream.mockImplementation(async () => {
          conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));
          return {
            reply: { content: 'AI reply' },
            mirroredMessageId: 'bot-msg-1',
          };
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(messageStatus.markFailed).toHaveBeenCalledWith(
          TENANT,
          'bot-msg-1',
        );
      });

      it('has nothing to mark when the reply was never mirrored', async () => {
        orchestrator.handleStream.mockImplementation(async () => {
          conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));
          return { reply: { content: 'AI reply' }, mirroredMessageId: null };
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(messageStatus.markFailed).not.toHaveBeenCalled();
      });

      it('contains a failure while marking — the suppressed reply is still not sent', async () => {
        orchestrator.handleStream.mockImplementation(async () => {
          conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));
          return {
            reply: { content: 'AI reply' },
            mirroredMessageId: 'bot-msg-1',
          };
        });
        messageStatus.markFailed.mockRejectedValue(
          new Error('unique violation'),
        );
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).not.toHaveBeenCalled();
      });

      it('sends normally when nothing changed during the turn', async () => {
        answer();

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).toHaveBeenCalledTimes(1);
        expect(decisions('pre_send')).toEqual([
          ['ALLOW', 'ALLOWED', 'pre_send'],
        ]);
      });

      it('applies to the "could not process" fallback too', async () => {
        orchestrator.handleStream.mockImplementation(async () => {
          conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));
          throw new Error('boom');
        });
        jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(metrics.recordWhatsappAiTurnFailure).toHaveBeenCalledWith(
          'not_sent',
        );
      });

      it('applies to the rate-limit notice too', async () => {
        rateLimit.checkAndRecord.mockResolvedValue({
          allowed: false,
          count: 6,
          limit: 5,
        });
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        // Allowed when the turn starts, taken over by the time the notice is due.
        conversationsRepo.findOne
          .mockResolvedValueOnce(thread('AI'))
          .mockResolvedValue(thread('HUMAN'));

        await service.handleInboundValue(TENANT, inbound());

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled();
      });
    });

    describe('a replayed turn does not deliver its answer twice', () => {
      beforeEach(() =>
        orchestrator.handleStream.mockResolvedValue({
          reply: { content: 'AI reply' },
          mirroredMessageId: 'bot-msg-1',
        }),
      );

      it('skips the send when the mirrored reply already carries its provider id', async () => {
        messageRepo.findOne.mockResolvedValue({
          id: 'bot-msg-1',
          wa_message_id: 'wamid.out.1',
        });

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(
          conversationExecution.recordProviderMessageId,
        ).not.toHaveBeenCalled();
        expect(messageRepo.findOne).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'bot-msg-1', tenant: { id: TENANT } },
          }),
        );
      });

      it('sends when the first attempt never got as far as a provider id', async () => {
        messageRepo.findOne.mockResolvedValue({ id: 'bot-msg-1' });

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      });

      it('sends rather than going silent when the check itself fails', async () => {
        messageRepo.findOne.mockRejectedValue(new Error('db hiccup'));
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).toHaveBeenCalledTimes(1);
      });
    });

    describe('one AI turn per contact at a time', () => {
      it('holds a per-contact lock for the turn and releases it afterwards', async () => {
        await service.handleInboundValue(TENANT, inbound());

        expect(locks.acquire).toHaveBeenCalledTimes(1);
        const key = locks.acquire.mock.calls[0][0] as string;
        expect(key).toContain(TENANT);
        expect(key).not.toContain('966500000000');
        expect(locks.release).toHaveBeenCalledWith(key, 'lock-token');
        // The lock is held across the model call and the send.
        expect(locks.acquire.mock.invocationCallOrder[0]).toBeLessThan(
          orchestrator.handleStream.mock.invocationCallOrder[0],
        );
        expect(locks.release.mock.invocationCallOrder[0]).toBeGreaterThan(
          messaging.sendSession.mock.invocationCallOrder[0],
        );
      });

      it('takes no lock — and spends nothing — for a message the policy refuses', async () => {
        conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));

        await service.handleInboundValue(TENANT, inbound());

        expect(locks.acquire).not.toHaveBeenCalled();
      });

      it('releases the lock when the turn fails', async () => {
        orchestrator.handleStream.mockRejectedValue(new Error('boom'));
        jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);

        await service.handleInboundValue(TENANT, inbound());

        expect(locks.release).toHaveBeenCalledTimes(1);
      });

      it('fails the job so it is retried — and answers nobody — when another turn keeps the lock too long', async () => {
        locks.acquire.mockResolvedValue(null);

        await expect(
          service.handleInboundValue(TENANT, inbound()),
        ).rejects.toBeInstanceOf(ContactTurnBusyError);

        expect(orchestrator.handleStream).not.toHaveBeenCalled();
        expect(messaging.sendSession).not.toHaveBeenCalled(); // no apology for a turn that will be retried
        expect(metrics.recordWhatsappAiTurnFailure).not.toHaveBeenCalled();
      });

      it('re-checks the policy after queueing, because the world may have changed while it waited', async () => {
        locks.acquire
          .mockResolvedValueOnce(null)
          .mockResolvedValue('lock-token');
        conversationsRepo.findOne
          .mockResolvedValueOnce(thread('AI')) // when the turn started
          .mockResolvedValue(thread('HUMAN')); // staff took over while it queued

        await service.handleInboundValue(TENANT, inbound());

        expect(decisions('pre_ai')).toHaveLength(2);
        expect(orchestrator.handleStream).not.toHaveBeenCalled(); // no OpenAI spend
        expect(messaging.sendSession).not.toHaveBeenCalled();
      });

      it('does not re-check when it never had to wait', async () => {
        await service.handleInboundValue(TENANT, inbound());

        expect(decisions('pre_ai')).toHaveLength(1);
      });
    });

    describe('an identical request that is already running', () => {
      it('lets BullMQ retry it instead of apologising to the patient', async () => {
        const inFlight = new AppError(ErrorCode.CONFLICT, {
          message: 'The same AI request is already in progress.',
        });
        orchestrator.handleStream.mockRejectedValue(inFlight);

        await expect(
          service.handleInboundValue(TENANT, inbound()),
        ).rejects.toBe(inFlight);

        expect(messaging.sendSession).not.toHaveBeenCalled();
        expect(metrics.recordWhatsappAiTurnFailure).not.toHaveBeenCalled();
        expect(locks.release).toHaveBeenCalledTimes(1);
      });

      it('still apologises for a genuine failure (not a conflict)', async () => {
        orchestrator.handleStream.mockRejectedValue(
          new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'quota' }),
        );
        jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);

        await service.handleInboundValue(TENANT, inbound());

        expect(messaging.sendSession).toHaveBeenCalledTimes(1);
        expect(metrics.recordWhatsappAiTurnFailure).toHaveBeenCalledWith(
          'sent',
        );
      });
    });

    describe('observability', () => {
      it('records a refusal with a closed reason and writes no phone number or message text to any log', async () => {
        const spies = (['debug', 'log', 'warn', 'error'] as const).map(
          (level) =>
            jest
              .spyOn(Logger.prototype, level)
              .mockImplementation(() => undefined),
        );
        conversationsRepo.findOne.mockResolvedValue(thread('HUMAN'));

        await service.handleInboundValue(
          TENANT,
          inbound({ text: { body: 'my secret symptom' } }),
        );

        const logged = spies
          .flatMap((spy) => spy.mock.calls)
          .map((call) => call.map(String).join(' '))
          .join('\n');
        expect(logged).toContain('WHATSAPP_AI_DECISION');
        expect(logged).not.toContain('966500000000');
        expect(logged).not.toContain('my secret symptom');
      });
    });
  });

  describe('logging (FND-016)', () => {
    it('never writes the customer phone number to any log level', async () => {
      const spies = [
        jest
          .spyOn(Logger.prototype, 'debug')
          .mockImplementation(() => undefined),
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined),
        jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined),
      ];

      // An empty text body extracts no actionable content, which is exactly
      // the branch that used to interpolate the raw phone into a debug log.
      await service.handleInboundValue(TENANT, {
        messages: [
          {
            id: 'wamid-7',
            from: '966500000000',
            type: 'text',
            text: { body: '' },
          },
        ],
      } as never);

      const everythingLogged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(everythingLogged).not.toContain('966500000000');

      spies.forEach((spy) => spy.mockRestore());
    });
  });
});
