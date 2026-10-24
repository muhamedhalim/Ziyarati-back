import { UnrecoverableError } from 'bullmq';

import { PaymentsProcessor } from './payments.processor';
import { JOB } from '../../queue/queue.constants';
import {
  PAYMENT_OUTCOME_MAX_REDRIVES,
  PAYMENT_OUTCOME_REDRIVE_DELAY_MS,
  paymentOutcomeRedriveDedupeKey,
} from '../../modules/payments/payment-outcome.outbox';

/**
 * FIN-X1 — a payments.outcome job that used its whole retry budget leaves a
 * captured payment whose booking / add-on / upgrade was never applied, with an
 * already-PUBLISHED outbox row. The processor writes a fresh, delayed, bounded
 * re-drive row instead of only logging.
 */
describe('PaymentsProcessor — exhausted payments.outcome re-drive (FIN-X1)', () => {
  const build = (withDataSource = true) => {
    const inserted: any[] = [];
    const qb: any = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn((v: any) => {
        inserted.push(v);
        return qb;
      }),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    const dataSource = { createQueryBuilder: jest.fn(() => qb) };
    const processor = new PaymentsProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      withDataSource ? (dataSource as any) : undefined,
    );
    const logger = (processor as any).logger as {
      error: jest.Mock;
      warn: jest.Mock;
    };
    logger.error = jest.fn();
    logger.warn = jest.fn();
    return { processor, inserted, qb, logger };
  };

  const exhausted = (data: Record<string, unknown>) =>
    ({
      name: JOB.PAYMENTS_OUTCOME,
      id: 'j1',
      attemptsMade: 12,
      opts: { attempts: 12 },
      data: { tenantId: 't1', paymentId: 'p1', outcome: 'paid', ...data },
    }) as any;

  const flush = () => new Promise((r) => setImmediate(r));

  it('queues ONE delayed re-drive outbox row for an exhausted job, still raising the ALERT', async () => {
    const { processor, inserted, logger } = build();

    processor.onFailed(exhausted({}), new Error('db down'));
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('EXHAUSTED'),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      job_name: JOB.PAYMENTS_OUTCOME,
      dedupe_key: paymentOutcomeRedriveDedupeKey(
        { tenantId: 't1', paymentId: 'p1', outcome: 'paid' },
        1,
      ),
      payload: { tenantId: 't1', paymentId: 'p1', outcome: 'paid', redrive: 1 },
      opts: { delay: PAYMENT_OUTCOME_REDRIVE_DELAY_MS, attempts: 12 },
    });
  });

  it('carries the refund id and advances the round on a re-driven job that exhausts again', async () => {
    const { processor, inserted } = build();

    processor.onFailed(
      exhausted({ outcome: 'refund_recorded', refundId: 'r1', redrive: 1 }),
      new Error('db down'),
    );
    await flush();

    expect(inserted[0].payload).toMatchObject({
      outcome: 'refund_recorded',
      refundId: 'r1',
      redrive: 2,
    });
    expect(inserted[0].dedupe_key).toBe(
      paymentOutcomeRedriveDedupeKey(
        {
          tenantId: 't1',
          paymentId: 'p1',
          outcome: 'refund_recorded',
          refundId: 'r1',
        },
        2,
      ),
    );
  });

  it(`stops after ${PAYMENT_OUTCOME_MAX_REDRIVES} automatic re-drives and leaves the ALERT for a human`, async () => {
    const { processor, inserted, logger } = build();

    processor.onFailed(
      exhausted({ redrive: PAYMENT_OUTCOME_MAX_REDRIVES }),
      new Error('db down'),
    );
    await flush();

    expect(inserted).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('still failing after'),
    );
  });

  it('does not re-drive an UNRECOVERABLE rejection — retrying a malformed payload cannot help', async () => {
    const { processor, inserted, logger } = build();

    processor.onFailed(exhausted({}), new UnrecoverableError('bad payload'));
    await flush();

    expect(inserted).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('EXHAUSTED'),
    );
  });

  it('does nothing while retries remain, and never for the reconciliation sweep', async () => {
    const { processor, inserted } = build();

    processor.onFailed(
      { ...exhausted({}), attemptsMade: 2 },
      new Error('transient'),
    );
    processor.onFailed(
      { name: JOB.PAYMENTS_RECONCILE, id: 'j4', attemptsMade: 5, opts: { attempts: 5 }, data: {} } as any,
      new Error('x'),
    );
    await flush();

    expect(inserted).toHaveLength(0);
  });

  it('a failure to write the re-drive is logged, never thrown out of the event handler', async () => {
    const { processor, qb, logger } = build();
    qb.execute.mockRejectedValueOnce(new Error('pg down'));

    expect(() =>
      processor.onFailed(exhausted({}), new Error('db down')),
    ).not.toThrow();
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not queue the payments.outcome re-drive'),
    );
  });

  it('without a DataSource (a unit that does not exercise this) it only raises the ALERT', async () => {
    const { processor, inserted, logger } = build(false);

    processor.onFailed(exhausted({}), new Error('db down'));
    await flush();

    expect(inserted).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('EXHAUSTED'),
    );
  });
});
