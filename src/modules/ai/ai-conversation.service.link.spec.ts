import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AiConversationService } from './ai-conversation.service';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AppError, ErrorCode } from '../../common/errors';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('AiConversationService.linkTimelineConversation', () => {
  let service: AiConversationService;
  let aiConversations: MockRepository;
  let conversations: MockRepository;
  let qb: ReturnType<typeof createMockQueryBuilder>;

  beforeEach(async () => {
    aiConversations = createMockRepository();
    conversations = createMockRepository();
    qb = createMockQueryBuilder();
    aiConversations.createQueryBuilder.mockReturnValue(qb);
    conversations.exists.mockResolvedValue(true);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AiConversationService,
        {
          provide: getRepositoryToken(AiConversation),
          useValue: aiConversations,
        },
        {
          provide: getRepositoryToken(AiAgent),
          useValue: createMockRepository(),
        },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
      ],
    }).compile();
    service = moduleRef.get(AiConversationService);
  });

  it('links only a session that has no thread yet, scoped to the tenant', async () => {
    const linked = await service.linkTimelineConversation(
      't1',
      'ai-1',
      'thread-9',
    );

    expect(linked).toBe(true);
    expect(qb.set).toHaveBeenCalledWith({ conversation: { id: 'thread-9' } });
    expect(qb.where).toHaveBeenCalledWith('id = :id', { id: 'ai-1' });
    expect(qb.andWhere).toHaveBeenCalledWith('"tenantId" = :tenantId', {
      tenantId: 't1',
    });
    // The compare-and-set that makes it safe against a concurrent link.
    expect(qb.andWhere).toHaveBeenCalledWith('"conversationId" IS NULL');
  });

  it('reports false when the session was already linked (zero rows affected)', async () => {
    qb.execute.mockResolvedValue({ affected: 0, raw: [] });

    await expect(
      service.linkTimelineConversation('t1', 'ai-1', 'thread-9'),
    ).resolves.toBe(false);
  });

  it("refuses a thread that is not this tenant's and writes nothing", async () => {
    conversations.exists.mockResolvedValue(false);

    await expect(
      service.linkTimelineConversation('t1', 'ai-1', 'foreign-thread'),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    await expect(
      service.linkTimelineConversation('t1', 'ai-1', 'foreign-thread'),
    ).rejects.toBeInstanceOf(AppError);
    expect(conversations.exists).toHaveBeenCalledWith({
      where: { id: 'foreign-thread', tenant: { id: 't1' } },
    });
    expect(qb.execute).not.toHaveBeenCalled();
  });
});
