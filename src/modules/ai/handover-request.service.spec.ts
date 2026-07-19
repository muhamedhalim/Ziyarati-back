import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { HandoverRequestService } from './handover-request.service';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
import { CustomerNoteService } from '../crm/customer-note.service';
import { HANDOVER_STATUS } from './ai.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('HandoverRequestService', () => {
  let service: HandoverRequestService;
  let handovers: MockRepository;
  let conversations: MockRepository;
  let aiConversations: MockRepository;
  let users: MockRepository;

  beforeEach(async () => {
    handovers = createMockRepository();
    conversations = createMockRepository();
    aiConversations = createMockRepository();
    users = createMockRepository();
    conversations.exists.mockResolvedValue(true);
    users.exists.mockResolvedValue(true);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HandoverRequestService,
        { provide: getRepositoryToken(HandoverRequest), useValue: handovers },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        { provide: getRepositoryToken(AiConversation), useValue: aiConversations },
        { provide: getRepositoryToken(AiMessage), useValue: createMockRepository() },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(UserRole), useValue: createMockRepository() },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConversationExecutionService, useValue: {} },
        { provide: CustomerNoteService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(HandoverRequestService);
  });

  afterEach(() => jest.clearAllMocks());

  const load = (status: string) =>
    handovers.findOne.mockResolvedValue({
      id: 'h1',
      status,
      conversation: { id: 'c1' },
      assigned_to: { id: 'u1' },
    });

  it('creates a handover and flips a linked AI conversation to HANDED_OVER', async () => {
    handovers.save.mockResolvedValueOnce({ id: 'h1' });
    handovers.findOne.mockResolvedValueOnce({ id: 'h1', status: HANDOVER_STATUS.PENDING });
    aiConversations.findOne.mockResolvedValueOnce({ id: 'ai1', status: 'ACTIVE' });
    await service.create(TENANT, { conversationId: 'c1', aiConversationId: 'ai1' } as any);
    expect(aiConversations.save).toHaveBeenCalled();
  });

  it('rejects a conversation not in the tenant with 422', async () => {
    conversations.exists.mockResolvedValueOnce(false);
    await expect(service.create(TENANT, { conversationId: 'x' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('assign rejects an assignee not in the tenant', async () => {
    users.exists.mockResolvedValueOnce(false);
    await expect(service.assign(TENANT, 'h1', { assignedToUserId: 'x' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('assign transitions PENDING → ASSIGNED', async () => {
    load(HANDOVER_STATUS.PENDING);
    await service.assign(TENANT, 'h1', { assignedToUserId: 'u1' } as any);
    expect(handovers.save).toHaveBeenCalledWith(expect.objectContaining({ status: HANDOVER_STATUS.ASSIGNED }));
  });

  it('assign rejects a terminal handover', async () => {
    load(HANDOVER_STATUS.RESOLVED);
    await expect(service.assign(TENANT, 'h1', { assignedToUserId: 'u1' } as any)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('accept requires ASSIGNED status', async () => {
    load(HANDOVER_STATUS.PENDING);
    await expect(service.accept(TENANT, 'h1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('resolve sets RESOLVED + resolved_at', async () => {
    load(HANDOVER_STATUS.ACCEPTED);
    await service.resolve(TENANT, 'h1');
    const saved = handovers.save.mock.calls[0][0];
    expect(saved.status).toBe(HANDOVER_STATUS.RESOLVED);
    expect(saved.resolved_at).toBeInstanceOf(Date);
  });

  it('reject sets REJECTED (terminal)', async () => {
    load(HANDOVER_STATUS.ASSIGNED);
    await service.reject(TENANT, 'h1', 'spam');
    expect(handovers.save).toHaveBeenCalledWith(expect.objectContaining({ status: HANDOVER_STATUS.REJECTED }));
  });
});
