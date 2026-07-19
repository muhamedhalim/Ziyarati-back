import { AiToolDispatchService } from './ai-tool-dispatch.service';

describe('AiToolDispatchService side-effect idempotency', () => {
  it('does not replay an unknown-outcome side effect', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValueOnce([{
        id: 'tool-1', status: 'UNKNOWN_OUTCOME', result: null,
      }]),
    };
    const service = new AiToolDispatchService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, dataSource as any, {} as any,
    );
    const executor = jest.fn();
    const result = await (service as any).run(
      { tenantId: 'tenant-1', aiConversationId: 'conv-1' },
      'book_appointment', 'stable-key', {}, executor,
    );
    expect(executor).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ success: false }));
  });
});
