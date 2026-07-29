import { IntegrationRecoveryProcessor } from './integration-recovery.processor';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { IntegrationImportJobService } from '../../modules/integration-platform/imports/integration-import-job.service';
import { IntegrationSyncService } from '../../modules/integration-platform/sync/integration-sync.service';
import { IntegrationInboundService } from '../../modules/integration-platform/inbound/integration-inbound.service';

describe('IntegrationRecoveryProcessor', () => {
  const build = (lockToken: string | null) => {
    const lock = { acquire: jest.fn().mockResolvedValue(lockToken), release: jest.fn().mockResolvedValue(undefined) };
    const imports = { recoverStale: jest.fn().mockResolvedValue(2) };
    const syncs = { recoverStale: jest.fn().mockResolvedValue(1) };
    const inbound = { recoverStale: jest.fn().mockResolvedValue(3) };
    const processor = new IntegrationRecoveryProcessor(
      lock as unknown as DistributedLockService,
      imports as unknown as IntegrationImportJobService,
      syncs as unknown as IntegrationSyncService,
      inbound as unknown as IntegrationInboundService,
    );
    return { processor, lock, imports, syncs, inbound };
  };

  it('acquires the lock, sweeps all three services, and releases the lock afterwards', async () => {
    const { processor, lock, imports, syncs, inbound } = build('token-abc');

    const result = await processor.process({ data: { tenantId: null } } as any);

    expect(imports.recoverStale).toHaveBeenCalled();
    expect(syncs.recoverStale).toHaveBeenCalled();
    expect(inbound.recoverStale).toHaveBeenCalled();
    expect(result).toEqual({ importsRequeued: 2, syncsRequeued: 1, inboundRequeued: 3 });
    expect(lock.release).toHaveBeenCalledWith('lock:integration-recover-stale', 'token-abc');
  });

  it('skips the sweep entirely when the lock is already held elsewhere (prevents duplicate execution under a BullMQ stall-redelivery)', async () => {
    const { processor, imports, syncs, inbound, lock } = build(null);

    const result = await processor.process({ data: { tenantId: null } } as any);

    expect(imports.recoverStale).not.toHaveBeenCalled();
    expect(syncs.recoverStale).not.toHaveBeenCalled();
    expect(inbound.recoverStale).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('still releases the lock if one of the recovery calls throws', async () => {
    const { processor, lock, imports } = build('token-xyz');
    imports.recoverStale.mockRejectedValueOnce(new Error('db error'));

    await expect(processor.process({ data: { tenantId: null } } as any)).rejects.toThrow('db error');
    expect(lock.release).toHaveBeenCalledWith('lock:integration-recover-stale', 'token-xyz');
  });
});
