import { ConfigService } from '@nestjs/config';
import { AppError, ErrorCode } from '../../common/errors';
import { AI_CHANNELS } from './ai-channel.constants';
import { AiOrchestratorService } from './ai-orchestrator.service';

/**
 * F-13. `channel` is the one field a client fills in for itself, and it chose the
 * prompt, the toolset and the model tier. Any dashboard user could send
 * `channel: 'WHATSAPP'` and be handed the WhatsApp assistant. The server now
 * decides which channel a caller may run as.
 */
describe('AiOrchestratorService channel allow-list (F-13)', () => {
  function setup(principal: { guest?: boolean } | null) {
    const conv = { id: 'conv-1', status: 'ACTIVE', agent: undefined };
    const execution = {
      sendMessage: jest.fn().mockResolvedValue({
        message: {
          id: 'm1',
          role: 'assistant',
          content: 'ok',
          created_at: new Date(),
        },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        retrievedChunks: 0,
        fallback: false,
      }),
      streamMessage: jest.fn().mockResolvedValue({
        message: {
          id: 'm1',
          role: 'assistant',
          content: 'ok',
          created_at: new Date(),
        },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        retrievedChunks: 0,
        streamed: true,
      }),
    };
    const sessions = {
      touchChannel: jest.fn(),
      get: jest.fn().mockResolvedValue({ context: {} }),
      patch: jest.fn().mockResolvedValue({}),
      patchFromClient: jest.fn(),
      setAgent: jest.fn(),
    };
    const service = new AiOrchestratorService(
      { findOne: jest.fn(), start: jest.fn().mockResolvedValue(conv) } as any,
      execution as any,
      sessions as any,
      {
        route: jest.fn().mockResolvedValue({ agentId: null, role: null }),
      } as any,
      { recall: jest.fn() } as any,
      new ConfigService({}),
      { getUser: jest.fn().mockReturnValue(principal) } as any,
      { assertAccess: jest.fn().mockResolvedValue(conv) } as any,
    );
    return { service, execution, sessions };
  }

  const staff = {
    guest: false,
    id: 'u1',
    permissions: ['ai.conversations.manage'],
  };
  const guest = { guest: true, id: 'g1' };
  const msg = (channel: string, extra: Record<string, unknown> = {}) =>
    ({ channel, content: 'hello', ...extra }) as never;
  const stream = (s: AiOrchestratorService, input: never) =>
    s.handleStream('t1', input, () => undefined);

  describe('WHATSAPP belongs to the bridge', () => {
    it.each(['handle', 'handleStream'] as const)(
      '%s: a staff principal naming it is refused',
      async (method) => {
        const { service, execution } = setup(staff);
        const run = () =>
          method === 'handle'
            ? service.handle('t1', msg('WHATSAPP'))
            : stream(service, msg('WHATSAPP'));
        await expect(run()).rejects.toThrow(AppError);
        await expect(run()).rejects.toMatchObject({
          code: ErrorCode.FORBIDDEN,
        });
        expect(execution.sendMessage).not.toHaveBeenCalled();
        expect(execution.streamMessage).not.toHaveBeenCalled();
      },
    );

    it('the bridge, marked trusted, runs as WHATSAPP', async () => {
      const { service, execution } = setup(staff);
      await stream(service, msg('WHATSAPP', { trustedChannel: true }));
      expect(execution.streamMessage.mock.calls[0][5]).toBe('WHATSAPP');
    });

    it('trustedChannel is not an allowance for anything else — a dashboard turn stays a WEBSOCKET turn', async () => {
      const { service, execution } = setup(staff);
      await stream(service, msg('DASHBOARD', { trustedChannel: true }));
      expect(execution.streamMessage.mock.calls[0][5]).toBe('WEBSOCKET');
    });

    it('nothing is written before the refusal — no conversation, no session row', async () => {
      const { service, sessions } = setup(staff);
      await expect(stream(service, msg('WHATSAPP'))).rejects.toThrow();
      expect(sessions.touchChannel).not.toHaveBeenCalled();
      expect(sessions.patch).not.toHaveBeenCalled();
    });
  });

  describe('an anonymous visitor has one channel: the website widget', () => {
    it('WEBSITE is allowed', async () => {
      const { service, execution } = setup(guest);
      await stream(service, msg('WEBSITE'));
      expect(execution.streamMessage).toHaveBeenCalled();
    });

    it.each(AI_CHANNELS.filter((c) => c !== 'WEBSITE'))(
      '%s is refused',
      async (channel) => {
        const { service, execution } = setup(guest);
        await expect(
          stream(service, msg(channel, { trustedChannel: false })),
        ).rejects.toMatchObject({
          code: ErrorCode.FORBIDDEN,
        });
        expect(execution.streamMessage).not.toHaveBeenCalled();
      },
    );

    it('a guest cannot borrow the bridge flag either — it is not a wire field, but if it ever arrived it is not enough for a non-WHATSAPP claim', async () => {
      const { service } = setup(guest);
      await expect(
        stream(service, msg('DASHBOARD', { trustedChannel: true })),
      ).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
    });
  });

  describe('a signed-in staff principal', () => {
    it.each(AI_CHANNELS.filter((c) => c !== 'WHATSAPP'))(
      'may name %s',
      async (channel) => {
        const { service, execution } = setup(staff);
        await stream(service, msg(channel));
        expect(execution.streamMessage).toHaveBeenCalled();
      },
    );
  });

  it('an unknown channel string is a validation error, not a stored value', async () => {
    const { service, execution } = setup(staff);
    await expect(stream(service, msg('TIKTOK'))).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    await expect(service.handle('t1', msg('whatsapp'))).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(execution.streamMessage).not.toHaveBeenCalled();
  });

  it('the refusal says nothing about why (no channel list, no hint at the bridge)', async () => {
    const { service } = setup(staff);
    const error = await stream(service, msg('WHATSAPP')).catch((e) => e);
    expect(String(error.message)).not.toMatch(
      /bridge|trusted|whatsapp|webhook/i,
    );
  });
});
