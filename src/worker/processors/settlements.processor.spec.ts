import { SettlementsProcessor } from './settlements.processor';
import { SettlementService } from '../../modules/payments/settlement.service';
import { WorkerTenantsService } from '../worker-tenants.service';
import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AppError, ErrorCode } from '../../common/errors';

describe('SettlementsProcessor', () => {
  let processor: SettlementsProcessor;
  let settlements: { generate: jest.Mock };
  let tenants: { activeTenantIds: jest.Mock };
  let queue: { enqueueSettlementsProcess: jest.Mock };

  beforeEach(() => {
    settlements = { generate: jest.fn() };
    tenants = { activeTenantIds: jest.fn() };
    queue = { enqueueSettlementsProcess: jest.fn().mockResolvedValue(undefined) };

    processor = new SettlementsProcessor(
      settlements as unknown as SettlementService,
      tenants as unknown as WorkerTenantsService,
      queue as unknown as QueueService,
      // a real (dependency-free) context service so runInTenantContext works
      new TenantContextService(),
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('fans out a per-tenant job for every active tenant on the global sweep', async () => {
    tenants.activeTenantIds.mockResolvedValueOnce(['t1', 't2', 't3']);
    const result = await processor.process({ data: { tenantId: null } } as any);
    expect(queue.enqueueSettlementsProcess).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ fannedOut: 3 });
  });

  it('generates a settlement for a per-tenant job', async () => {
    settlements.generate.mockResolvedValueOnce({ id: 'settle-1' });
    const result = await processor.process({ data: { tenantId: 't1' } } as any);
    expect(settlements.generate).toHaveBeenCalledWith('t1', expect.any(Object));
    expect(result).toEqual({ settled: true, settlementId: 'settle-1' });
  });

  it('treats "nothing to settle" as a successful no-op, not a failure', async () => {
    settlements.generate.mockRejectedValueOnce(
      new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'nothing to settle' }),
    );
    const result = await processor.process({ data: { tenantId: 't1' } } as any);
    expect(result).toMatchObject({ settled: false });
  });

  it('rethrows unexpected errors so BullMQ can retry', async () => {
    settlements.generate.mockRejectedValueOnce(new Error('db exploded'));
    await expect(processor.process({ data: { tenantId: 't1' } } as any)).rejects.toThrow('db exploded');
  });
});
