import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConversationParticipantService } from './conversation-participant.service';
import { Conversation } from '../../entities/Conversations/Conversation';
import { ConversationParticipant } from '../../entities/Conversations/ConversationParticipant';
import { User } from '../../entities/Auth&RBAC/User';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CONV = 'conv1';

describe('ConversationParticipantService', () => {
  let service: ConversationParticipantService;
  let participants: MockRepository;
  let conversations: MockRepository;
  let users: MockRepository;

  beforeEach(async () => {
    participants = createMockRepository();
    conversations = createMockRepository();
    users = createMockRepository();
    conversations.exists.mockResolvedValue(true);
    users.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationParticipantService,
        { provide: getRepositoryToken(ConversationParticipant), useValue: participants },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        { provide: getRepositoryToken(User), useValue: users },
      ],
    }).compile();
    service = moduleRef.get(ConversationParticipantService);
  });

  afterEach(() => jest.clearAllMocks());

  it('adds a participant', async () => {
    participants.findOne.mockResolvedValueOnce(null);
    participants.save.mockResolvedValueOnce({ id: 'p1' });
    await expect(service.add(TENANT, CONV, { userId: 'u1' } as any)).resolves.toEqual({ id: 'p1' });
  });

  it('rejects when the conversation is not in the tenant', async () => {
    conversations.exists.mockResolvedValueOnce(false);
    await expect(service.add(TENANT, 'x', { userId: 'u1' } as any)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('rejects a user not in the tenant with 422', async () => {
    users.exists.mockResolvedValueOnce(false);
    await expect(service.add(TENANT, CONV, { userId: 'bad' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('rejects a duplicate participant', async () => {
    participants.findOne.mockResolvedValueOnce({ id: 'existing' });
    await expect(service.add(TENANT, CONV, { userId: 'u1' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('removes a participant, throwing when not found', async () => {
    participants.findOne.mockResolvedValueOnce({ id: 'p1' });
    await service.remove(TENANT, CONV, 'p1');
    expect(participants.remove).toHaveBeenCalled();

    participants.findOne.mockResolvedValueOnce(null);
    await expect(service.remove(TENANT, CONV, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('update is unsupported by the schema (explicit 422)', async () => {
    await expect(service.update(TENANT, CONV, 'p1')).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });
});
