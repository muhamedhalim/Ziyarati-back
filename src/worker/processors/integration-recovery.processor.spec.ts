import { IntegrationRecoveryProcessor } from './integration-recovery.processor';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { IntegrationImportJobService } from '../../modules/integration-platform/imports/integration-import-job.service';
import { IntegrationSyncService } from '../../modules/integration-platform/sync/integration-sync.service';
import { IntegrationInboundService } from '../../modules/integration-platform/inbound/integration-inbound.service';
import { IntegrationIdempotencyService } from '../../modules/integration-platform/idempotency/integration-idempotency.service';
import { IntegrationOAuthService } from '../../modules/integration-platform/oauth/integration-oauth.service';
import { JOB } from '../../queue/queue.constants';

describe('IntegrationRecoveryProcessor', () => {
  const build = (lockToken: string | null) => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(lockToken),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const imports = { recoverStale: jest.fn().mockResolvedValue(2) };
    const syncs = { recoverStale: jest.fn().mockResolvedValue(1) };
    const inbound = {
      recoverStale: jest.fn().mockResolvedValue(3),
      purgeExpired: jest.fn().mockResolvedValue(7),
    };
    const idempotency = { purgeExpired: jest.fn().mockResolvedValue(11) };
    const oauth = { purgeExpiredStates: jest.fn().mockResolvedValue(2) };
    const metrics = { setWorkerHeartbeat: jest.fn() };
    const processor = new IntegrationRecoveryProcessor(
      lock as unknown as DistributedLockService,
      imports as unknown as IntegrationImportJobService,
      syncs as unknown as IntegrationSyncService,
      inbound as unknown as IntegrationInboundService,
      metrics as any,
      idempotency as unknown as IntegrationIdempotencyService,
      oauth as unknown as IntegrationOAuthService,
    );
    return { processor, lock, imports, syncs, inbound, idempotency, oauth, metrics };
  };

  it('acquires the lock, sweeps all three services, and releases the lock afterwards', async () => {
    const { processor, lock, imports, syncs, inbound, metrics } =
      build('token-abc');

    const result = await processor.process({ data: { tenantId: null } } as any);

    expect(imports.recoverStale).toHaveBeenCalled();
    expect(syncs.recoverStale).toHaveBeenCalled();
    expect(inbound.recoverStale).toHaveBeenCalled();
    expect(result).toEqual({
      importsRequeued: 2,
      syncsRequeued: 1,
      inboundRequeued: 3,
    });
    expect(lock.release).toHaveBeenCalledWith(
      'lock:integration-recover-stale',
      'token-abc',
    );
    expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
      'integration.recoverStale',
    );
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

    await expect(
      processor.process({ data: { tenantId: null } } as any),
    ).rejects.toThrow('db error');
    expect(lock.release).toHaveBeenCalledWith(
      'lock:integration-recover-stale',
      'token-xyz',
    );
  });

  describe('retention purge (integration.purgeExpired)', () => {
    const purgeJob = { name: JOB.INTEGRATION_PURGE_EXPIRED, data: { tenantId: null } } as any;

    it('purges idempotency records, inbound history and OAuth states, then reports the counts', async () => {
      const { processor, lock, idempotency, inbound, oauth, metrics } = build('token-p');

      const result = await processor.process(purgeJob);

      expect(idempotency.purgeExpired).toHaveBeenCalledTimes(1);
      expect(inbound.purgeExpired).toHaveBeenCalledTimes(1);
      expect(oauth.purgeExpiredStates).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ idempotencyPurged: 11, inboundEventsPurged: 7, oauthStatesPurged: 2 });
      expect(lock.acquire).toHaveBeenCalledWith('lock:integration-purge-expired', expect.any(Number));
      expect(lock.release).toHaveBeenCalledWith('lock:integration-purge-expired', 'token-p');
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith('integration.purgeExpired');
    });

    it('does NOT run the stale-recovery sweep for a purge job (and vice versa)', async () => {
      const { processor, imports, syncs, inbound, idempotency } = build('t');
      await processor.process(purgeJob);
      expect(imports.recoverStale).not.toHaveBeenCalled();
      expect(syncs.recoverStale).not.toHaveBeenCalled();
      expect(inbound.recoverStale).not.toHaveBeenCalled();

      await processor.process({ name: JOB.INTEGRATION_RECOVER_STALE, data: { tenantId: null } } as any);
      expect(imports.recoverStale).toHaveBeenCalledTimes(1);
      expect(idempotency.purgeExpired).toHaveBeenCalledTimes(1); // still only the first run's call
    });

    it('uses its OWN lock, so a running recovery sweep never blocks the purge', async () => {
      const { processor, lock } = build('t');
      await processor.process(purgeJob);
      await processor.process({ name: JOB.INTEGRATION_RECOVER_STALE, data: { tenantId: null } } as any);
      expect(lock.acquire.mock.calls.map((c) => c[0])).toEqual([
        'lock:integration-purge-expired',
        'lock:integration-recover-stale',
      ]);
    });

    it('skips entirely when another worker already holds the purge lock', async () => {
      const { processor, idempotency, inbound, oauth, lock } = build(null);
      expect(await processor.process(purgeJob)).toEqual({ skipped: true });
      expect(idempotency.purgeExpired).not.toHaveBeenCalled();
      expect(inbound.purgeExpired).not.toHaveBeenCalled();
      expect(oauth.purgeExpiredStates).not.toHaveBeenCalled();
      expect(lock.release).not.toHaveBeenCalled();
    });

    it('releases the lock even if a purge throws, and does not run the later purges', async () => {
      const { processor, lock, idempotency, inbound } = build('t-err');
      idempotency.purgeExpired.mockRejectedValueOnce(new Error('db down'));
      await expect(processor.process(purgeJob)).rejects.toThrow('db down');
      expect(inbound.purgeExpired).not.toHaveBeenCalled();
      expect(lock.release).toHaveBeenCalledWith('lock:integration-purge-expired', 't-err');
    });
  });
});
