import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappCoexistenceEchoService } from './whatsapp-coexistence-echo.service';
import { Message } from '../../../entities/Conversations/Message';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { WhatsappInboundAiService } from '../whatsapp-inbound-ai.service';
import { ConversationExecutionService } from '../../conversations/conversation-execution.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../../test/utils/mock-factories';
import type { MetaWebhookChangeValue } from '../webhooks/whatsapp-webhook.types';

const TENANT = 't1';

const echoValue = (
  overrides: Partial<MetaWebhookChangeValue> = {},
): MetaWebhookChangeValue => ({
  metadata: { phone_number_id: 'pid-1' },
  contacts: [{ wa_id: '966500000000' }],
  message_echoes: [
    {
      id: 'echo.1',
      to: '966500000000',
      type: 'text',
      text: { body: 'from the business app' },
    },
  ],
  ...overrides,
});

describe('WhatsappCoexistenceEchoService', () => {
  let service: WhatsappCoexistenceEchoService;
  let messages: MockRepository;
  let accounts: MockRepository;
  let inboundContacts: {
    findOrCreateContact: jest.Mock;
    extractContent: jest.Mock;
  };
  let timeline: {
    findOrCreateForWhatsapp: jest.Mock;
    recordChannelMessage: jest.Mock;
  };

  beforeEach(async () => {
    messages = createMockRepository();
    accounts = createMockRepository();
    accounts.findOne.mockResolvedValue({ id: 'acc-1' });
    inboundContacts = {
      findOrCreateContact: jest.fn().mockResolvedValue({
        id: 'contact-1',
        customer: { id: 'cust-1' },
      }),
      extractContent: jest.fn(
        (m: { text?: { body?: string } }) => m.text?.body,
      ),
    };
    timeline = {
      findOrCreateForWhatsapp: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      recordChannelMessage: jest.fn().mockResolvedValue({ id: 'msg-1' }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappCoexistenceEchoService,
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: WhatsappInboundAiService, useValue: inboundContacts },
        { provide: ConversationExecutionService, useValue: timeline },
      ],
    }).compile();
    service = moduleRef.get(WhatsappCoexistenceEchoService);
  });

  afterEach(() => jest.clearAllMocks());

  it('mirrors an echo onto the timeline as sender_type AGENT, linked to the resolved account', async () => {
    await service.handleEchoes(TENANT, echoValue());

    expect(timeline.findOrCreateForWhatsapp).toHaveBeenCalledWith(
      TENANT,
      'cust-1',
      'acc-1',
    );
    expect(timeline.recordChannelMessage).toHaveBeenCalledWith(
      TENANT,
      'conv-1',
      'AGENT',
      'from the business app',
      undefined,
      { waMessageId: 'echo.1', messageType: 'text' },
    );
  });

  it('is never routed as an inbound/CUSTOMER message', async () => {
    await service.handleEchoes(TENANT, echoValue());

    expect(timeline.recordChannelMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'CUSTOMER',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not duplicate an echo already mirrored (wa_message_id already present)', async () => {
    messages.findOne.mockResolvedValueOnce({ id: 'already-there' });

    await service.handleEchoes(TENANT, echoValue());

    expect(timeline.recordChannelMessage).not.toHaveBeenCalled();
  });

  it('recovers from a race — a 23505 on insert is treated as an already-recorded duplicate, not an error', async () => {
    timeline.recordChannelMessage.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(
      service.handleEchoes(TENANT, echoValue()),
    ).resolves.toBeUndefined();
  });

  it('skips (does not throw) an echo with no wamid — cannot dedupe safely', async () => {
    await expect(
      service.handleEchoes(
        TENANT,
        echoValue({ message_echoes: [{ type: 'text', text: { body: 'x' } }] }),
      ),
    ).resolves.toBeUndefined();
    expect(timeline.recordChannelMessage).not.toHaveBeenCalled();
  });

  it('skips an echo with no attributable recipient (no `to` and no contacts)', async () => {
    await service.handleEchoes(
      TENANT,
      echoValue({
        contacts: undefined,
        message_echoes: [{ id: 'echo.2', type: 'text', text: { body: 'x' } }],
      }),
    );

    expect(timeline.recordChannelMessage).not.toHaveBeenCalled();
  });

  it('skips an echo whose phone_number_id matches no connected account for this tenant (tenant isolation)', async () => {
    accounts.findOne.mockResolvedValueOnce(null);

    await service.handleEchoes(TENANT, echoValue());

    expect(timeline.recordChannelMessage).not.toHaveBeenCalled();
  });

  it('resolves the account WITHIN the given tenant only — never a cross-tenant match', async () => {
    await service.handleEchoes(TENANT, echoValue());

    expect(accounts.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone_number_id: 'pid-1',
          tenant: { id: TENANT },
        }),
      }),
    );
  });

  it('one bad echo in a batch does not stop the others (fails soft, per echo)', async () => {
    inboundContacts.findOrCreateContact
      .mockRejectedValueOnce(new Error('transient DB error'))
      .mockResolvedValueOnce({ id: 'contact-2', customer: { id: 'cust-2' } });

    await service.handleEchoes(
      TENANT,
      echoValue({
        message_echoes: [
          {
            id: 'echo.a',
            to: '966500000000',
            type: 'text',
            text: { body: 'a' },
          },
          {
            id: 'echo.b',
            to: '966500000000',
            type: 'text',
            text: { body: 'b' },
          },
        ],
      }),
    );

    expect(timeline.recordChannelMessage).toHaveBeenCalledTimes(1);
  });

  it('skips an echo with no renderable content', async () => {
    inboundContacts.extractContent.mockReturnValueOnce(undefined);

    await service.handleEchoes(TENANT, echoValue());

    expect(timeline.recordChannelMessage).not.toHaveBeenCalled();
  });
});
