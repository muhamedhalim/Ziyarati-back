import { AiAgentService } from './ai-agent.service';

describe('AiAgentService.create — model pinning', () => {
  function build() {
    const created: Record<string, unknown>[] = [];
    const agents = {
      create: jest.fn((v) => (created.push(v), v)),
      save: jest.fn(async (v) => ({ ...v, id: 'a1' })),
      findOne: jest.fn(async () => ({ id: 'a1' })),
    };
    const settings = {
      getTyped: jest.fn(async (key: string) => (key === 'ai.default_model' ? 'gpt-5.6-terra' : 0.2)),
    };
    const svc = new AiAgentService(agents as any, {} as any, settings as any);
    return { svc, created, settings };
  }

  it('does NOT copy ai.default_model onto the agent, so it keeps following the platform setting', async () => {
    const { svc, created, settings } = build();
    await svc.create('t1', { name: 'A' } as any);
    expect(created[0].model).toBeUndefined();
    expect(created[0].temperature).toBe(0.2);
    expect(settings.getTyped).not.toHaveBeenCalledWith('ai.default_model');
  });

  it('pins the model only when the caller names one explicitly', async () => {
    const { svc, created } = build();
    await svc.create('t1', { name: 'A', model: 'gpt-5.6-luna' } as any);
    expect(created[0].model).toBe('gpt-5.6-luna');
  });
});
