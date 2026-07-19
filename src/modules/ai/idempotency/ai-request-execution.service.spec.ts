import { AiRequestExecutionService } from './ai-request-execution.service';

describe('AiRequestExecutionService', () => {
  it('claims a new request exactly once', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'id-1' }]);
    const service = new AiRequestExecutionService({
      transaction: (fn: (m: any) => unknown) => fn({ query }),
    } as any);
    await expect(service.claim('tenant-1', 'key-1', 'chat', 'API')).resolves.toBe('CLAIMED');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns completed without reopening or paying again', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ state: 'COMPLETED' }]);
    const service = new AiRequestExecutionService({ transaction: (fn: (m: any) => unknown) => fn({ query }) } as any);
    await expect(service.claim('tenant-1', 'key-1', 'chat', 'API')).resolves.toBe('COMPLETED');
  });

  it('never automatically reopens an unknown provider outcome', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ state: 'UNKNOWN_OUTCOME' }]);
    const service = new AiRequestExecutionService({ transaction: (fn: (m: any) => unknown) => fn({ query }) } as any);
    await expect(service.claim('tenant-1', 'key-1', 'chat', 'API')).resolves.toBe('UNKNOWN');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
