import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { JOB, QUEUE } from '../../queue/queue.constants';
import {
  PAYMENT_OUTCOME,
  PAYMENT_OUTCOME_JOB_OPTS,
  enqueuePaymentOutcome,
  paymentOutcomeDedupeKey,
} from './payment-outcome.outbox';
import {
  createMockEntityManager,
  type MockQueryBuilder,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const PAYMENT = '11111111-1111-4111-8111-111111111111';

describe('payment outcome outbox (REL-005)', () => {
  describe('paymentOutcomeDedupeKey', () => {
    it('is deterministic per event so a redundant insert collides instead of duplicating', () => {
      const a = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.PAID,
      });
      const b = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.PAID,
      });
      expect(a).toBe(b);
      expect(a).toBe(`payment-outcome-paid-${PAYMENT}`);
    });

    it('keeps paid and failed distinct (a late success legitimately follows a failure)', () => {
      const paid = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.PAID,
      });
      const failed = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.FAILED,
      });
      expect(paid).not.toBe(failed);
    });

    it('keys the refunded STATE by its cumulative amount — partial then full are two rows, a replay is one', () => {
      const partial = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.REFUNDED,
        refundedMinor: 2500,
      });
      const full = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.REFUNDED,
        refundedMinor: 10000,
      });
      const partialAgain = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.REFUNDED,
        refundedMinor: 2500,
      });
      expect(partial).not.toBe(full);
      expect(partial).toBe(partialAgain);
    });

    it('keys a recorded refund by the refund id, so two refunds on one payment are two rows', () => {
      const r1 = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.REFUND_RECORDED,
        refundId: 'refund-1',
      });
      const r2 = paymentOutcomeDedupeKey({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.REFUND_RECORDED,
        refundId: 'refund-2',
      });
      expect(r1).not.toBe(r2);
    });

    it('never contains a colon — BullMQ rejects a custom jobId that does', () => {
      for (const outcome of Object.values(PAYMENT_OUTCOME)) {
        const key = paymentOutcomeDedupeKey({
          tenantId: TENANT,
          paymentId: PAYMENT,
          outcome,
          refundId: 'refund-1',
          refundedMinor: 100,
        });
        expect(key).not.toContain(':');
        // OutboxJob.dedupe_key is varchar(255)
        expect(key.length).toBeLessThan(255);
      }
    });
  });

  describe('enqueuePaymentOutcome', () => {
    const run = async (
      input: Parameters<typeof enqueuePaymentOutcome>[1],
    ): Promise<{
      qb: MockQueryBuilder;
      manager: ReturnType<typeof createMockEntityManager>;
    }> => {
      const manager = createMockEntityManager();
      await enqueuePaymentOutcome(manager as never, input);
      const qb = manager.createQueryBuilder.mock.results[0]
        .value as MockQueryBuilder;
      return { qb, manager };
    };

    it("writes the row through the CALLER'S transaction manager (atomic with the payment change)", async () => {
      const { manager } = await run({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.PAID,
      });
      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('inserts into outbox_jobs on the payments queue under the payments.outcome job name', async () => {
      const { qb } = await run({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.PAID,
      });
      expect(qb.into).toHaveBeenCalledWith(OutboxJob);
      const row = qb.values.mock.calls[0][0];
      expect(row).toMatchObject({
        queue: QUEUE.PAYMENTS,
        job_name: JOB.PAYMENTS_OUTCOME,
        dedupe_key: `payment-outcome-paid-${PAYMENT}`,
        payload: { tenantId: TENANT, paymentId: PAYMENT, outcome: 'paid' },
      });
    });

    it('is ON CONFLICT DO NOTHING — a duplicate must not abort the payment transaction', async () => {
      const { qb } = await run({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.FAILED,
      });
      expect(qb.orIgnore).toHaveBeenCalled();
      expect(qb.execute).toHaveBeenCalled();
    });

    it('carries a generous retry budget (an outage must not strand a captured payment)', async () => {
      const { qb } = await run({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.PAID,
      });
      const row = qb.values.mock.calls[0][0];
      expect(row.opts).toEqual({ ...PAYMENT_OUTCOME_JOB_OPTS });
      expect(PAYMENT_OUTCOME_JOB_OPTS.attempts).toBeGreaterThanOrEqual(10);
      // 12 attempts at 5s exponential backoff ≈ 5.7h of retries; guard against
      // someone shrinking it back to the queue default (5 attempts ≈ 45s).
      const totalMs =
        PAYMENT_OUTCOME_JOB_OPTS.backoff.delay *
        (Math.pow(2, PAYMENT_OUTCOME_JOB_OPTS.attempts - 1) - 1);
      expect(totalMs).toBeGreaterThan(60 * 60 * 1000);
    });

    it('puts the refund id in the payload for a recorded refund and omits it otherwise', async () => {
      const withRefund = await run({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.REFUND_RECORDED,
        refundId: 'refund-9',
      });
      expect(withRefund.qb.values.mock.calls[0][0].payload).toEqual({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: 'refund_recorded',
        refundId: 'refund-9',
      });

      const without = await run({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.PAID,
      });
      expect(without.qb.values.mock.calls[0][0].payload).not.toHaveProperty(
        'refundId',
      );
    });

    it('carries NO amount or card data — the consumer re-reads the payment', async () => {
      const { qb } = await run({
        tenantId: TENANT,
        paymentId: PAYMENT,
        outcome: PAYMENT_OUTCOME.REFUNDED,
        refundedMinor: 2500,
      });
      const payload = qb.values.mock.calls[0][0].payload;
      expect(Object.keys(payload).sort()).toEqual(
        ['outcome', 'paymentId', 'tenantId'].sort(),
      );
    });
  });
});
