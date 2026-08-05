import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConversationExecutionService } from './conversation-execution.service';
import { Message } from '../../entities/Conversations/Message';
import { Conversation } from '../../entities/Conversations/Conversation';
import { MessageStatusService } from './message-status.service';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * FND-023 — `recordProviderMessageId` is the seam that lets a LATER delivery/
 * read webhook (matched by wamid) find its way back to an agent/bot reply's
 * Message row. `sendMessage`/`recordChannelMessage` persist the row BEFORE
 * the channel send even happens (so a message is never lost if the send
 * fails), so the provider id can only be attached afterward — this method is
 * that follow-up write.
 */
describe('ConversationExecutionService.recordProviderMessageId (FND-023)', () => {
  let service: ConversationExecutionService;
  let messages: MockRepository;

  beforeEach(async () => {
    messages = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationExecutionService,
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Conversation), useValue: createMockRepository() },
        { provide: MessageStatusService, useValue: { append: jest.fn() } },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(ConversationExecutionService);
  });

  afterEach(() => jest.clearAllMocks());

  it('stamps wa_message_id onto the tenant-scoped message row', async () => {
    messages.update.mockResolvedValueOnce({ affected: 1 });
    await service.recordProviderMessageId(TENANT, 'msg-1', 'wamid.ABC');
    expect(messages.update).toHaveBeenCalledWith(
      { id: 'msg-1', tenant: { id: TENANT } },
      { wa_message_id: 'wamid.ABC' },
    );
  });
});
