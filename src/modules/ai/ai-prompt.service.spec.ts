import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AiPromptService } from './ai-prompt.service';
import { AiPrompt } from '../../entities/AI Agent/AiPrompt';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('AiPromptService', () => {
  let service: AiPromptService;
  let prompts: MockRepository;
  let agents: MockRepository;

  beforeEach(async () => {
    prompts = createMockRepository();
    agents = createMockRepository();
    agents.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AiPromptService,
        { provide: getRepositoryToken(AiPrompt), useValue: prompts },
        { provide: getRepositoryToken(AiAgent), useValue: agents },
      ],
    }).compile();
    service = moduleRef.get(AiPromptService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a prompt after validating the agent', async () => {
    prompts.save.mockResolvedValueOnce({ id: 'p1' });
    await service.create(TENANT, { name: 'Greeting', content: 'Hi', agentId: 'a1' } as any);
    expect(agents.exists).toHaveBeenCalled();
  });

  it('rejects an agent not in the tenant with 422', async () => {
    agents.exists.mockResolvedValueOnce(false);
    await expect(service.create(TENANT, { name: 'x', agentId: 'bad' } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('findOne throws for an unknown prompt', async () => {
    prompts.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('updates, toggles active, and removes', async () => {
    prompts.findOne.mockResolvedValue({ id: 'p1', is_active: true });
    prompts.save.mockImplementation(async (p: any) => p);
    await service.update(TENANT, 'p1', { content: 'new' } as any);
    expect(prompts.save).toHaveBeenCalledWith(expect.objectContaining({ content: 'new' }));
    await service.setActive(TENANT, 'p1', false);
    expect(prompts.save).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    await service.remove(TENANT, 'p1');
    expect(prompts.remove).toHaveBeenCalled();
  });
});
