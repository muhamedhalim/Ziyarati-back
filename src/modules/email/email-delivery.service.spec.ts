import { EmailDeliveryService } from './email-delivery.service';
import { EmailLog } from '../../entities/System/EmailLog';
import { EmailProviderFactory } from './providers/email-provider.factory';
import {
  createMockRepository,
  createMockDataSource,
  createMockEntityManager,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

describe('EmailDeliveryService (atomic claim — gap-closure pass, §0.8.11)', () => {
  let service: EmailDeliveryService;
  let logs: MockRepository;
  let manager: MockEntityManager;
  let dataSource: MockDataSource;
  let factory: { resolve: jest.Mock };
  let config: { get: jest.Mock };

  const provider = { name: 'noop', send: jest.fn() };

  beforeEach(() => {
    logs = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    factory = { resolve: jest.fn(() => provider) };
    config = { get: jest.fn(() => undefined) };
    provider.send.mockReset().mockResolvedValue({ success: true, providerMessageId: 'msg-1' });

    service = new EmailDeliveryService(
      logs as never,
      factory as unknown as EmailProviderFactory,
      config as never,
      dataSource as never,
    );
  });

  const job = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 't1',
    to: 'a@b.com',
    template: 'welcome',
    idempotencyKey: 'welcome:a@b.com:t1',
    ...overrides,
  });

  it('wins the claim (INSERT ... ON CONFLICT DO NOTHING RETURNING id) and sends', async () => {
    (manager.query as jest.Mock).mockResolvedValueOnce([{ id: 'row-1' }]); // insert wins

    await service.deliver(job() as never);

    expect(provider.send).toHaveBeenCalled();
    expect(logs.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'SENT' }));
  });

  it('skips sending when the row already exists AND is SENT — a genuine duplicate delivery', async () => {
    (manager.query as jest.Mock)
      .mockResolvedValueOnce([]) // insert loses (conflict)
      .mockResolvedValueOnce([{ status: 'SENT' }]); // FOR UPDATE re-check

    await service.deliver(job() as never);

    expect(provider.send).not.toHaveBeenCalled();
    expect(logs.save).not.toHaveBeenCalled();
  });

  it('retries (sends again) when the existing row is FAILED, not SENT — a legitimate retry, not a duplicate', async () => {
    (manager.query as jest.Mock)
      .mockResolvedValueOnce([]) // insert loses (conflict)
      .mockResolvedValueOnce([{ status: 'FAILED' }]); // FOR UPDATE re-check
    logs.findOne.mockResolvedValueOnce({ id: 'row-1', idempotency_key: job().idempotencyKey, attempts: 1 });

    await service.deliver(job() as never);

    expect(provider.send).toHaveBeenCalled();
    expect(logs.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'SENT' }));
  });

  it('sends best-effort with no claim at all when the job carries no idempotencyKey', async () => {
    await service.deliver(job({ idempotencyKey: undefined }) as never);

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalled();
  });

  it('re-throws a transient failure so BullMQ retries', async () => {
    (manager.query as jest.Mock).mockResolvedValueOnce([{ id: 'row-1' }]);
    provider.send.mockResolvedValueOnce({ success: false, error: 'timeout', transient: true });

    await expect(service.deliver(job() as never)).rejects.toThrow('timeout');
    expect(logs.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
  });
});
