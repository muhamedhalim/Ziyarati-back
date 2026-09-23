import { UnrecoverableError } from 'bullmq';

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

    const err = await service.deliver(job() as never).catch((e) => e);
    expect(err.message).toBe('timeout');
    expect(err).not.toBeInstanceOf(UnrecoverableError); // retryable
    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  // Production incident: Resend 422 (invalid `from`) was recorded FAILED but the
  // BullMQ job still COMPLETED, so nothing reported a failure for weeks.
  it('throws UnrecoverableError on a PERMANENT failure — the job must end FAILED, not COMPLETED, and must not retry', async () => {
    (manager.query as jest.Mock).mockResolvedValueOnce([{ id: 'row-1' }]);
    provider.send.mockResolvedValueOnce({
      success: false,
      error:
        'HTTP 422: {"name":"validation_error","message":"Invalid `from` field."}',
      transient: false,
    });

    const err = await service.deliver(job() as never).catch((e) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toContain('template=welcome');
    expect(err.message).toContain('HTTP 422');
    expect(logs.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
  });

  it('a permanent failure is recorded as FAILED before the throw, so a re-driven job re-claims the row and sends', async () => {
    (manager.query as jest.Mock).mockResolvedValueOnce([{ id: 'row-1' }]);
    provider.send.mockResolvedValueOnce({
      success: false,
      error: 'HTTP 403',
      transient: false,
    });
    await service.deliver(job() as never).catch(() => undefined);
    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );

    // Operator fixes the config and retries the failed job: the FAILED row is claimable.
    (manager.query as jest.Mock)
      .mockResolvedValueOnce([]) // insert loses (row exists)
      .mockResolvedValueOnce([{ status: 'FAILED' }]);
    logs.findOne.mockResolvedValueOnce({
      id: 'row-1',
      idempotency_key: job().idempotencyKey,
      attempts: 1,
    });
    await service.deliver(job() as never);

    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(logs.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'SENT' }),
    );
  });

  it('forwards the claimed idempotency key to the provider (provider-side dedupe of an unobserved success)', async () => {
    (manager.query as jest.Mock).mockResolvedValueOnce([{ id: 'row-1' }]);

    await service.deliver(job() as never);

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'welcome:a@b.com:t1' }),
    );
  });

  it('a successful send does not throw (job COMPLETES)', async () => {
    (manager.query as jest.Mock).mockResolvedValueOnce([{ id: 'row-1' }]);
    await expect(service.deliver(job() as never)).resolves.toBeUndefined();
  });
});

// VER-016 (REQ-NOTIF-002) — platform email delivery logs (`GET
// /platform/email-logs`, super-admin only). `listLogs`/`stats` had ZERO
// prior test coverage.
describe('EmailDeliveryService.listLogs / stats (VER-016 — platform observability)', () => {
  let service: EmailDeliveryService;
  let logs: MockRepository;

  beforeEach(() => {
    logs = createMockRepository();
    service = new EmailDeliveryService(
      logs as never,
      { resolve: jest.fn() } as unknown as EmailProviderFactory,
      { get: jest.fn() } as never,
      createMockDataSource() as never,
    );
  });

  describe('listLogs', () => {
    it('is intentionally PLATFORM-WIDE — no tenant filter — this is the super-admin cross-tenant view', async () => {
      logs.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listLogs({ page: 1, limit: 20 });
      expect(logs.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, order: { created_at: 'DESC' } }),
      );
    });

    it('an optional status filter narrows the where clause', async () => {
      logs.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listLogs({ status: 'FAILED', page: 1, limit: 20 });
      expect(logs.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'FAILED' } }));
    });

    it('an optional search term matches the recipient address case-insensitively (ILike)', async () => {
      logs.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.listLogs({ search: 'alice@example.com', page: 1, limit: 20 });
      const call = logs.findAndCount.mock.calls[0][0];
      expect(call.where.to_address).toBeDefined();
    });

    it('paginates correctly', async () => {
      logs.findAndCount.mockResolvedValueOnce([[{ id: 'log-1' }], 45]);
      const result = await service.listLogs({ page: 3, limit: 10 });
      expect(logs.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
      expect(result).toEqual({ data: [{ id: 'log-1' }], total: 45, page: 3, limit: 10 });
    });
  });

  describe('stats', () => {
    it('groups by status into sent/failed/queued/total counts', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { status: 'SENT', count: '120' },
          { status: 'FAILED', count: '3' },
          { status: 'QUEUED', count: '7' },
        ]),
      };
      logs.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.stats();

      expect(result).toEqual({ sent: 120, failed: 3, queued: 7, total: 130 });
    });

    it('defaults every count to 0 when there is no data at all — never NaN/undefined', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      logs.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.stats();

      expect(result).toEqual({ sent: 0, failed: 0, queued: 0, total: 0 });
    });
  });
});
