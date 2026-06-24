import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConversationService } from './conversation.service';
import { Conversation } from '../../entities/Conversations/Conversation';
import { ConversationParticipant } from '../../entities/Conversations/ConversationParticipant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { User } from '../../entities/Auth&RBAC/User';
import { CONVERSATION_STATUS } from './conversation.constants';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('ConversationService', () => {
  let service: ConversationService;
  let conversations: MockRepository;
  let participants: MockRepository;
  let branches: MockRepository;
  let customers: MockRepository;
  let accounts: MockRepository;
  let users: MockRepository;

  beforeEach(async () => {
    conversations = createMockRepository();
    participants = createMockRepository();
    branches = createMockRepository();
    customers = createMockRepository();
    accounts = createMockRepository();
    users = createMockRepository();
    for (const r of [branches, customers, accounts, users]) r.exists.mockResolvedValue(true);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        { provide: getRepositoryToken(ConversationParticipant), useValue: participants },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: getRepositoryToken(User), useValue: users },
      ],
    }).compile();
    service = moduleRef.get(ConversationService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('defaults to ASSIGNED when an assignee is supplied', async () => {
      conversations.save.mockResolvedValueOnce({ id: 'conv-1' });
      conversations.findOne.mockResolvedValueOnce({ id: 'conv-1' });
      await service.create(TENANT, { customerId: 'c1', assignedToUserId: 'u1' } as any);
      const created = conversations.create.mock.calls[0][0];
      expect(created.status).toBe(CONVERSATION_STATUS.ASSIGNED);
    });

    it('rejects a customer not in the tenant with 422', async () => {
      customers.exists.mockResolvedValueOnce(false);
      await expect(service.create(TENANT, { customerId: 'x' } as any)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('findOne / assign / archive / remove', () => {
    it('findOne throws for an unknown conversation', async () => {
      conversations.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('assign sets the assignee and ASSIGNED status', async () => {
      conversations.findOne.mockResolvedValue({ id: 'conv-1', status: CONVERSATION_STATUS.OPEN });
      await service.assign(TENANT, 'conv-1', 'u1');
      expect(conversations.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: CONVERSATION_STATUS.ASSIGNED }),
      );
    });

    it('archive sets ARCHIVED status', async () => {
      conversations.findOne.mockResolvedValue({ id: 'conv-1', status: CONVERSATION_STATUS.OPEN });
      await service.archive(TENANT, 'conv-1');
      expect(conversations.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: CONVERSATION_STATUS.ARCHIVED }),
      );
    });

    it('remove hard-deletes after an ownership check', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: 'conv-1' });
      await service.remove(TENANT, 'conv-1');
      expect(conversations.delete).toHaveBeenCalledWith({ id: 'conv-1' });
    });
  });

  describe('findAll', () => {
    it('returns empty early when a participant filter matches nothing', async () => {
      participants.find.mockResolvedValueOnce([]);
      const res = await service.findAll(TENANT, { page: 1, limit: 10, participantUserId: 'u9' } as any);
      expect(res).toEqual({ data: [], total: 0, page: 1, limit: 10 });
    });

    it('queries via the scoped query builder with filters', async () => {
      const qb = createMockQueryBuilder();
      qb.getManyAndCount.mockResolvedValueOnce([[{ id: 'conv-1' }], 1]);
      conversations.createQueryBuilder.mockReturnValueOnce(qb);
      const res = await service.findAll(TENANT, { page: 1, limit: 10, status: 'OPEN', branchId: 'b1' } as any);
      expect(res.total).toBe(1);
      expect(qb.andWhere).toHaveBeenCalled();
    });
  });
});
