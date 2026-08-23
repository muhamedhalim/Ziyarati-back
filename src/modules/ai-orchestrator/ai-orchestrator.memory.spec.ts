import { ConfigService } from '@nestjs/config';
import { AiOrchestratorService } from './ai-orchestrator.service';

describe('AiOrchestratorService memory consent gate', () => {
  function setup(enabled: boolean, consent: boolean) {
    const conv = { id: 'conv-1', status: 'ACTIVE', agent: { id: 'agent-1' } };
    let session: any = {
      context: { memoryConsent: consent, customerId: 'customer-1' },
    };
    const sessions = {
      touchChannel: jest.fn(),
      get: jest.fn(async () => session),
      patch: jest.fn(async (_t, _c, patch) => {
        session = {
          ...session,
          ...patch,
          context: { ...session.context, ...(patch.context ?? {}) },
        };
        return session;
      }),
      setAgent: jest.fn(),
    };
    const memory = {
      recall: jest
        .fn()
        .mockResolvedValue([
          { type: 'preference', content: 'يفضل العربية', score: 0.9 },
        ]),
    };
    const result = {
      message: {
        id: 'm1',
        role: 'assistant',
        content: 'ok',
        created_at: new Date(),
      },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      retrievedChunks: 0,
      fallback: false,
    };
    const execution = {
      sendMessage: jest.fn(async (...args: any[]) => {
        await args[4]?.();
        return result;
      }),
      streamMessage: jest.fn(async (...args: any[]) => {
        await args[6]?.();
        return { ...result, streamed: true };
      }),
    };
    const service = new AiOrchestratorService(
      { findOne: jest.fn().mockResolvedValue(conv) } as any,
      execution as any,
      sessions as any,
      { route: jest.fn() } as any,
      memory as any,
      new ConfigService({
        AI_MEMORY_RECALL_ENABLED: enabled ? 'true' : 'false',
      }),
      // Non-guest principal: no guest ownership binding is recorded (FND-001).
      {
        getUser: jest.fn().mockReturnValue({
          id: 'user-1',
          tenantId: 'tenant-1',
          roles: [],
          permissions: [],
        }),
      } as any,
      // F-1: resuming now goes through the ownership check rather than a bare
      // tenant-scoped findOne. A non-guest principal passes on tenant alone.
      { assertAccess: jest.fn().mockResolvedValue(conv) } as any,
    );
    return { service, memory, execution, sessions };
  }

  it('does not pay for recall while the operator flag is disabled', async () => {
    const { service, memory, execution } = setup(false, true);
    await service.handle('tenant-1', {
      channel: 'WHATSAPP',
      content: 'مرحبا',
      aiConversationId: 'conv-1',
      useMemory: true,
    });
    expect(memory.recall).not.toHaveBeenCalled();
    expect(execution.sendMessage).toHaveBeenCalledWith(
      'tenant-1',
      'conv-1',
      expect.any(Object),
      'WHATSAPP',
      undefined,
    );
  });

  it('does not recall without explicit session consent', async () => {
    const { service, memory } = setup(true, false);
    await service.handle('tenant-1', {
      channel: 'API',
      content: 'hello',
      aiConversationId: 'conv-1',
      useMemory: true,
    });
    expect(memory.recall).not.toHaveBeenCalled();
  });

  it('recalls tenant/customer-scoped memory only when enabled and consented', async () => {
    const { service, memory, sessions } = setup(true, true);
    await service.handle('tenant-1', {
      channel: 'API',
      content: 'hello',
      aiConversationId: 'conv-1',
      useMemory: true,
    });
    expect(memory.recall).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ customerId: 'customer-1', limit: 5 }),
      expect.objectContaining({ channel: 'REST', aiConversationId: 'conv-1' }),
    );
    expect(sessions.patch).toHaveBeenLastCalledWith(
      'tenant-1',
      'conv-1',
      expect.objectContaining({
        context: expect.objectContaining({
          recalledMemories: [
            expect.objectContaining({ content: 'يفضل العربية' }),
          ],
        }),
      }),
    );
  });

  it('attributes website streaming to WebSocket without changing the response contract', async () => {
    const { service, execution } = setup(false, false);
    const result = await service.handleStream(
      'tenant-1',
      { channel: 'WEBSITE', content: 'hello', aiConversationId: 'conv-1' },
      jest.fn(),
    );
    expect(execution.streamMessage).toHaveBeenCalledWith(
      'tenant-1',
      'conv-1',
      expect.any(Object),
      expect.any(Function),
      undefined,
      'WEBSOCKET',
      undefined,
      // `onToolEvent` — the per-tool progress listener (`AiToolProgressEvent`).
      // Undefined here because this caller passed none; the gateway supplies
      // one so the widget can show a status line sourced from a real tool call
      // rather than a timer.
      undefined,
    );
    expect(result).toMatchObject({
      channel: 'WEBSITE',
      streamed: true,
      handedOver: false,
    });
  });
});
