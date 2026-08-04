import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Message } from '../../entities/Conversations/Message';
import { WhatsappMediaService } from './meta/whatsapp-media.service';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { WhatsappBotActorService } from './whatsapp-bot-actor.service';
import { CustomerService } from '../crm/customer.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const KEYWORDS = 'stop,unsubscribe,إلغاء,توقف';

describe('WhatsappInboundAiService — opt-out short-circuit (FND-024)', () => {
  let service: WhatsappInboundAiService;
  let contacts: MockRepository;
  let orchestrator: { handleStream: jest.Mock };
  let customers: { recordOptOut: jest.Mock; search: jest.Mock; create: jest.Mock };
  let settings: { getTyped: jest.Mock };
  let messaging: { sendSession: jest.Mock };

  const CUSTOMER = { id: 'cust-1' };
  const EXISTING_CONTACT = {
    id: 'contact-1',
    wa_id: '966500000000',
    customer: CUSTOMER,
  };

  beforeEach(async () => {
    contacts = createMockRepository();
    contacts.findOne.mockResolvedValue(EXISTING_CONTACT);
    orchestrator = { handleStream: jest.fn().mockResolvedValue({ reply: { content: 'AI reply' } }) };
    customers = {
      recordOptOut: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue({ data: [] }),
      create: jest.fn(),
    };
    settings = { getTyped: jest.fn().mockResolvedValue(KEYWORDS) };
    messaging = { sendSession: jest.fn().mockResolvedValue({ success: true }) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappInboundAiService,
        { provide: getRepositoryToken(WhatsappContact), useValue: contacts },
        { provide: getRepositoryToken(Message), useValue: createMockRepository() },
        { provide: WhatsappMediaService, useValue: { enqueueForMessage: jest.fn() } },
        { provide: AiOrchestratorService, useValue: orchestrator },
        { provide: WhatsappMessagingService, useValue: messaging },
        { provide: WhatsappMessageRouter, useValue: { resolveForSend: jest.fn().mockResolvedValue({ id: 'acc-1', phoneNumberId: 'p1', mode: 'REAL' }) } },
        { provide: WhatsappBotActorService, useValue: { ensureBotActor: jest.fn().mockResolvedValue({ id: 'bot-1', tenantId: TENANT, email: null, roles: [], permissions: [] }) } },
        { provide: CustomerService, useValue: customers },
        { provide: TenantContextService, useValue: new TenantContextService() },
        { provide: SystemSettingService, useValue: settings },
      ],
    }).compile();
    service = moduleRef.get(WhatsappInboundAiService);
  });

  it('[FND-024] records the opt-out and never calls the AI orchestrator when the inbound message matches a configured keyword', async () => {
    await service.handleInboundValue(TENANT, {
      messages: [{ id: 'wamid-1', from: '966500000000', type: 'text', text: { body: 'STOP' } }],
    } as never);

    expect(settings.getTyped).toHaveBeenCalledWith(SettingKey.WHATSAPP_OPT_OUT_KEYWORDS);
    expect(customers.recordOptOut).toHaveBeenCalledWith(TENANT, 'cust-1', 'inbound_keyword');
    expect(orchestrator.handleStream).not.toHaveBeenCalled();
    expect(messaging.sendSession).not.toHaveBeenCalled();
  });

  it('matches an Arabic opt-out keyword the same way', async () => {
    await service.handleInboundValue(TENANT, {
      messages: [{ id: 'wamid-2', from: '966500000000', type: 'text', text: { body: 'إلغاء' } }],
    } as never);

    expect(customers.recordOptOut).toHaveBeenCalledWith(TENANT, 'cust-1', 'inbound_keyword');
    expect(orchestrator.handleStream).not.toHaveBeenCalled();
  });

  it('proceeds to the AI turn normally for an ordinary message (regression guard)', async () => {
    await service.handleInboundValue(TENANT, {
      messages: [{ id: 'wamid-3', from: '966500000000', type: 'text', text: { body: 'What time do you open?' } }],
    } as never);

    expect(customers.recordOptOut).not.toHaveBeenCalled();
    expect(orchestrator.handleStream).toHaveBeenCalled();
  });

  it('does not check consent (and proceeds normally) when the contact has no linked customer yet', async () => {
    contacts.findOne.mockResolvedValueOnce({ id: 'contact-2', wa_id: '966500000000', customer: null });

    await service.handleInboundValue(TENANT, {
      messages: [{ id: 'wamid-4', from: '966500000000', type: 'text', text: { body: 'STOP' } }],
    } as never);

    // No customer exists yet to attach the opt-out to — the pre-existing
    // findOrCreateContact() flow still creates one downstream via the normal
    // AI turn; this test only asserts the guard doesn't throw or dead-end
    // trying to record consent against a non-existent customer id.
    expect(customers.recordOptOut).not.toHaveBeenCalled();
  });
});
