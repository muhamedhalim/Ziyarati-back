import { ConfigService } from '@nestjs/config';
import { AiOrchestratorService } from './ai-orchestrator.service';

/**
 * A WhatsApp AI session used to be created with no linked timeline
 * Conversation, so its turns were never mirrored where an agent could see them,
 * and a handover on it created a bare thread that could not deliver an agent's
 * reply over WhatsApp. The inbound bridge now stores each message on a thread
 * first and hands that thread's id in; the orchestrator binds the session to it.
 *
 * `conversationId` is ALSO a field the HTTP/WS DTOs let a client fill in, so
 * binding a RESUMED session is honoured only for a trusted bridge.
 */
describe('AiOrchestratorService — binding a session to its timeline thread', () => {
  function setup(conv: Record<string, unknown>) {
    const aiConversations = {
      findOne: jest.fn(),
      start: jest.fn().mockResolvedValue(conv),
      linkTimelineConversation: jest.fn().mockResolvedValue(true),
    };
    const execution = {
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
      recordInboundWhileHandedOver: jest
        .fn()
        .mockResolvedValue({ handedOver: true }),
    };
    const sessions = {
      touchChannel: jest.fn(),
      get: jest.fn().mockResolvedValue({ context: {} }),
      patch: jest.fn().mockResolvedValue({}),
      patchFromClient: jest.fn(),
      setAgent: jest.fn(),
    };
    const service = new AiOrchestratorService(
      aiConversations as any,
      execution as any,
      sessions as any,
      {
        route: jest.fn().mockResolvedValue({ agentId: null, role: null }),
      } as any,
      { recall: jest.fn() } as any,
      new ConfigService({}),
      {
        getUser: jest
          .fn()
          .mockReturnValue({ guest: false, id: 'u1', permissions: [] }),
      } as any,
      { assertAccess: jest.fn().mockResolvedValue(conv) } as any,
      { requestForCustomer: jest.fn() } as any,
    );
    return { service, aiConversations, execution };
  }

  const unlinked = { id: 'ai-1', status: 'ACTIVE', agent: undefined };
  const linked = { ...unlinked, conversation: { id: 'handover-thread' } };
  const run = (
    service: AiOrchestratorService,
    extra: Record<string, unknown>,
  ) =>
    service.handleStream(
      't1',
      {
        channel: 'WHATSAPP',
        content: 'hi',
        aiConversationId: 'ai-1',
        conversationId: 'thread-9',
        ...extra,
      } as never,
      () => undefined,
    );

  it('a trusted bridge binds a resumed session that has no thread yet', async () => {
    const { service, aiConversations } = setup(unlinked);

    await run(service, { trustedChannel: true });

    expect(aiConversations.linkTimelineConversation).toHaveBeenCalledWith(
      't1',
      'ai-1',
      'thread-9',
    );
  });

  it('never re-points a session that is already linked', async () => {
    const { service, aiConversations } = setup(linked);

    await run(service, { trustedChannel: true });

    expect(aiConversations.linkTimelineConversation).not.toHaveBeenCalled();
  });

  it('does nothing without a thread id to bind to', async () => {
    const { service, aiConversations } = setup(unlinked);

    await run(service, { trustedChannel: true, conversationId: undefined });

    expect(aiConversations.linkTimelineConversation).not.toHaveBeenCalled();
  });

  it('refuses to bind for a caller that is not the trusted bridge — conversationId is client-fillable', async () => {
    const { service, aiConversations } = setup(unlinked);

    // A dashboard turn (the allow-list would reject WHATSAPP outright), with a
    // client-chosen `conversationId` on a session it resumes.
    await run(service, { channel: 'DASHBOARD', trustedChannel: undefined });

    expect(aiConversations.linkTimelineConversation).not.toHaveBeenCalled();
  });

  it('a NEW session is created already bound to the thread', async () => {
    const { service, aiConversations } = setup(unlinked);

    await run(service, { trustedChannel: true, aiConversationId: undefined });

    expect(aiConversations.start).toHaveBeenCalledWith('t1', {
      agentId: undefined,
      conversationId: 'thread-9',
    });
    expect(aiConversations.linkTimelineConversation).not.toHaveBeenCalled();
  });

  it('passes the wamid on when the turn is not answered because a human owns it', async () => {
    // The bridge already stored the patient's message under this wamid; the
    // engine must be told, or its own mirror would write a second copy.
    const { service, execution } = setup({ ...linked, status: 'HANDED_OVER' });
    const origin = { waMessageId: 'wamid.1', messageType: 'text' };

    const result = await run(service, { trustedChannel: true, origin });

    expect(result.handedOver).toBe(true);
    expect(execution.streamMessage).not.toHaveBeenCalled();
    expect(execution.recordInboundWhileHandedOver).toHaveBeenCalledWith(
      't1',
      'ai-1',
      'hi',
      origin,
    );
  });

  it('recordInboundWithoutAnswer persists a message the policy refused to answer, without calling the model', async () => {
    const { service, execution } = setup(linked);
    const origin = { waMessageId: 'wamid.2', messageType: 'text' };

    await service.recordInboundWithoutAnswer('t1', 'ai-1', 'hello', origin);

    expect(execution.recordInboundWhileHandedOver).toHaveBeenCalledWith(
      't1',
      'ai-1',
      'hello',
      origin,
    );
    expect(execution.streamMessage).not.toHaveBeenCalled();
  });
});
