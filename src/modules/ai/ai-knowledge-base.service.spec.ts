import { AiKnowledgeBaseService } from './ai-knowledge-base.service';

/**
 * Agents/models are Admin-managed platform config — the clinic owner never
 * creates or selects one. These tests pin that Knowledge creation (and
 * rebuild) never blocks on an agent existing, while still honoring/validating
 * a caller-supplied agentId (e.g. a direct API caller) exactly as before.
 */
describe('AiKnowledgeBaseService — Knowledge without an Admin-provisioned agent', () => {
  function setup(defaultAgent: { id: string } | null = null) {
    const kb = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      findAndCount: jest.fn(),
    };
    const agents = {
      findOne: jest.fn().mockResolvedValue(defaultAgent),
      exists: jest.fn().mockResolvedValue(false),
    };
    const ingestion = {
      ingestChunk: jest.fn().mockResolvedValue({ id: 'kb-1', content: 'hi' }),
      reembedAgent: jest.fn().mockResolvedValue({ chunks: 0, embedded: 0 }),
      reembedChunk: jest.fn().mockResolvedValue(undefined),
    };
    const usage = {
      assertResourceWithinLimit: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AiKnowledgeBaseService(
      kb as any,
      agents as any,
      ingestion as any,
      usage as any,
    );
    return { service, kb, agents, ingestion, usage };
  }

  it('creates a knowledge chunk with no agent at all (tenant has none provisioned yet) — never blocked', async () => {
    const { service, ingestion } = setup(null);

    await expect(
      service.create('tenant-1', {
        content: 'Our clinic is open 9am-9pm',
      } as any),
    ).resolves.toMatchObject({ id: 'kb-1' });

    expect(ingestion.ingestChunk).toHaveBeenCalledWith(
      'tenant-1',
      null,
      'Our clinic is open 9am-9pm',
      { type: undefined, id: undefined },
    );
  });

  it("opportunistically binds to the tenant's existing default agent when one is already provisioned, without the caller sending one", async () => {
    const { service, ingestion } = setup({ id: 'agent-1' });

    await service.create('tenant-1', { content: 'hi' } as any);

    expect(ingestion.ingestChunk).toHaveBeenCalledWith(
      'tenant-1',
      'agent-1',
      'hi',
      expect.anything(),
    );
  });

  it('still validates a caller-supplied agentId against the tenant (unchanged behavior)', async () => {
    const { service, agents } = setup(null);
    agents.exists.mockResolvedValue(false);

    await expect(
      service.create('tenant-1', { content: 'hi', agentId: 'not-mine' } as any),
    ).rejects.toThrow('AI agent not found in this tenant');
  });

  it('rebuild proceeds (as a tenant-wide rebuild of unbound chunks) instead of failing when no agent exists', async () => {
    const { service, ingestion } = setup(null);

    const result = await service.rebuildEmbeddings('tenant-1');

    expect(result.accepted).toBe(true);
    expect(result.agentId).toBeNull();
    expect(ingestion.reembedAgent).toHaveBeenCalledWith('tenant-1', null);
  });
});
