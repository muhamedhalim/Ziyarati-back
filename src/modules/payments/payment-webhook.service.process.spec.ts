import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentWebhookService } from './payment-webhook.service';
import { Payment } from '../../entities/Payments/Payment';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, PaymentStatus } from '../../entities/enums';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { InvoiceSettlementService } from '../subscription-billing/invoice-settlement.service';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import type { GatewayWebhookEvent } from './webhooks/gateway-webhook.types';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';
import { Refund } from '../../entities/Payments/Refund';

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = '22222222-2222-4222-8222-222222222222';

/**
 * `PaymentWebhookService.process()` — the provider-NEUTRAL core every gateway
 * adapter feeds. These tests drive it with Tap-shaped neutral events directly
 * (the adapter is covered by tap-webhook.handler.spec.ts).
 */
describe('PaymentWebhookService.process (provider-neutral)', () => {
  let service: PaymentWebhookService;
  let payments: MockRepository;
  let invoices: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let transactions: { recordWebhookOnce: jest.Mock; record: jest.Mock };
  let financials: { applyOnPaid: jest.Mock };
  let audit: { record: jest.Mock };
  let emitter: { emit: jest.Mock };
  let settlement: { settleInvoicePaid: jest.Mock };

  const owner = (over: Record<string, unknown> = {}) => ({
    id: PAYMENT_ID,
    status: PaymentStatus.PENDING,
    gateway: 'tap',
    gateway_payment_id: null as string | null,
    tenant: { id: 't1' },
    customer: { id: 'cust-1' },
    appointment: { id: 'appt-1' },
    ...over,
  });
  const locked = (over: Record<string, unknown> = {}) => ({
    id: PAYMENT_ID,
    amount: 49.99,
    currency: 'SAR',
    status: PaymentStatus.PENDING,
    settlement_status: 'UNSETTLED',
    gateway_payment_id: null as string | null,
    ...over,
  });
  const paymentRepo = () =>
    manager.getRepository(Payment) as unknown as MockRepository;
  const invoiceRepo = () =>
    manager.getRepository(SubscriptionInvoice) as unknown as MockRepository;

  const event = (
    over: Partial<GatewayWebhookEvent> = {},
  ): GatewayWebhookEvent => ({
    provider: 'tap',
    gatewayPaymentId: 'chg_1',
    dedupeKey: 'tap:chg_1:CAPTURED',
    target: 'paid',
    eventLabel: 'charge.captured',
    capturedMinorUnits: 4999,
    capturedCurrency: 'SAR',
    fees: { paymentMethod: 'mada' },
    correlationId: PAYMENT_ID,
    raw: { id: 'chg_1', status: 'CAPTURED' },
    ...over,
  });

  beforeEach(async () => {
    payments = createMockRepository();
    invoices = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    transactions = {
      recordWebhookOnce: jest.fn().mockResolvedValue({ created: true }),
      record: jest.fn().mockResolvedValue(undefined),
    };
    financials = {
      applyOnPaid: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    settlement = { settleInvoicePaid: jest.fn() };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentWebhookService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        {
          provide: getRepositoryToken(SubscriptionInvoice),
          useValue: invoices,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: TransactionService, useValue: transactions },
        {
          provide: SettlementAdjustmentService,
          useValue: { recordClawbackIfSettled: jest.fn() },
        },
        { provide: PaymentFinancialsService, useValue: financials },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: EventEmitter2, useValue: emitter },
        { provide: InvoiceSettlementService, useValue: settlement },
      ],
    }).compile();
    service = moduleRef.get(PaymentWebhookService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('matched by gateway id', () => {
    it('books PAID, uses the ADAPTER-parsed fees, and logs the sanitised event', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      const payment = locked({ gateway_payment_id: 'chg_1' });
      paymentRepo().findOne.mockResolvedValueOnce(payment);

      const res = await service.process(event());

      expect(res).toMatchObject({
        accepted: true,
        matched: true,
        status: PaymentStatus.PAID,
      });
      expect(payment.status).toBe(PaymentStatus.PAID);
      expect(financials.applyOnPaid).toHaveBeenCalledWith(payment, {
        paymentMethod: 'mada',
      });
      expect(transactions.recordWebhookOnce).toHaveBeenCalledWith(
        't1',
        PAYMENT_ID,
        expect.objectContaining({
          type: 'webhook',
          status: 'charge.captured',
          gatewayTransactionId: 'tap:chg_1:CAPTURED',
          raw: { id: 'chg_1', status: 'CAPTURED' },
        }),
        manager,
      );
      expect(emitter.emit).toHaveBeenCalledTimes(1);
    });

    it('records no gateway fee when the adapter reported none', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );
      await service.process(event({ fees: undefined }));
      expect(financials.applyOnPaid).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
      );
    });

    it('does not look the payment up by correlation when the gateway id already matched', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );
      await service.process(event());
      expect(payments.findOne).toHaveBeenCalledTimes(1);
    });

    describe('FIN-P4 — the charge must belong to the merchant it was routed to', () => {
      const run = async (reported: string | undefined, routedTo = 'merchant_CLINIC') => {
        payments.findOne.mockResolvedValueOnce(owner({ gateway_payment_id: 'chg_1' }));
        const payment = locked({ gateway_payment_id: 'chg_1', sub_merchant_id: routedTo });
        paymentRepo().findOne.mockResolvedValueOnce(payment);
        await service.process(event({ merchantId: reported }));
        return payment;
      };

      it('a capture echoing a DIFFERENT merchant is not booked', async () => {
        const p = await run('merchant_OTHER');
        expect(p.status).toBe(PaymentStatus.PENDING);
        expect(financials.applyOnPaid).not.toHaveBeenCalled();
      });

      it('a capture that names no merchant (when strict checking reports one) is not booked either', async () => {
        const p = await run('');
        expect(p.status).toBe(PaymentStatus.PENDING);
      });

      it('the clinic merchant it was routed to is booked', async () => {
        const p = await run('merchant_CLINIC');
        expect(p.status).toBe(PaymentStatus.PAID);
      });

      it('with strict checking off (nothing reported) the capture is booked as before', async () => {
        const p = await run(undefined);
        expect(p.status).toBe(PaymentStatus.PAID);
      });
    });

    it('REFUSES to book PAID when the captured amount mismatches (anti-tampering)', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      const payment = locked({ gateway_payment_id: 'chg_1' });
      paymentRepo().findOne.mockResolvedValueOnce(payment);
      const res = await service.process(event({ capturedMinorUnits: 4998 }));
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(res.status).toBe(PaymentStatus.PENDING);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('REFUSES when the captured currency mismatches', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      const payment = locked({ gateway_payment_id: 'chg_1' });
      paymentRepo().findOne.mockResolvedValueOnce(payment);
      await service.process(event({ capturedCurrency: 'USD' }));
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });

    it('a duplicate delivery (same dedupe key) is a no-op', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );
      transactions.recordWebhookOnce.mockResolvedValueOnce({ created: false });
      const res = await service.process(event());
      expect(res.deduplicated).toBe(true);
      expect(paymentRepo().save).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a failed event stores the SAFE reason supplied by the adapter', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      const payment = locked({ gateway_payment_id: 'chg_1' });
      paymentRepo().findOne.mockResolvedValueOnce(payment);
      await service.process(
        event({
          target: 'failed',
          failureReason: 'Payment was declined by the card issuer',
          capturedMinorUnits: undefined,
        }),
      );
      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect((payment as any).failure_reason).toBe(
        'Payment was declined by the card issuer',
      );
    });

    it('a "pending" event changes nothing and emits nothing', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      const payment = locked({ gateway_payment_id: 'chg_1' });
      paymentRepo().findOne.mockResolvedValueOnce(payment);
      const res = await service.process(
        event({ target: 'pending', capturedMinorUnits: undefined }),
      );
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(res.status).toBe(PaymentStatus.PENDING);
      expect(paymentRepo().save).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a late "failed" never regresses an already-PAID payment', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1', status: PaymentStatus.PAID }),
      );
      const payment = locked({
        gateway_payment_id: 'chg_1',
        status: PaymentStatus.PAID,
      });
      paymentRepo().findOne.mockResolvedValueOnce(payment);
      await service.process(
        event({
          target: 'failed',
          capturedMinorUnits: undefined,
          dedupeKey: 'tap:chg_1:FAILED',
        }),
      );
      expect(payment.status).toBe(PaymentStatus.PAID);
    });
  });

  // A late / replayed "paid" event must never move a payment BACKWARDS. The old
  // guard was "not already PAID", which also matched REFUNDED and
  // PARTIALLY_REFUNDED: a late event with a fresh dedupe key flipped refunded
  // money back to PAID (and fired a second succeeded event that re-set the
  // appointment's payment status to PAID). Only PENDING and FAILED may become PAID
  // — FAILED deliberately, a late success after a failure is real money.
  describe('a late "paid" never regresses a refunded payment', () => {
    it.each([PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED])(
      'leaves a %s payment untouched, emits nothing and writes no outcome row',
      async (status) => {
        payments.findOne.mockResolvedValueOnce(
          owner({ gateway_payment_id: 'chg_1', status }),
        );
        const payment = locked({ gateway_payment_id: 'chg_1', status });
        paymentRepo().findOne.mockResolvedValueOnce(payment);

        const res = await service.process(
          event({ dedupeKey: 'tap:chg_1:CAPTURED:late' }),
        );

        expect(payment.status).toBe(status);
        expect(res.status).toBe(status);
        expect(paymentRepo().save).not.toHaveBeenCalled();
        expect(financials.applyOnPaid).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    it('a late success after a FAILED attempt IS still booked (real money, not a regression)', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1', status: PaymentStatus.FAILED }),
      );
      const payment = locked({
        gateway_payment_id: 'chg_1',
        status: PaymentStatus.FAILED,
      });
      paymentRepo().findOne.mockResolvedValueOnce(payment);

      await service.process(event());

      expect(payment.status).toBe(PaymentStatus.PAID);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('REL-002 — gateway id was never persisted; match on the id Tap echoed back', () => {
    const idLookup = () => payments.findOne.mock.calls[1][0];

    it('finds the payment by OUR id, scoped to the same provider', async () => {
      payments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner());
      paymentRepo().findOne.mockResolvedValueOnce(locked());

      await service.process(event());

      expect(payments.findOne).toHaveBeenCalledTimes(2);
      expect(idLookup().where).toEqual({ id: PAYMENT_ID, gateway: 'tap' });
    });

    it('attaches the gateway id under the row lock and books the payment', async () => {
      payments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner());
      const payment = locked();
      paymentRepo().findOne.mockResolvedValueOnce(payment);

      const res = await service.process(event());

      expect(payment.gateway_payment_id).toBe('chg_1');
      expect(payment.status).toBe(PaymentStatus.PAID);
      expect(res.matched).toBe(true);
      // attached + saved BEFORE the ledger/dedupe step
      expect(paymentRepo().save.mock.invocationCallOrder[0]).toBeLessThan(
        transactions.recordWebhookOnce.mock.invocationCallOrder[0],
      );
    });

    it('still persists the attach when the delivery is a duplicate (so the sweep can find the row)', async () => {
      payments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner());
      const payment = locked();
      paymentRepo().findOne.mockResolvedValueOnce(payment);
      transactions.recordWebhookOnce.mockResolvedValueOnce({ created: false });

      const res = await service.process(event());

      expect(res.deduplicated).toBe(true);
      expect(payment.gateway_payment_id).toBe('chg_1');
      expect(paymentRepo().save).toHaveBeenCalledWith(payment);
    });

    it('NEVER queries by a correlation id that is not a UUID (it would crash the uuid column)', async () => {
      payments.findOne.mockResolvedValueOnce(null);
      invoices.findOne.mockResolvedValue(null);
      const res = await service.process(
        event({ correlationId: "x'; DROP TABLE payments;--" }),
      );
      expect(payments.findOne).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ accepted: true, matched: false });
    });

    it('an event with no correlation id does only the gateway-id lookup', async () => {
      payments.findOne.mockResolvedValueOnce(null);
      invoices.findOne.mockResolvedValue(null);
      await service.process(event({ correlationId: undefined }));
      expect(payments.findOne).toHaveBeenCalledTimes(1);
    });

    it('does NOT claim a payment that already holds a DIFFERENT charge', async () => {
      payments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner({ gateway_payment_id: 'chg_DIFFERENT' }));
      invoices.findOne.mockResolvedValue(null);

      const res = await service.process(event());

      expect(res).toEqual({ accepted: true, matched: false });
      expect(paymentRepo().findOne).not.toHaveBeenCalled(); // never even locked it
    });

    it('RE-CHECKS under the row lock: a different charge attached after the lookup is never booked by this event', async () => {
      payments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner()); // looked unattached
      const payment = locked({ gateway_payment_id: 'chg_ATTACHED_IN_BETWEEN' }); // ...but is not, by the time we lock it
      paymentRepo().findOne.mockResolvedValueOnce(payment);

      await service.process(event());

      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(payment.gateway_payment_id).toBe('chg_ATTACHED_IN_BETWEEN'); // untouched
      expect(transactions.recordWebhookOnce).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('accepts a payment that already holds THIS charge id', async () => {
      payments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner({ gateway_payment_id: 'chg_1' }));
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );
      const res = await service.process(event());
      expect(res.matched).toBe(true);
    });

    it('an unmatched correlation (no such payment under this provider) falls through to unmatched', async () => {
      payments.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      invoices.findOne.mockResolvedValue(null);
      expect(await service.process(event())).toEqual({
        accepted: true,
        matched: false,
      });
    });

    it('the tenant always comes from OUR payment row, never from the event', async () => {
      payments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner({ tenant: { id: 'tenant-of-the-row' } }));
      paymentRepo().findOne.mockResolvedValueOnce(locked());
      await service.process({ ...event(), tenantId: 'attacker-tenant' } as any);
      expect(transactions.recordWebhookOnce.mock.calls[0][0]).toBe(
        'tenant-of-the-row',
      );
    });
  });

  describe('subscription-invoice events through the neutral core', () => {
    const ownerInvoice = () => ({
      id: INVOICE_ID,
      tenant_id: 't1',
      status: InvoiceStatus.OPEN,
    });
    const lockedInvoice = () => ({
      id: INVOICE_ID,
      tenant_id: 't1',
      amount: '49.99',
      currency: 'SAR',
      status: InvoiceStatus.OPEN,
      webhook_event_id: null as string | null,
      provider_reference: undefined as string | undefined,
      failure_reason: null as string | null,
      failure_class: null as string | null,
    });
    const invoiceEvent = (over: Partial<GatewayWebhookEvent> = {}) =>
      event({
        correlationId: undefined,
        subscriptionInvoiceId: INVOICE_ID,
        ...over,
      });

    beforeEach(() => {
      payments.findOne.mockResolvedValue(null);
    });

    it('hands a Tap PAID event to the single settle path with its figures, dedupe key and saved card', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'settled',
        invoice: { ...lockedInvoice(), status: InvoiceStatus.PAID },
      });
      const savedPaymentMethod = {
        provider: 'tap',
        customerId: 'cus_1',
        cardId: 'card_1',
        agreementId: 'payment_agreement_1',
        recurringCapable: true,
      };

      const res = await service.process(invoiceEvent({ savedPaymentMethod }));

      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(INVOICE_ID, {
        source: 'webhook',
        provider: 'tap',
        reference: 'chg_1',
        webhookEventId: 'tap:chg_1:CAPTURED',
        capturedMinorUnits: expect.any(Number),
        capturedCurrency: 'SAR',
        amountRequired: true,
        savedPaymentMethod,
      });
      expect(res).toMatchObject({
        accepted: true,
        matched: true,
        status: InvoiceStatus.PAID,
        deduplicated: false,
      });
    });

    it('passes a mismatched capture through to the settle path, which is what refuses it', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'rejected',
        reason: 'amount_mismatch',
        invoice: lockedInvoice(),
      });
      const res = await service.process(
        invoiceEvent({ capturedMinorUnits: 1 }),
      );
      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(
        INVOICE_ID,
        expect.objectContaining({ capturedMinorUnits: 1 }),
      );
      // Tap is told 200 (a retry cannot change a mismatch) and the invoice stays OPEN.
      expect(res).toMatchObject({
        accepted: true,
        matched: true,
        status: InvoiceStatus.OPEN,
      });
    });

    it('a redelivery recognised by the settle path is reported as deduplicated', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'already_paid',
        invoice: { ...lockedInvoice(), status: InvoiceStatus.PAID },
      });
      const res = await service.process(invoiceEvent());
      expect(res.deduplicated).toBe(true);
    });

    it('records the adapter-supplied safe reason on a decline', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      const invoice = lockedInvoice();
      invoiceRepo().findOne.mockResolvedValueOnce(invoice);
      await service.process(
        invoiceEvent({
          target: 'failed',
          failureReason: 'Payment was declined by the card issuer',
          capturedMinorUnits: undefined,
        }),
      );
      expect(invoice.failure_reason).toBe(
        'Payment was declined by the card issuer',
      );
      expect(invoice.status).toBe(InvoiceStatus.OPEN);
    });
  });

  // REL-005 — the durable twin of the in-process events. The row must be written
  // by the SAME transaction manager that flips the payment, so the consequences
  // commit or roll back with it.
  describe('REL-005 — durable outcome rows', () => {
    /** Every outbox row inserted through the transaction manager, in order. */
    const outboxRows = (): Array<Record<string, any>> => {
      // The refund tests make every createQueryBuilder() call return ONE shared
      // builder, so count each distinct builder once.
      const builders = new Set(
        (manager.createQueryBuilder as jest.Mock).mock.results.map(
          (r) => r.value as ReturnType<typeof createMockQueryBuilder>,
        ),
      );
      return [...builders]
        .flatMap((qb) => qb.values.mock.calls.map(([row]) => row))
        .filter((row) => row?.job_name === 'payments.outcome');
    };

    it('a PAID flip writes a payments.outcome row through the transaction manager', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );

      await service.process(event());

      expect(outboxRows()).toEqual([
        expect.objectContaining({
          queue: 'payments',
          job_name: 'payments.outcome',
          dedupe_key: `payment-outcome-paid-${PAYMENT_ID}`,
          payload: { tenantId: 't1', paymentId: PAYMENT_ID, outcome: 'paid' },
        }),
      ]);
      // never through a fresh connection — that would defeat the atomicity
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('the row is written AFTER the payment save but inside the same callback (one commit)', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );
      await service.process(event());
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(paymentRepo().save.mock.invocationCallOrder[0]).toBeLessThan(
        (manager.createQueryBuilder as jest.Mock).mock.invocationCallOrder[0],
      );
    });

    it('a FAILED flip writes a failed outcome row', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );

      await service.process(
        event({
          target: 'failed',
          dedupeKey: 'tap:chg_1:DECLINED',
          capturedMinorUnits: undefined,
        }),
      );

      expect(outboxRows()).toEqual([
        expect.objectContaining({
          dedupe_key: `payment-outcome-failed-${PAYMENT_ID}`,
          payload: { tenantId: 't1', paymentId: PAYMENT_ID, outcome: 'failed' },
        }),
      ]);
    });

    it.each([
      [
        'a captured-amount mismatch (refused, left PENDING)',
        () => event({ capturedMinorUnits: 1 }),
        {},
      ],
      [
        'a "pending" event',
        () => event({ target: 'pending', capturedMinorUnits: undefined }),
        {},
      ],
      [
        'a late "failed" for a payment that is already PAID',
        () =>
          event({
            target: 'failed',
            dedupeKey: 'tap:chg_1:FAILED',
            capturedMinorUnits: undefined,
          }),
        { status: PaymentStatus.PAID },
      ],
    ])('writes NO row for %s', async (_label, make, lockedOver) => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1', ...lockedOver }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1', ...lockedOver }),
      );
      await service.process(make());
      expect(outboxRows()).toEqual([]);
    });

    it('a duplicate delivery writes NO second row', async () => {
      payments.findOne.mockResolvedValueOnce(
        owner({ gateway_payment_id: 'chg_1' }),
      );
      paymentRepo().findOne.mockResolvedValueOnce(
        locked({ gateway_payment_id: 'chg_1' }),
      );
      transactions.recordWebhookOnce.mockResolvedValueOnce({ created: false });
      await service.process(event());
      expect(outboxRows()).toEqual([]);
    });

    describe('refund events', () => {
      const refundEvent = () =>
        event({
          target: 'refunded',
          dedupeKey: 'tap:re_1:REFUNDED',
          eventLabel: 'refund.refunded',
          refundedMinorUnits: 4999,
          capturedMinorUnits: undefined,
        });

      const withRefundSums = (baseline: string, succeeded: string) => {
        const qb = createMockQueryBuilder();
        qb.getRawOne
          .mockResolvedValueOnce({ sum: baseline })
          .mockResolvedValueOnce({ sum: succeeded });
        manager.createQueryBuilder.mockReturnValue(qb);
      };

      it('a NEW reconciled refund writes both the refunded-state row and the entitlement-reversal row', async () => {
        payments.findOne.mockResolvedValueOnce(
          owner({ gateway_payment_id: 'chg_1', status: PaymentStatus.PAID }),
        );
        paymentRepo().findOne.mockResolvedValueOnce(
          locked({ gateway_payment_id: 'chg_1', status: PaymentStatus.PAID }),
        );
        (
          manager.getRepository(Refund) as unknown as MockRepository
        ).save.mockResolvedValueOnce({ id: 'recon-1' });
        withRefundSums('0', '49.99'); // baseline 0 → succeeded total = full

        await service.process(refundEvent());

        expect(outboxRows()).toEqual([
          expect.objectContaining({
            dedupe_key: `payment-outcome-refunded-${PAYMENT_ID}-4999`,
            payload: {
              tenantId: 't1',
              paymentId: PAYMENT_ID,
              outcome: 'refunded',
            },
          }),
          expect.objectContaining({
            dedupe_key: 'payment-outcome-refund-recon-1',
            payload: {
              tenantId: 't1',
              paymentId: PAYMENT_ID,
              outcome: 'refund_recorded',
              refundId: 'recon-1',
            },
          }),
        ]);
      });

      it('a redelivery that adds no new refund writes the refunded-state row (a no-op by key) but NOT a second reversal row', async () => {
        payments.findOne.mockResolvedValueOnce(
          owner({
            gateway_payment_id: 'chg_1',
            status: PaymentStatus.REFUNDED,
          }),
        );
        paymentRepo().findOne.mockResolvedValueOnce(
          locked({
            gateway_payment_id: 'chg_1',
            status: PaymentStatus.REFUNDED,
          }),
        );
        withRefundSums('49.99', '49.99'); // ledger already matches the gateway

        await service.process(refundEvent());

        const rows = outboxRows();
        expect(rows.map((r) => r.payload.outcome)).toEqual(['refunded']);
        expect(rows.some((r) => r.payload.outcome === 'refund_recorded')).toBe(
          false,
        );
      });

      it('a de-duplicated refund delivery writes nothing', async () => {
        payments.findOne.mockResolvedValueOnce(
          owner({ gateway_payment_id: 'chg_1' }),
        );
        paymentRepo().findOne.mockResolvedValueOnce(
          locked({ gateway_payment_id: 'chg_1' }),
        );
        transactions.recordWebhookOnce.mockResolvedValueOnce({
          created: false,
        });
        await service.process(refundEvent());
        expect(outboxRows()).toEqual([]);
      });
    });
  });
});
