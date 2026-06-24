import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AiAgentService } from './ai-agent.service';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('AiAgentService', () => {
  let service: AiAgentService;
  let agents: MockRepository;
  let branches: MockRepository;

  beforeEach(async () => {
    agents = createMockRepository();
    branches = createMockRepository();
    branches.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AiAgentService,
        { provide: getRepositoryToken(AiAgent), useValue: agents },
        { provide: getRepositoryToken(Branch), useValue: branches },
      ],
    }).compile();
    service = moduleRef.get(AiAgentService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates an agent after validating the branch', async () => {
    agents.save.mockResolvedValueOnce({ id: 'a1' });
    agents.findOne.mockResolvedValueOnce({ id: 'a1' });
    await service.create(TENANT, { name: 'Bot', model: 'gpt-4o', branchId: 'b1' } as any);
    expect(branches.exists).toHaveBeenCalled();
  });

  it('rejects an invalid branch with 422', async () => {
    branches.exists.mockResolvedValueOnce(false);
    await expect(service.create(TENANT, { name: 'Bot', branchId: 'x' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('findOne throws for an unknown agent', async () => {
    agents.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('setActive toggles is_active', async () => {
    agents.findOne.mockResolvedValue({ id: 'a1', is_active: true });
    await service.setActive(TENANT, 'a1', false);
    expect(agents.save).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
  });

  it('remove soft-removes (archive)', async () => {
    agents.findOne.mockResolvedValueOnce({ id: 'a1' });
    await service.remove(TENANT, 'a1');
    expect(agents.softRemove).toHaveBeenCalled();
  });

  it('lists agents with filters', async () => {
    agents.findAndCount.mockResolvedValueOnce([[{ id: 'a1' }], 1]);
    const res = await service.findAll(TENANT, { page: 1, limit: 10, search: 'bot' } as any);
    expect(res.total).toBe(1);
  });
});
