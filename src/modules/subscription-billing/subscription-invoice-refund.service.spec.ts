import { SubscriptionInvoiceRefundService } from './subscription-invoice-refund.service';
import { InvoiceStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';

const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

const invoice = (over: Record<string, unknown> = {}): any => ({
  id: INVOICE_ID,
  tenant_id: TENANT,
  status: InvoiceStatus.PAID,
  amount: '99.00',
  currency: 'SAR',
  provider_reference: 'chg_paid_1',
  checkout_charge_id: 'chg_paid_1',
  refund_reference: null,
  refund_requested_at: null,
  refunded_at: null,
  refund_attempts: 0,
  refund_reason: null,
  ...over,
});

describe('SubscriptionInvoiceRefundService', () => {
  let invoices: {
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let locked: { findOne: jest.Mock; save: jest.Mock };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let provider: { refund: jest.Mock; verifyRefund?: jest.Mock };
  let audit: { record: jest.Mock };
  let service: SubscriptionInvoiceRefundService;

  /** Queries that were UPDATEs of the refund claim, by what they set. */
  const queriesMatching = (needle: string) =>
    dataSource.query.mock.calls.filter(([sql]) => String(sql).includes(needle));

  beforeEach(() => {
    invoices = {
      findOne: jest.fn().mockResolvedValue(invoice()),
      findOneOrFail: jest
        .fn()
        .mockResolvedValue(invoice({ status: InvoiceStatus.REFUNDED })),
      createQueryBuilder: jest.fn(),
    };
    locked = {
      findOne: jest.fn().mockResolvedValue(invoice()),
      save: jest.fn(async (i) => i),
    };
    dataSource = {
      // the claim UPDATE … RETURNING: [rows, count] on Postgres
      query: jest.fn().mockResolvedValue([
        [
          {
            refund_attempts: 1,
            amount: '99.00',
            currency: 'SAR',
            tenant_id: TENANT,
            provider_reference: 'chg_paid_1',
          },
        ],
        1,
      ]),
      transaction: jest.fn(async (cb: any) =>
        cb({ getRepository: () => locked }),
      ),
    };
    provider = {
      refund: jest.fn().mockResolvedValue({
        success: true,
        status: 'succeeded',
        reference: 're_1',
      }),
      verifyRefund: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new SubscriptionInvoiceRefundService(
      invoices as any,
      provider as any,
      dataSource as any,
      audit as any,
    );
  });

  describe('request — the admin asks for a refund', () => {
    it('claims, refunds the FULL invoice through the provider with the charge and attempt, marks it REFUNDED, audits both steps', async () => {
      const res = await service.request(INVOICE_ID, 'admin-1', ' duplicate ');

      expect(dataSource.query.mock.calls[0][0]).toContain(
        "status = 'PAID' AND refund_requested_at IS NULL",
      );
      expect(dataSource.query.mock.calls[0][1]).toEqual([
        INVOICE_ID,
        'duplicate',
      ]);
      expect(provider.refund).toHaveBeenCalledWith({
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amount: 99,
        currency: 'SAR',
        reason: 'duplicate',
        chargeReference: 'chg_paid_1',
        attempt: 1,
      });
      expect(locked.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: InvoiceStatus.REFUNDED,
          refund_reference: 're_1',
        }),
      );
      expect(res.status).toBe('refunded');
      expect(audit.record.mock.calls.map(([a]) => a.action)).toEqual([
        'platform_admin.subscription.refund_requested',
        'platform_admin.subscription.refunded',
      ]);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        userId: 'admin-1',
        tenantId: TENANT,
      });
    });

    it('PENDING keeps the claim, remembers the provider id, and is not a failure', async () => {
      provider.refund.mockResolvedValue({
        success: false,
        status: 'pending',
        reference: 're_2',
      });
      invoices.findOneOrFail.mockResolvedValue(
        invoice({ refund_requested_at: new Date() }),
      );

      const res = await service.request(INVOICE_ID, 'admin-1');

      expect(res.status).toBe('pending');
      expect(queriesMatching('SET refund_reference = $2')).toHaveLength(1);
      expect(locked.save).not.toHaveBeenCalled(); // not REFUNDED
      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(0); // claim kept
    });

    it('a provider that THROWS is "unknown": the claim stays, nothing is marked failed', async () => {
      provider.refund.mockRejectedValue(new Error('socket hang up'));
      invoices.findOneOrFail.mockResolvedValue(
        invoice({ refund_requested_at: new Date() }),
      );

      const res = await service.request(INVOICE_ID, 'admin-1');

      expect(res.status).toBe('pending');
      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(0);
      expect(audit.record.mock.calls.map(([a]) => a.action)).not.toContain(
        'platform_admin.subscription.refund_failed',
      );
    });

    it('a definitive decline clears the claim (so a retry is a NEW attempt), audits it, and raises a 422 without the provider text', async () => {
      provider.refund.mockResolvedValue({
        success: false,
        status: 'failed',
        failureReason: 'Refund was rejected by the payment gateway',
        failureCode: '505',
      });

      await expect(
        service.request(INVOICE_ID, 'admin-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        message: 'Refund was declined by the payment gateway',
      });

      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(1);
      expect(audit.record.mock.calls.map(([a]) => a.action)).toContain(
        'platform_admin.subscription.refund_failed',
      );
    });

    it('a provider that predates `status` (success only) maps true to refunded, false to declined', async () => {
      provider.refund.mockResolvedValue({
        success: true,
        reference: 'stub_rf_1',
      });
      expect((await service.request(INVOICE_ID, undefined)).status).toBe(
        'refunded',
      );

      dataSource.query.mockClear();
      provider.refund.mockResolvedValue({
        success: false,
        failureReason: 'not available',
      });
      await expect(
        service.request(INVOICE_ID, undefined),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    describe('when nothing could be claimed', () => {
      beforeEach(() => dataSource.query.mockResolvedValue([[], 0]));

      it('an unknown invoice is a 404', async () => {
        invoices.findOne.mockResolvedValue(null);
        await expect(service.request(INVOICE_ID, 'a')).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
        expect(provider.refund).not.toHaveBeenCalled();
      });

      it('an already REFUNDED invoice is an idempotent success', async () => {
        invoices.findOne.mockResolvedValue(
          invoice({ status: InvoiceStatus.REFUNDED }),
        );
        expect((await service.request(INVOICE_ID, 'a')).status).toBe(
          'refunded',
        );
        expect(provider.refund).not.toHaveBeenCalled();
      });

      it('a refund already IN FLIGHT is reported as pending, and no second one is started', async () => {
        invoices.findOne.mockResolvedValue(
          invoice({ refund_requested_at: new Date() }),
        );
        expect((await service.request(INVOICE_ID, 'a')).status).toBe('pending');
        expect(provider.refund).not.toHaveBeenCalled();
      });

      it('an invoice that is not PAID is a 422', async () => {
        invoices.findOne.mockResolvedValue(
          invoice({ status: InvoiceStatus.OPEN }),
        );
        await expect(service.request(INVOICE_ID, 'a')).rejects.toMatchObject({
          code: ErrorCode.UNPROCESSABLE_ENTITY,
          message: expect.stringContaining('Only a paid invoice'),
        });
      });

      it('a PAID invoice with no payment reference is a 422', async () => {
        invoices.findOne.mockResolvedValue(
          invoice({ provider_reference: null }),
        );
        await expect(service.request(INVOICE_ID, 'a')).rejects.toMatchObject({
          code: ErrorCode.UNPROCESSABLE_ENTITY,
          message: expect.stringContaining('no payment reference'),
        });
      });
    });
  });

  describe("applyGatewayRefund — the gateway's own word", () => {
    const event = (over: Record<string, unknown> = {}) => ({
      reference: 're_9',
      outcome: 'succeeded' as const,
      amountMinorUnits: 9900,
      ...over,
    });

    it('finds the invoice by the charge it was paid with (provider reference OR hosted checkout)', async () => {
      await service.applyGatewayRefund('chg_paid_1', event());
      expect(invoices.findOne).toHaveBeenCalledWith({
        where: [
          { provider_reference: 'chg_paid_1' },
          { checkout_charge_id: 'chg_paid_1' },
        ],
      });
    });

    it('a charge that paid no invoice is not matched', async () => {
      invoices.findOne.mockResolvedValue(null);
      expect(await service.applyGatewayRefund('chg_x', event())).toEqual({
        matched: false,
      });
    });

    it('a completed refund of the whole invoice — even one the platform issued from Tap — marks it REFUNDED', async () => {
      const res = await service.applyGatewayRefund('chg_paid_1', event());
      expect(res).toMatchObject({
        matched: true,
        invoiceId: INVOICE_ID,
        tenantId: TENANT,
      });
      expect(res.anomaly).toBeUndefined();
      expect(locked.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: InvoiceStatus.REFUNDED,
          refund_reference: 're_9',
        }),
      );
    });

    it('is idempotent: a redelivery for an already REFUNDED invoice changes nothing', async () => {
      invoices.findOne.mockResolvedValue(
        invoice({ status: InvoiceStatus.REFUNDED }),
      );
      const res = await service.applyGatewayRefund('chg_paid_1', event());
      expect(res.matched).toBe(true);
      expect(locked.save).not.toHaveBeenCalled();
    });

    it('a PARTIAL (or different-amount) refund cannot be represented: reported, never booked', async () => {
      const res = await service.applyGatewayRefund(
        'chg_paid_1',
        event({ amountMinorUnits: 2000 }),
      );
      expect(res).toMatchObject({
        matched: true,
        anomaly: 'PARTIAL_OR_DIFFERENT_AMOUNT',
      });
      expect(locked.save).not.toHaveBeenCalled();
    });

    it('a refund for an invoice that was never PAID is reported, never booked', async () => {
      invoices.findOne.mockResolvedValue(
        invoice({ status: InvoiceStatus.OPEN }),
      );
      const res = await service.applyGatewayRefund('chg_paid_1', event());
      expect(res.anomaly).toBe('INVOICE_NOT_PAID_OPEN');
      expect(locked.save).not.toHaveBeenCalled();
    });

    it('a FAILED refund clears the claim — but only when it is OUR refund in flight', async () => {
      invoices.findOne.mockResolvedValue(
        invoice({ refund_requested_at: new Date(), refund_reference: 're_9' }),
      );
      await service.applyGatewayRefund(
        'chg_paid_1',
        event({ outcome: 'failed', amountMinorUnits: undefined }),
      );
      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(1);

      dataSource.query.mockClear();
      // a failed refund object that is not the one we have in flight: ignored
      invoices.findOne.mockResolvedValue(
        invoice({
          refund_requested_at: new Date(),
          refund_reference: 're_OTHER',
        }),
      );
      await service.applyGatewayRefund(
        'chg_paid_1',
        event({ outcome: 'failed', amountMinorUnits: undefined }),
      );
      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(0);

      // no refund in flight at all: nothing to clear
      invoices.findOne.mockResolvedValue(invoice());
      await service.applyGatewayRefund(
        'chg_paid_1',
        event({ outcome: 'failed', amountMinorUnits: undefined }),
      );
      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(0);
    });

    it('PENDING / unknown only remembers the provider id of a refund we have in flight', async () => {
      invoices.findOne.mockResolvedValue(
        invoice({ refund_requested_at: new Date() }),
      );
      await service.applyGatewayRefund(
        'chg_paid_1',
        event({ outcome: 'pending', amountMinorUnits: undefined }),
      );
      expect(queriesMatching('SET refund_reference = $2')).toHaveLength(1);

      dataSource.query.mockClear();
      invoices.findOne.mockResolvedValue(invoice()); // no refund in flight
      await service.applyGatewayRefund(
        'chg_paid_1',
        event({ outcome: 'pending', amountMinorUnits: undefined }),
      );
      expect(queriesMatching('SET refund_reference = $2')).toHaveLength(0);
    });
  });

  describe('sweepInFlight', () => {
    const stuck = (over: Record<string, unknown> = {}) =>
      invoice({
        refund_requested_at: new Date(Date.now() - 30 * 60_000),
        refund_attempts: 3,
        ...over,
      });
    const withRows = (...rows: any[]) => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      invoices.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it('asks the provider about a refund by ITS id and books a completed one', async () => {
      withRows(stuck({ refund_reference: 're_5' }));
      provider.verifyRefund!.mockResolvedValue({
        success: true,
        status: 'succeeded',
        reference: 're_5',
        chargeReference: 'chg_paid_1',
        amountMinorUnits: 9900,
      });

      const s = await service.sweepInFlight();

      expect(provider.verifyRefund).toHaveBeenCalledWith('re_5');
      expect(s).toEqual({
        scanned: 1,
        refunded: 1,
        failed: 0,
        stillPending: 0,
      });
    });

    it('leaves it alone while the provider says pending or cannot say', async () => {
      withRows(stuck({ refund_reference: 're_5' }));
      provider.verifyRefund!.mockResolvedValue({
        success: false,
        status: 'unknown',
        reference: 're_5',
      });
      expect((await service.sweepInFlight()).stillPending).toBe(1);
      expect(locked.save).not.toHaveBeenCalled();
      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(0);
    });

    it('never books a refund object belonging to another charge or another amount', async () => {
      withRows(stuck({ refund_reference: 're_5' }));
      provider.verifyRefund!.mockResolvedValue({
        success: true,
        status: 'succeeded',
        chargeReference: 'chg_OTHER',
        amountMinorUnits: 9900,
      });
      expect((await service.sweepInFlight()).stillPending).toBe(1);

      withRows(stuck({ refund_reference: 're_5' }));
      provider.verifyRefund!.mockResolvedValue({
        success: true,
        status: 'succeeded',
        chargeReference: 'chg_paid_1',
        amountMinorUnits: 1,
      });
      expect((await service.sweepInFlight()).stillPending).toBe(1);
      expect(locked.save).not.toHaveBeenCalled();
    });

    it('a definitive decline clears the claim and is counted as failed', async () => {
      withRows(stuck({ refund_reference: 're_5' }));
      provider.verifyRefund!.mockResolvedValue({
        success: false,
        status: 'failed',
        chargeReference: 'chg_paid_1',
        amountMinorUnits: 9900,
      });
      const s = await service.sweepInFlight();
      expect(s.failed).toBe(1);
      expect(queriesMatching('refund_requested_at = NULL')).toHaveLength(1);
    });

    it('with no provider id, re-sends the SAME attempt inside the replay window', async () => {
      withRows(stuck({ refund_reference: null }));
      provider.refund.mockResolvedValue({
        success: true,
        status: 'succeeded',
        reference: 're_6',
      });

      const s = await service.sweepInFlight();

      expect(provider.refund).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: INVOICE_ID,
          attempt: 3,
          chargeReference: 'chg_paid_1',
        }),
      );
      expect(provider.verifyRefund).not.toHaveBeenCalled();
      expect(s.refunded).toBe(1);
    });

    it('past the replay window it does NOT re-send — that would be a new refund', async () => {
      withRows(
        stuck({
          refund_reference: null,
          refund_requested_at: new Date(Date.now() - 13 * 3_600_000),
        }),
      );
      const s = await service.sweepInFlight();
      expect(provider.refund).not.toHaveBeenCalled();
      expect(s.stillPending).toBe(1);
    });

    it('one invoice failing does not stop the next', async () => {
      withRows(
        stuck({ id: 'bad', refund_reference: 're_a' }),
        stuck({ refund_reference: 're_b' }),
      );
      provider
        .verifyRefund!.mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({
          success: true,
          status: 'succeeded',
          chargeReference: 'chg_paid_1',
          amountMinorUnits: 9900,
        });
      const s = await service.sweepInFlight();
      expect(s).toMatchObject({ scanned: 2, refunded: 1, stillPending: 1 });
    });
  });
});
