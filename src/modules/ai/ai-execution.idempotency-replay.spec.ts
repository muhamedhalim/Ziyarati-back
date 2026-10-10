import { AiExecutionService } from './ai-execution.service';
import { AI_CONVERSATION_STATUS } from './ai.constants';
import { ErrorCode } from '../../common/errors/error-code';

/**
 * A stored idempotent response is replayed only into the conversation that
 * produced it.
 *
 * The request ledger is keyed by `(tenant, idempotencyKey)` and the key comes
 * from the client. Every anonymous visitor shares one tenant, so before this
 * check a visitor who presented another visitor's key inside their OWN
 * conversation received the other conversation's stored reply and last tool
 * result (a booking confirmation: appointment id, payment link).
 */
describe('AiExecutionService — idempotent replay is bound to its conversation', () => {
  const TENANT = 'tenant-guest';
  const MINE = '11111111-1111-4111-8111-111111111111';
  const THEIRS = '22222222-2222-4222-8222-222222222222';
  const KEY = 'shared-key-0001';

  const stored = (aiConversationId: string) => ({
    message: {
      id: 'msg-1',
      ai_conversation_id: aiConversationId,
      content: 'Your appointment is confirmed.',
    },
    retrievedChunks: 0,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    fallback: false,
    streamed: true,
    lastTool: {
      name: 'book_public_appointment',
      result: { success: true, appointmentId: 'appt-secret' },
    },
  });

  function build(replay: unknown) {
    const unused = {} as never;
    const requests = {
      claim: jest.fn().mockResolvedValue('COMPLETED'),
      completedResponse: jest.fn().mockResolvedValue(replay),
      fail: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn(),
      markProviderStarted: jest.fn(),
    };
    const providers = { for: jest.fn(), resolve: jest.fn() };
    const service = new AiExecutionService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: MINE,
          status: AI_CONVERSATION_STATUS.ACTIVE,
          channel: 'WEBSITE',
          session: {},
        }),
      } as never, // aiConversations
      unused, // messages
      unused, // rag
      providers as never, // providers
      unused, // dataSource
      { release: jest.fn().mockResolvedValue(undefined) } as never, // usage
      unused, // dispatch
      { getUser: () => undefined, getCorrelationId: () => undefined } as never, // ctx
      unused, // timeline
      { record: jest.fn().mockResolvedValue(undefined) } as never, // metrics
      { emit: jest.fn() } as never, // emitter
      unused, // budgets
      { record: jest.fn().mockResolvedValue(undefined) } as never, // costs
      requests as never, // requests
      unused, // modelRouter
      unused, // processingPolicy
      unused, // subscriptions
      unused, // access
      { get: jest.fn().mockReturnValue(10) } as never, // config
      unused, // platformSettings
      unused, // bookingContext
    );
    return { service, requests, providers };
  }

  it('replays a completed turn into the conversation that produced it (REST)', async () => {
    const { service } = build(stored(MINE));
    const result = await service.sendMessage(TENANT, MINE, {
      content: 'hello',
      idempotencyKey: KEY,
    });
    expect(result.message.ai_conversation_id).toBe(MINE);
  });

  it('replays a completed turn into the conversation that produced it (stream)', async () => {
    const { service } = build(stored(MINE));
    const onToken = jest.fn();
    const result = await service.streamMessage(
      TENANT,
      MINE,
      { content: 'hello', idempotencyKey: KEY },
      onToken,
    );
    expect(result.message.ai_conversation_id).toBe(MINE);
    expect(onToken).toHaveBeenCalledWith('Your appointment is confirmed.');
  });

  it("refuses to replay another conversation's stored reply (REST)", async () => {
    const { service, providers } = build(stored(THEIRS));
    await expect(
      service.sendMessage(TENANT, MINE, {
        content: 'hello',
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(providers.for).not.toHaveBeenCalled();
  });

  it("refuses to replay another conversation's stored reply (stream) and streams none of it", async () => {
    const { service } = build(stored(THEIRS));
    const onToken = jest.fn();
    await expect(
      service.streamMessage(
        TENANT,
        MINE,
        { content: 'hello', idempotencyKey: KEY },
        onToken,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(onToken).not.toHaveBeenCalled();
  });

  it('refuses a stored reply that carries no conversation id at all', async () => {
    const { service } = build({ ...stored(MINE), message: { content: 'x' } });
    await expect(
      service.sendMessage(TENANT, MINE, {
        content: 'hello',
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });
});
