import { RefundWebhookService } from './refund-webhook.service';
import { PaymentStatus } from '../../entities/enums';
import type { GatewayRefundEvent } from './webhooks/gateway-webhook.types';
import {
  createMockDataSource,
  createMockEntityManager,
  createMockQueryBuilder,
  createMockRepository,
  MockEntityManager,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { Refund } from '../../entities/Payments/Refund';
import { Payment } from '../../entities/Payments/Payment';

const REFUND_UUID = '33333333-3333-4333-8333-333333333333';

describe('RefundWebhookService.process', () => {
  let service: RefundWebhookService;
  let payments: MockRepository; // the injected repository (owner lookup, outside the tx)
  let m: MockEntityManager;
  let refundRepo: MockRepository;
  let lockedPaymentRepo: MockRepository;
  let transactions: { recordWebhookOnce: jest.Mock };
  let completion: { complete: jest.Mock; emitAfterCommit: jest.Mock };
  let exceptions: { raiseQuietly: jest.Mock };
  let invoiceRefunds: { applyGatewayRefund: jest.Mock };
  /** What the admission sum reads for an adopted external refund. */
  let admittedSum: string;

  const owner = (over: Record<string, unknown> = {}): any => ({
    id: 'pay-1',
    amount: 100,
    currency: 'SAR',
    status: PaymentStatus.PAID,
    gateway_payment_id: 'chg_1',
    tenant: { id: 't1' },
    customer: { id: 'cust-1' },
    appointment: { id: 'appt-1' },
    ...over,
  });
  const event = (
    over: Partial<GatewayRefundEvent> = {},
  ): GatewayRefundEvent => ({
    provider: 'tap',
    gatewayRefundId: 're_1',
    gatewayPaymentId: 'chg_1',
    outcome: 'succeeded',
    amountMinorUnits: 6000,
    currency: 'SAR',
    dedupeKey: 'tap:re_1:REFUNDED',
    eventLabel: 'refund.refunded',
    raw: { id: 're_1' },
    ...over,
  });
  const pendingRefund = (over: Record<string, unknown> = {}): any => ({
    id: 'rf-1',
    amount: 60,
    status: 'PENDING',
    gateway_refund_id: null,
    ...over,
  });

  beforeEach(() => {
    payments = createMockRepository();
    refundRepo = createMockRepository();
    lockedPaymentRepo = createMockRepository();
    refundRepo.save.mockImplementation(async (r: any) => r);
    refundRepo.create.mockImplementation((d: any) => ({ id: 'rf-new', ...d }));
    m = createMockEntityManager(
      new Map<unknown, MockRepository>([
        [Refund, refundRepo],
        [Payment, lockedPaymentRepo],
      ]),
    );
    admittedSum = '0.00';
    m.createQueryBuilder = jest.fn(() => {
      const qb = createMockQueryBuilder();
      qb.getRawOne = jest.fn().mockResolvedValue({ sum: admittedSum });
      return qb;
    });
    transactions = {
      recordWebhookOnce: jest.fn().mockResolvedValue({ created: true }),
    };
    completion = {
      complete: jest.fn().mockResolvedValue({
        status: 'SUCCEEDED',
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
      }),
      emitAfterCommit: jest.fn(),
    };
    payments.findOne.mockResolvedValue(owner());
    lockedPaymentRepo.findOne.mockResolvedValue(owner());
    refundRepo.findOne.mockResolvedValue(null);
    refundRepo.find.mockResolvedValue([]);

    exceptions = { raiseQuietly: jest.fn().mockResolvedValue(undefined) };
    invoiceRefunds = {
      applyGatewayRefund: jest.fn().mockResolvedValue({ matched: false }),
    };
    service = new RefundWebhookService(
      payments as any,
      createMockDataSource(m) as any,
      transactions as any,
      completion as any,
      exceptions as any,
      invoiceRefunds as any,
    );
  });

  describe('resolving the payment (tenant comes from OUR row)', () => {
    it('a refund for an unknown charge is accepted, unmatched, and touches nothing', async () => {
      payments.findOne.mockResolvedValue(null);
      await expect(service.process(event())).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(transactions.recordWebhookOnce).not.toHaveBeenCalled();
      expect(completion.complete).not.toHaveBeenCalled();
    });

    it('an event with no charge id is unmatched (never looked up by an undefined id)', async () => {
      await expect(
        service.process(event({ gatewayPaymentId: undefined })),
      ).resolves.toEqual({
        accepted: true,
        matched: false,
      });
      expect(payments.findOne).not.toHaveBeenCalled();
    });
  });

  describe('dedupe', () => {
    it('a redelivery (same {refund}:{status} key) is a no-op', async () => {
      transactions.recordWebhookOnce.mockResolvedValue({ created: false });
      const res = await service.process(event());
      expect(res).toMatchObject({ matched: true, deduplicated: true });
      expect(completion.complete).not.toHaveBeenCalled();
      expect(completion.emitAfterCommit).toHaveBeenCalledWith(undefined);
    });

    it('records the delivery on the LOCKED payment, inside the transaction', async () => {
      await service.process(event());
      expect(lockedPaymentRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(transactions.recordWebhookOnce).toHaveBeenCalledWith(
        't1',
        'pay-1',
        expect.objectContaining({
          type: 'webhook',
          gatewayTransactionId: 'tap:re_1:REFUNDED',
          status: 'refund.refunded',
        }),
        m,
      );
    });
  });

  describe('matching OUR refund row', () => {
    it('1) by the gateway refund id', async () => {
      refundRepo.findOne.mockResolvedValueOnce(
        pendingRefund({ gateway_refund_id: 're_1' }),
      );

      await service.process(event());

      expect(refundRepo.findOne).toHaveBeenCalledWith({
        where: { gateway_refund_id: 're_1', payment: { id: 'pay-1' } },
      });
      expect(completion.complete).toHaveBeenCalledWith(
        m,
        expect.objectContaining({
          tenantId: 't1',
          outcome: 'succeeded',
          gatewayRefundId: 're_1',
          gatewayTransactionId: 'chg_1',
          refund: expect.objectContaining({ id: 'rf-1' }),
        }),
      );
    });

    it('2) by the reference we sent (our refund id) when the gateway id was never stored', async () => {
      refundRepo.findOne.mockResolvedValueOnce(null); // by gateway id
      refundRepo.findOne.mockResolvedValueOnce(
        pendingRefund({ id: REFUND_UUID }),
      );

      await service.process(event({ correlationId: REFUND_UUID }));

      expect(completion.complete).toHaveBeenCalledWith(
        m,
        expect.objectContaining({
          refund: expect.objectContaining({ id: REFUND_UUID }),
        }),
      );
    });

    it('a non-uuid correlation id is never used as a lookup key', async () => {
      await service.process(
        event({ correlationId: 'not-a-uuid', outcome: 'pending' }),
      );
      expect(refundRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('3) the ONE pending refund with no gateway id and the same amount', async () => {
      refundRepo.find.mockResolvedValue([
        pendingRefund(),
        pendingRefund({ id: 'rf-other', amount: 25 }),
      ]);

      await service.process(event());

      expect(completion.complete).toHaveBeenCalledWith(
        m,
        expect.objectContaining({
          refund: expect.objectContaining({ id: 'rf-1' }),
        }),
      );
    });

    it('3) …but never guesses between two identical pending refunds', async () => {
      refundRepo.find.mockResolvedValue([
        pendingRefund(),
        pendingRefund({ id: 'rf-2' }),
      ]);
      admittedSum = '120.00'; // both pending (60 + 60) already fill the payment: nothing to adopt either

      await service.process(event());

      expect(completion.complete).not.toHaveBeenCalled();
      expect(refundRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('applying the outcome to a matched refund', () => {
    beforeEach(() => {
      refundRepo.findOne.mockResolvedValueOnce(
        pendingRefund({ gateway_refund_id: 're_1' }),
      );
    });

    it('succeeded → completes SUCCEEDED and announces payment.refunded (the webhook path always has)', async () => {
      await service.process(event());
      expect(completion.complete).toHaveBeenCalledWith(
        m,
        expect.objectContaining({
          outcome: 'succeeded',
          announce: { customerId: 'cust-1', appointmentId: 'appt-1' },
        }),
      );
    });

    it('failed → completes FAILED, announces nothing', async () => {
      await service.process(
        event({
          outcome: 'failed',
          dedupeKey: 'tap:re_1:DECLINED',
          failureReason: 'Refund was rejected by the payment gateway',
        }),
      );
      expect(completion.complete).toHaveBeenCalledWith(
        m,
        expect.objectContaining({
          outcome: 'failed',
          failureReason: 'Refund was rejected by the payment gateway',
          announce: undefined,
        }),
      );
    });

    it.each(['pending', 'unknown'] as const)(
      '%s → nothing changes except remembering the gateway id',
      async (outcome) => {
        refundRepo.findOne.mockReset();
        refundRepo.findOne.mockResolvedValueOnce(pendingRefund()); // no gateway id yet
        await service.process(
          event({ outcome, dedupeKey: `tap:re_1:${outcome}` }),
        );
        expect(completion.complete).not.toHaveBeenCalled();
        expect(refundRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({ gateway_refund_id: 're_1' }),
        );
      },
    );

    it('emits the in-process events only after the transaction', async () => {
      await service.process(event());
      expect(completion.emitAfterCommit).toHaveBeenCalledTimes(1);
    });

    it('the amount must match THIS refund, or it is never booked', async () => {
      await service.process(event({ amountMinorUnits: 7000 }));
      expect(completion.complete).not.toHaveBeenCalled();
    });

    it('the currency must match the payment, or it is never booked', async () => {
      await service.process(event({ currency: 'USD' }));
      expect(completion.complete).not.toHaveBeenCalled();
    });
  });

  describe('terminal refunds never move', () => {
    it.each(['SUCCEEDED', 'FAILED'])(
      'a %s refund ignores a later event',
      async (status) => {
        refundRepo.findOne.mockResolvedValueOnce(
          pendingRefund({ status, gateway_refund_id: 're_1' }),
        );
        const res = await service.process(event());
        expect(completion.complete).not.toHaveBeenCalled();
        expect(res).toMatchObject({ matched: true, deduplicated: false });
      },
    );
  });

  describe("a refund issued OUTSIDE ZiyaraTech (e.g. from the clinic's own Tap dashboard)", () => {
    it('a COMPLETED one that fits is booked as a gateway-reconciled refund', async () => {
      admittedSum = '0.00';

      await service.process(event());

      expect(refundRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 60,
          status: 'PENDING',
          reason: 'Gateway-reconciled refund (webhook)',
          gateway_refund_id: 're_1',
          tenant: { id: 't1' },
          payment: { id: 'pay-1' },
        }),
      );
      expect(completion.complete).toHaveBeenCalledWith(
        m,
        expect.objectContaining({
          outcome: 'succeeded',
          refund: expect.objectContaining({ id: 'rf-new' }),
        }),
      );
    });

    it('is refused when it would exceed what is still refundable — surfaced, never booked', async () => {
      admittedSum = '50.00'; // 50 + 60 > 100
      await service.process(event());
      expect(refundRepo.save).not.toHaveBeenCalled();
      expect(completion.complete).not.toHaveBeenCalled();
    });

    it.each(['pending', 'failed', 'unknown'] as const)(
      'a %s external refund changes nothing',
      async (outcome) => {
        await service.process(event({ outcome }));
        expect(refundRepo.save).not.toHaveBeenCalled();
        expect(completion.complete).not.toHaveBeenCalled();
      },
    );

    it.each([
      PaymentStatus.PENDING,
      PaymentStatus.FAILED,
      PaymentStatus.REFUNDED,
    ])('is refused against a payment in status %s', async (status) => {
      lockedPaymentRepo.findOne.mockResolvedValue(owner({ status }));
      await service.process(event());
      expect(completion.complete).not.toHaveBeenCalled();
    });

    it('is refused for a different currency or a non-positive amount', async () => {
      await service.process(event({ currency: 'USD' }));
      await service.process(event({ amountMinorUnits: 0 }));
      await service.process(event({ amountMinorUnits: undefined }));
      expect(completion.complete).not.toHaveBeenCalled();
    });
  });

  describe('recording what it will not book (REFUND_MISMATCH)', () => {
    it('a refund whose amount is not ours is not booked, and is raised AFTER the transaction', async () => {
      refundRepo.findOne.mockResolvedValueOnce(
        pendingRefund({ gateway_refund_id: 're_1' }),
      );

      await service.process(event({ amountMinorUnits: 7000 }));

      expect(completion.complete).not.toHaveBeenCalled();
      expect(exceptions.raiseQuietly).toHaveBeenCalledTimes(1);
      expect(exceptions.raiseQuietly).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'REFUND_MISMATCH',
          provider: 'tap',
          objectId: 're_1',
          tenantId: 't1',
          paymentId: 'pay-1',
          details: expect.objectContaining({
            source: 'refund_webhook',
            reason: 'DOES_NOT_MATCH_OUR_REFUND',
            ourRefundId: 'rf-1',
            ourAmountCents: 6000,
            reportedAmountCents: 7000,
          }),
        }),
      );
    });

    it('an external refund that would exceed the payment is raised, not booked', async () => {
      admittedSum = '50.00';

      await service.process(event());

      expect(completion.complete).not.toHaveBeenCalled();
      expect(exceptions.raiseQuietly).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            reason: 'EXTERNAL_REFUND_NOT_APPLICABLE',
            paymentStatus: 'PAID',
          }),
        }),
      );
    });

    it('a pending / failed external refund changes nothing and raises nothing (it is simply not ours)', async () => {
      await service.process(event({ outcome: 'pending' }));
      await service.process(event({ outcome: 'failed' }));
      expect(exceptions.raiseQuietly).not.toHaveBeenCalled();
    });

    it('a deduplicated redelivery raises nothing a second time', async () => {
      transactions.recordWebhookOnce.mockResolvedValue({ created: false });
      await service.process(event({ amountMinorUnits: 7000 }));
      expect(exceptions.raiseQuietly).not.toHaveBeenCalled();
    });

    it('a normal matched refund raises nothing', async () => {
      refundRepo.findOne.mockResolvedValueOnce(
        pendingRefund({ gateway_refund_id: 're_1' }),
      );
      await service.process(event());
      expect(exceptions.raiseQuietly).not.toHaveBeenCalled();
    });
  });

  describe("a charge that paid a SUBSCRIPTION invoice (the platform's own refund)", () => {
    beforeEach(() => payments.findOne.mockResolvedValue(null));

    it('is handed to the invoice refund service by its charge id, and never touches the payment ledger', async () => {
      invoiceRefunds.applyGatewayRefund.mockResolvedValue({
        matched: true,
        invoiceId: 'inv-1',
        tenantId: 't9',
      });

      const res = await service.process(event());

      expect(invoiceRefunds.applyGatewayRefund).toHaveBeenCalledWith('chg_1', {
        reference: 're_1',
        outcome: 'succeeded',
        amountMinorUnits: 6000,
      });
      expect(res).toEqual({ accepted: true, matched: true });
      expect(transactions.recordWebhookOnce).not.toHaveBeenCalled();
      expect(completion.complete).not.toHaveBeenCalled();
      expect(exceptions.raiseQuietly).not.toHaveBeenCalled();
    });

    it('an invoice refund that cannot be booked (a partial amount) is raised with the invoice and tenant', async () => {
      invoiceRefunds.applyGatewayRefund.mockResolvedValue({
        matched: true,
        anomaly: 'PARTIAL_OR_DIFFERENT_AMOUNT',
        invoiceId: 'inv-1',
        tenantId: 't9',
      });

      await service.process(event({ amountMinorUnits: 2000 }));

      expect(exceptions.raiseQuietly).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'REFUND_MISMATCH',
          objectId: 're_1',
          tenantId: 't9',
          details: expect.objectContaining({
            reason: 'PARTIAL_OR_DIFFERENT_AMOUNT',
            subscriptionInvoiceId: 'inv-1',
            reportedAmountCents: 2000,
          }),
        }),
      );
    });

    it('a charge that is not an invoice either stays unmatched', async () => {
      invoiceRefunds.applyGatewayRefund.mockResolvedValue({ matched: false });
      expect(await service.process(event())).toEqual({
        accepted: true,
        matched: false,
      });
    });

    it('is only tried when no one-off payment matched', async () => {
      payments.findOne.mockResolvedValue(owner());
      await service.process(event());
      expect(invoiceRefunds.applyGatewayRefund).not.toHaveBeenCalled();
    });
  });
});
