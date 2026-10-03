import { UnrecoverableError } from 'bullmq';

import { PaymentsProcessor } from './payments.processor';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { JOB } from '../../queue/queue.constants';
import { PaymentReconciliationService } from '../../modules/payments/payment-reconciliation.service';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentOutcomeService } from '../payment-outcome.service';

describe('PaymentsProcessor', () => {
  const build = (lockToken: string | null) => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(lockToken),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const reconciliation = {
      reconcileStalePending: jest.fn().mockResolvedValue({ verified: 3 }),
      reconcileStaleSubscriptionInvoices: jest.fn().mockResolvedValue({
        scanned: 0,
        settled: 0,
        released: 0,
        stillClaimed: 0,
      }),
    };
    const metrics = { setWorkerHeartbeat: jest.fn() };
    const outcome = {
      process: jest
        .fn()
        .mockResolvedValue({ applied: true, outcome: 'paid', consumers: [] }),
    };
    const processor = new PaymentsProcessor(
      reconciliation as unknown as PaymentReconciliationService,
      outcome as unknown as PaymentOutcomeService,
      lock as unknown as DistributedLockService,
      metrics as unknown as MetricsService,
    );
    return { processor, lock, reconciliation, metrics, outcome };
  };

  it('acquires the lock, runs the reconciliation sweep, and releases the lock afterwards', async () => {
    const { processor, lock, reconciliation, metrics } = build('token-abc');

    const result = await processor.process({} as any);

    expect(reconciliation.reconcileStalePending).toHaveBeenCalled();
    expect(
      reconciliation.reconcileStaleSubscriptionInvoices,
    ).toHaveBeenCalled();
    expect(result).toEqual({
      verified: 3,
      subscriptions: { scanned: 0, settled: 0, released: 0, stillClaimed: 0 },
    });
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
    expect(
      reconciliation.reconcileStaleSubscriptionInvoices,
    ).not.toHaveBeenCalled();
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

  it('T084 — still releases the lock if the subscription-invoice sweep throws', async () => {
    const { processor, lock, reconciliation } = build('token-sub');
    reconciliation.reconcileStaleSubscriptionInvoices.mockRejectedValueOnce(
      new Error('provider down'),
    );

    await expect(processor.process({} as any)).rejects.toThrow('provider down');
    expect(lock.release).toHaveBeenCalledWith(
      'lock:payments-reconcile',
      'token-sub',
    );
  });

  // REL-005 — the queue now carries a second job type. Dispatch is by NAME; the
  // sweep used to run for ANY job on this queue.
  describe('payments.outcome (REL-005)', () => {
    const outcomeJob = (data: Record<string, unknown> = {}) =>
      ({
        name: JOB.PAYMENTS_OUTCOME,
        attemptsMade: 0,
        data: {
          tenantId: 't1',
          paymentId: 'p1',
          outcome: 'paid',
          ...data,
        },
      }) as any;

    it('routes the job to PaymentOutcomeService and NEVER runs (or locks) the reconciliation sweep', async () => {
      const { processor, outcome, lock, reconciliation } = build('token');

      const result = await processor.process(outcomeJob());

      expect(outcome.process).toHaveBeenCalledWith({
        tenantId: 't1',
        paymentId: 'p1',
        outcome: 'paid',
      });
      expect(result).toEqual({ applied: true, outcome: 'paid', consumers: [] });
      expect(lock.acquire).not.toHaveBeenCalled();
      expect(reconciliation.reconcileStalePending).not.toHaveBeenCalled();
      expect(
        reconciliation.reconcileStaleSubscriptionInvoices,
      ).not.toHaveBeenCalled();
    });

    it('does not stamp a worker heartbeat (event-driven: a quiet hour is not a dead worker)', async () => {
      const { processor, metrics } = build('token');
      await processor.process(outcomeJob());
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
    });

    it('rejects a malformed payload permanently (UnrecoverableError) before touching any consumer', async () => {
      const { processor, outcome } = build('token');

      await expect(
        processor.process(outcomeJob({ paymentId: '' })),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(outcome.process).not.toHaveBeenCalled();
    });

    it('lets a consumer failure propagate so BullMQ retries the job', async () => {
      const { processor, outcome } = build('token');
      outcome.process.mockRejectedValueOnce(new Error('db down'));

      await expect(processor.process(outcomeJob())).rejects.toThrow('db down');
    });

    it('any other job name still runs the sweep (backward compatible with the repeatable job)', async () => {
      const { processor, reconciliation, outcome } = build('token');
      await processor.process({ name: JOB.PAYMENTS_RECONCILE } as any);
      expect(reconciliation.reconcileStalePending).toHaveBeenCalled();
      expect(outcome.process).not.toHaveBeenCalled();
    });

    describe('exhaustion alert', () => {
      it('raises an ALERT once the retry budget is spent', () => {
        const { processor } = build('token');
        const logger = (processor as any).logger as { error: jest.Mock };
        logger.error = jest.fn();

        processor.onFailed(
          {
            name: JOB.PAYMENTS_OUTCOME,
            id: 'j1',
            attemptsMade: 12,
            opts: { attempts: 12 },
            data: { paymentId: 'p1' },
          } as any,
          new Error('db down'),
        );

        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'ALERT: payments.outcome job=j1 is EXHAUSTED',
          ),
        );
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('p1'),
        );
      });

      it('raises an ALERT for an unrecoverable rejection even on the first attempt', () => {
        const { processor } = build('token');
        const logger = (processor as any).logger as { error: jest.Mock };
        logger.error = jest.fn();

        processor.onFailed(
          {
            name: JOB.PAYMENTS_OUTCOME,
            id: 'j2',
            attemptsMade: 1,
            opts: { attempts: 12 },
            data: { paymentId: 'p2' },
          } as any,
          new UnrecoverableError('bad payload'),
        );

        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('EXHAUSTED'),
        );
      });

      it('stays quiet (one ordinary error line) while retries remain', () => {
        const { processor } = build('token');
        const logger = (processor as any).logger as { error: jest.Mock };
        logger.error = jest.fn();

        processor.onFailed(
          {
            name: JOB.PAYMENTS_OUTCOME,
            id: 'j3',
            attemptsMade: 2,
            opts: { attempts: 12 },
            data: { paymentId: 'p3' },
          } as any,
          new Error('transient'),
        );

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalledWith(
          expect.stringContaining('ALERT'),
        );
      });

      it('never alerts for the reconciliation sweep', () => {
        const { processor } = build('token');
        const logger = (processor as any).logger as { error: jest.Mock };
        logger.error = jest.fn();

        processor.onFailed(
          {
            name: JOB.PAYMENTS_RECONCILE,
            id: 'j4',
            attemptsMade: 5,
            opts: { attempts: 5 },
            data: {},
          } as any,
          new Error('x'),
        );

        expect(logger.error).toHaveBeenCalledTimes(1);
      });
    });
  });
});
