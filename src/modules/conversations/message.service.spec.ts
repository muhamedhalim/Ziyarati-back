import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MessageService } from './message.service';
import { Message } from '../../entities/Conversations/Message';
import { Conversation } from '../../entities/Conversations/Conversation';
import { SENDER_TYPE } from './conversation.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('MessageService', () => {
  let service: MessageService;
  let messages: MockRepository;
  let conversations: MockRepository;

  beforeEach(async () => {
    messages = createMockRepository();
    conversations = createMockRepository();
    conversations.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
      ],
    }).compile();
    service = moduleRef.get(MessageService);
  });

  afterEach(() => jest.clearAllMocks());

  it('lists messages for a tenant-owned conversation', async () => {
    messages.findAndCount.mockResolvedValueOnce([[{ id: 'm1' }], 1]);
    const res = await service.list(TENANT, 'conv1', { page: 1, limit: 20 } as any);
    expect(res.total).toBe(1);
  });

  it('list throws when the conversation is not in the tenant', async () => {
    conversations.exists.mockResolvedValueOnce(false);
    await expect(service.list(TENANT, 'x', { page: 1, limit: 20 } as any)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('findOne throws for an unknown message', async () => {
    messages.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('edits an AGENT-authored message', async () => {
    messages.findOne.mockResolvedValue({ id: 'm1', sender_type: SENDER_TYPE.AGENT, content: 'old' });
    await service.edit(TENANT, 'm1', { content: 'new' } as any);
    expect(messages.save).toHaveBeenCalledWith(expect.objectContaining({ content: 'new' }));
  });

  it('refuses to edit a non-AGENT (customer/bot/system) message', async () => {
    messages.findOne.mockResolvedValueOnce({ id: 'm1', sender_type: SENDER_TYPE.CUSTOMER, content: 'hi' });
    await expect(service.edit(TENANT, 'm1', { content: 'tampered' } as any)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    expect(messages.save).not.toHaveBeenCalled();
  });

  it('deletes an AGENT message but refuses to delete others', async () => {
    messages.findOne.mockResolvedValueOnce({ id: 'm1', sender_type: SENDER_TYPE.AGENT });
    await service.remove(TENANT, 'm1');
    expect(messages.delete).toHaveBeenCalledWith({ id: 'm1' });

    messages.findOne.mockResolvedValueOnce({ id: 'm2', sender_type: SENDER_TYPE.BOT });
    await expect(service.remove(TENANT, 'm2')).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});
