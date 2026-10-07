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

  describe('abandoned claims (stale takeover)', () => {
    const svc = (row: Record<string, unknown>) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row])
        .mockResolvedValue([]);
      const service = new AiRequestExecutionService({
        transaction: (fn: (m: any) => unknown) => fn({ query }),
      } as any);
      return { service, query };
    };

    it('lets a stale STARTED claim be redone — the provider was never called', async () => {
      const { service, query } = svc({ state: 'STARTED', stale: true });
      await expect(service.claim('t', 'k', 'chat', 'WHATSAPP')).resolves.toBe('CLAIMED');
      expect(query).toHaveBeenCalledTimes(3);
    });

    it('closes a stale PROVIDER_IN_PROGRESS claim as UNKNOWN_OUTCOME, never redoing it', async () => {
      const { service, query } = svc({ state: 'PROVIDER_IN_PROGRESS', stale: true });
      await expect(service.claim('t', 'k', 'chat', 'WHATSAPP')).resolves.toBe('UNKNOWN');
      expect(query.mock.calls[2][0]).toContain("state='UNKNOWN_OUTCOME'");
    });

    it('leaves a fresh in-flight claim alone', async () => {
      const { service, query } = svc({ state: 'PROVIDER_IN_PROGRESS', stale: false });
      await expect(service.claim('t', 'k', 'chat', 'WHATSAPP')).resolves.toBe('IN_FLIGHT');
      expect(query).toHaveBeenCalledTimes(2);
    });
  });
});
