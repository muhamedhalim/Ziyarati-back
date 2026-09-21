import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { Message } from '../../entities/Conversations/Message';
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
  let orchestrator: { handleStream: jest.Mock };
  let customers: {
    recordOptOut: jest.Mock;
    search: jest.Mock;
    create: jest.Mock;
  };
  let settings: { getTyped: jest.Mock };
  let messaging: { sendSession: jest.Mock };
  let conversationExecution: { recordProviderMessageId: jest.Mock };
  let access: { resolve: jest.Mock; shouldBlock: jest.Mock };
  let tenantSettings: MockRepository;

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
    contacts = createMockRepository();
    contacts.findOne.mockResolvedValue(EXISTING_CONTACT);
    // The clinic has NOT switched its AI assistant off unless a test says so.
    tenantSettings = createMockRepository();
    tenantSettings.findOne.mockResolvedValue({ id: 'ts-1', bot_enabled: true });
    orchestrator = {
      handleStream: jest
        .fn()
        .mockResolvedValue({ reply: { content: 'AI reply' } }),
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
    };
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
          useValue: createMockRepository(),
        },
        {
          provide: WhatsappMediaService,
          useValue: { enqueueForMessage: jest.fn() },
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
        {
          provide: WhatsappBotActorService,
          useValue: {
            ensureBotActor: jest.fn().mockResolvedValue({
              id: 'bot-1',
              tenantId: TENANT,
              email: null,
              roles: [],
              permissions: [],
            }),
          },
        },
        { provide: CustomerService, useValue: customers },
        { provide: TenantContextService, useValue: new TenantContextService() },
        { provide: SystemSettingService, useValue: settings },
        { provide: AccessControlService, useValue: access },
      ],
    }).compile();
    service = moduleRef.get(WhatsappInboundAiService);
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
      // The switch is checked before any entitlement work is spent on it.
      expect(access.resolve).not.toHaveBeenCalled();
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
