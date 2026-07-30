import { PaymentsProcessor } from './payments.processor';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { PaymentReconciliationService } from '../../modules/payments/payment-reconciliation.service';
import { MetricsService } from '../../metrics/metrics.service';

describe('PaymentsProcessor', () => {
  const build = (lockToken: string | null) => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(lockToken),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const reconciliation = {
      reconcileStalePending: jest.fn().mockResolvedValue({ verified: 3 }),
    };
    const metrics = { setWorkerHeartbeat: jest.fn() };
    const processor = new PaymentsProcessor(
      reconciliation as unknown as PaymentReconciliationService,
      lock as unknown as DistributedLockService,
      metrics as unknown as MetricsService,
    );
    return { processor, lock, reconciliation, metrics };
  };

  it('acquires the lock, runs the reconciliation sweep, and releases the lock afterwards', async () => {
    const { processor, lock, reconciliation, metrics } = build('token-abc');

    const result = await processor.process({} as any);

    expect(reconciliation.reconcileStalePending).toHaveBeenCalled();
    expect(result).toEqual({ verified: 3 });
    expect(lock.release).toHaveBeenCalledWith(
      'lock:payments-reconcile',
      'token-abc',
    );
    expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
      'payments.reconcile',
    );
  });

  it('skips the sweep when the lock is already held elsewhere (overlapping run, M9)', async () => {
    const { processor, reconciliation, lock } = build(null);

    const result = await processor.process({} as any);

    expect(reconciliation.reconcileStalePending).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('still releases the lock if the reconciliation sweep throws', async () => {
    const { processor, lock, reconciliation } = build('token-xyz');
    reconciliation.reconcileStalePending.mockRejectedValueOnce(
      new Error('gateway down'),
    );

    await expect(processor.process({} as any)).rejects.toThrow('gateway down');
    expect(lock.release).toHaveBeenCalledWith(
      'lock:payments-reconcile',
      'token-xyz',
    );
  });
});
