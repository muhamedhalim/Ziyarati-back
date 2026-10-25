import { runAsBotActor } from './bot-actor-run';

describe('runAsBotActor', () => {
  const bot = { id: 'bot-1', tenantId: 't1', permissions: ['appointments.create'] } as never;

  function build() {
    const order: string[] = [];
    const botActor = {
      ensureBotActor: jest.fn(async (t: string) => {
        order.push(`ensure:${t}`);
        return bot;
      }),
    };
    const tenantContext = {
      run: jest.fn(async (fn: () => Promise<unknown>) => {
        order.push('run');
        return fn();
      }),
      setPrincipal: jest.fn(() => order.push('setPrincipal')),
    };
    return { botActor, tenantContext, order };
  }

  it('resolves the clinic bot, opens a context, sets the bot as principal, then runs fn with the bot', async () => {
    const { botActor, tenantContext, order } = build();
    const fn = jest.fn(async () => {
      order.push('fn');
      return 'done';
    });
    await expect(runAsBotActor(botActor as never, tenantContext as never, 't1', fn)).resolves.toBe('done');
    expect(order).toEqual(['ensure:t1', 'run', 'setPrincipal', 'fn']);
    expect(tenantContext.setPrincipal).toHaveBeenCalledWith(bot);
    expect(fn).toHaveBeenCalledWith(bot);
  });

  it('never sets a principal when the bot cannot be resolved', async () => {
    const { botActor, tenantContext } = build();
    botActor.ensureBotActor.mockRejectedValueOnce(new Error('no bot'));
    await expect(runAsBotActor(botActor as never, tenantContext as never, 't1', jest.fn())).rejects.toThrow('no bot');
    expect(tenantContext.run).not.toHaveBeenCalled();
    expect(tenantContext.setPrincipal).not.toHaveBeenCalled();
  });

  it('propagates an error thrown by fn', async () => {
    const { botActor, tenantContext } = build();
    await expect(
      runAsBotActor(botActor as never, tenantContext as never, 't1', async () => {
        throw new Error('slot taken');
      }),
    ).rejects.toThrow('slot taken');
  });
});
