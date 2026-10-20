import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AiPromptService } from './ai-prompt.service';
import { AiPrompt } from '../../entities/AI Agent/AiPrompt';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { ErrorCode } from '../../common/errors';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AI_DIRECTIVE_LIMITS } from './ai.constants';
import { CreateAiPromptDto } from './dto/create-ai-prompt.dto';
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

  describe('findActiveForTurn — what the AI is allowed to read', () => {
    it("reads only this tenant's ACTIVE rows, clinic-wide or for the running agent, oldest first", async () => {
      prompts.find.mockResolvedValueOnce([{ content: 'a' }, { content: 'b' }]);
      await expect(service.findActiveForTurn(TENANT, 'agent-1')).resolves.toEqual(['a', 'b']);
      const arg = prompts.find.mock.calls[0][0];
      expect(arg.where).toEqual([
        expect.objectContaining({ tenant: { id: TENANT }, is_active: true }),
        expect.objectContaining({ tenant: { id: TENANT }, is_active: true, agent: { id: 'agent-1' } }),
      ]);
      expect(arg.order).toEqual({ created_at: 'ASC', id: 'ASC' });
      expect(arg.take).toBe(AI_DIRECTIVE_LIMITS.MAX_ACTIVE);
    });

    it('without an agent it reads clinic-wide rows only, in a single condition', async () => {
      prompts.find.mockResolvedValueOnce([]);
      await service.findActiveForTurn(TENANT);
      expect(prompts.find.mock.calls[0][0].where).toHaveLength(1);
    });

    it('lets a database error propagate (the caller degrades, the service does not hide it)', async () => {
      prompts.find.mockRejectedValueOnce(new Error('db down'));
      await expect(service.findActiveForTurn(TENANT)).rejects.toThrow('db down');
    });
  });

  describe('limits', () => {
    it('refuses an 11th active directive', async () => {
      prompts.count.mockResolvedValueOnce(5).mockResolvedValueOnce(AI_DIRECTIVE_LIMITS.MAX_ACTIVE);
      await expect(service.create(TENANT, { content: 'x' } as any)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(prompts.save).not.toHaveBeenCalled();
    });

    it('refuses storing more than the per-clinic total', async () => {
      prompts.count.mockResolvedValueOnce(AI_DIRECTIVE_LIMITS.MAX_TOTAL);
      await expect(service.create(TENANT, { content: 'x' } as any)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('lets a clinic at the active limit still store an INACTIVE directive', async () => {
      prompts.count.mockResolvedValueOnce(AI_DIRECTIVE_LIMITS.MAX_ACTIVE);
      prompts.save.mockResolvedValueOnce({ id: 'p9' });
      await expect(service.create(TENANT, { content: 'x', isActive: false } as any)).resolves.toBeDefined();
    });

    it('refuses re-activating a directive past the active limit, but never blocks deactivating', async () => {
      prompts.findOne.mockResolvedValue({ id: 'p1', is_active: false });
      prompts.count.mockResolvedValueOnce(AI_DIRECTIVE_LIMITS.MAX_ACTIVE);
      await expect(service.setActive(TENANT, 'p1', true)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      prompts.findOne.mockResolvedValue({ id: 'p2', is_active: true });
      prompts.save.mockImplementation(async (p: any) => p);
      await expect(service.setActive(TENANT, 'p2', false)).resolves.toMatchObject({ is_active: false });
    });
  });

  describe('input validation', () => {
    const check = async (content: unknown) =>
      validate(plainToInstance(CreateAiPromptDto, { content }));

    it('accepts text up to the limit and rejects blank or longer text', async () => {
      expect(await check('x'.repeat(AI_DIRECTIVE_LIMITS.MAX_CONTENT_CHARS))).toHaveLength(0);
      expect(await check('x'.repeat(AI_DIRECTIVE_LIMITS.MAX_CONTENT_CHARS + 1))).not.toHaveLength(0);
      expect(await check('   ')).not.toHaveLength(0);
      expect(await check(42)).not.toHaveLength(0);
    });
  });
});
