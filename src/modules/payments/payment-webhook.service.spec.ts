import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentWebhookService } from './payment-webhook.service';
import { Payment } from '../../entities/Payments/Payment';
import { Refund } from '../../entities/Payments/Refund';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, PaymentStatus } from '../../entities/enums';
import { MoyasarWebhookVerifier } from './webhooks/moyasar-webhook.verifier';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { InvoiceSettlementService } from '../subscription-billing/invoice-settlement.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

describe('PaymentWebhookService.handleMoyasar', () => {
  let service: PaymentWebhookService;
  let payments: MockRepository;
  let invoices: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let verifier: { verify: jest.Mock };
  let transactions: { recordWebhookOnce: jest.Mock; record: jest.Mock };
  let adjustments: { recordClawbackIfSettled: jest.Mock };
  let financials: { applyOnPaid: jest.Mock; extractFromRaw: jest.Mock };
  let audit: { record: jest.Mock };
  let emitter: { emit: jest.Mock };
  let settlement: { settleInvoicePaid: jest.Mock };

  /** ZT-H02 — a fresh ISO-8601 timestamp, well inside the freshness window. */
  const freshCreatedAt = () => new Date().toISOString();

  const ownerPayment = () => ({
    id: 'pay-1',
    status: PaymentStatus.PENDING,
    tenant: { id: 't1' },
  });
  const lockedPayment = () => ({
    id: 'pay-1',
    amount: 100,
    currency: 'SAR',
    status: PaymentStatus.PENDING,
    settlement_status: 'UNSETTLED',
  });

  beforeEach(async () => {
    payments = createMockRepository();
    invoices = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    verifier = { verify: jest.fn().mockReturnValue(true) };
    transactions = {
      recordWebhookOnce: jest.fn().mockResolvedValue({ created: true }),
      record: jest.fn().mockResolvedValue(undefined),
    };
    adjustments = {
      recordClawbackIfSettled: jest.fn().mockResolvedValue(undefined),
    };
    financials = {
      applyOnPaid: jest.fn(),
      extractFromRaw: jest.fn().mockReturnValue({}),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };
    settlement = { settleInvoicePaid: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentWebhookService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        {
          provide: getRepositoryToken(SubscriptionInvoice),
          useValue: invoices,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: MoyasarWebhookVerifier, useValue: verifier },
        { provide: TransactionService, useValue: transactions },
        { provide: SettlementAdjustmentService, useValue: adjustments },
        { provide: PaymentFinancialsService, useValue: financials },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: EventEmitter2, useValue: emitter },
        { provide: InvoiceSettlementService, useValue: settlement },
      ],
    }).compile();
    service = moduleRef.get(PaymentWebhookService);
  });

  afterEach(() => jest.clearAllMocks());

  const paymentRepo = () =>
    manager.getRepository(Payment) as unknown as MockRepository;

  it('rejects a webhook with an invalid signature', async () => {
    verifier.verify.mockReturnValueOnce(false);
    await expect(
      service.handleMoyasar(
        { id: 'e1', type: 'payment_paid', data: { id: 'gw1' } } as any,
        'bad',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
  });

  it('accepts-but-ignores a webhook with no gateway payment id', async () => {
    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'x',
      created_at: freshCreatedAt(),
      data: {},
    } as any);
    expect(res).toEqual({ accepted: true, matched: false });
  });

  it('accepts-but-ignores a webhook for an unknown gateway payment', async () => {
    payments.findOne.mockResolvedValueOnce(null);
    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'x',
      created_at: freshCreatedAt(),
      data: { id: 'gw-unknown' },
    } as any);
    expect(res).toEqual({ accepted: true, matched: false });
  });

  it('deduplicates a redelivered webhook (no state change)', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    paymentRepo().findOne.mockResolvedValueOnce(lockedPayment());
    transactions.recordWebhookOnce.mockResolvedValueOnce({ created: false }); // lost the insert race

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_paid',
      created_at: freshCreatedAt(),
      data: { id: 'gw1', status: 'paid', amount: 10000, currency: 'SAR' },
    } as any);

    expect(res.deduplicated).toBe(true);
    expect(paymentRepo().save).not.toHaveBeenCalled();
  });

  it('marks a payment PAID when the captured amount and currency match', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_paid',
      created_at: freshCreatedAt(),
      data: { id: 'gw1', status: 'paid', amount: 10000, currency: 'SAR' },
    } as any);

    expect(payment.status).toBe(PaymentStatus.PAID);
    expect(res.status).toBe(PaymentStatus.PAID);
    expect(paymentRepo().save).toHaveBeenCalledWith(payment);
  });

  it('REFUSES to flip to PAID when the captured amount mismatches (anti-tampering)', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_paid',
      created_at: freshCreatedAt(),
      data: { id: 'gw1', status: 'paid', amount: 9999, currency: 'SAR' }, // wrong amount
    } as any);

    expect(payment.status).toBe(PaymentStatus.PENDING); // untouched
    expect(res.status).toBe(PaymentStatus.PENDING);
    expect(paymentRepo().save).not.toHaveBeenCalled();
  });

  it('marks a PENDING payment FAILED on a failure event', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_failed',
      created_at: freshCreatedAt(),
      data: { id: 'gw1', status: 'failed' },
    } as any);

    expect(res.status).toBe(PaymentStatus.FAILED);
  });

  it('reconciles a refund against the ledger and recomputes the payment status', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    // sumRefundsCents is called twice: baseline (SUCCEEDED+PENDING)=0, then SUCCEEDED total=10000c.
    const refundQb = createMockQueryBuilder();
    refundQb.getRawOne
      .mockResolvedValueOnce({ sum: '0' })
      .mockResolvedValueOnce({ sum: '100' }); // 100 major == 10000 cents == full
    manager.createQueryBuilder.mockReturnValue(refundQb);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_refunded',
      created_at: freshCreatedAt(),
      data: { id: 'gw1', refunded: 10000 },
    } as any);

    // A reconciling Refund row is appended for the delta and clawback is checked.
    expect(manager.getRepository(Refund).save).toHaveBeenCalled();
    expect(adjustments.recordClawbackIfSettled).toHaveBeenCalled();
    expect(res.status).toBe(PaymentStatus.REFUNDED);
  });

  // Phase 1.6 (plan §14) — RefundRecordedEvent, alongside PaymentRefundedEvent.
  describe('RefundRecordedEvent (Phase 1.6 — plan §14)', () => {
    it('emits when the webhook reconciles a genuinely NEW gateway-side refund', async () => {
      payments.findOne.mockResolvedValueOnce(ownerPayment());
      const payment = lockedPayment();
      paymentRepo().findOne.mockResolvedValueOnce(payment);
      (
        manager.getRepository(Refund) as unknown as MockRepository
      ).save.mockResolvedValueOnce({
        id: 'recon-1',
      });

      const refundQb = createMockQueryBuilder();
      refundQb.getRawOne
        .mockResolvedValueOnce({ sum: '0' }) // baseline (SUCCEEDED+PENDING)
        .mockResolvedValueOnce({ sum: '100' }); // succeeded total = 10000 cents = full
      manager.createQueryBuilder.mockReturnValue(refundQb);

      await service.handleMoyasar({
        id: 'e1',
        type: 'payment_refunded',
        created_at: freshCreatedAt(),
        data: { id: 'gw1', refunded: 10000 },
      } as any);

      expect(emitter.emit).toHaveBeenCalledWith(
        'refund.recorded',
        expect.objectContaining({
          tenantId: 't1',
          paymentId: 'pay-1',
          refundId: 'recon-1',
          refundedCumulativeMinor: 10000,
          paymentTotalMinor: 10000,
        }),
      );
    });

    it('does NOT emit on a redelivery where the gateway total already matches the ledger (no new refund created)', async () => {
      payments.findOne.mockResolvedValueOnce(ownerPayment());
      paymentRepo().findOne.mockResolvedValueOnce({
        ...lockedPayment(),
        status: PaymentStatus.REFUNDED,
      });

      const refundQb = createMockQueryBuilder();
      refundQb.getRawOne
        .mockResolvedValueOnce({ sum: '100' }) // baseline already full
        .mockResolvedValueOnce({ sum: '100' });
      manager.createQueryBuilder.mockReturnValue(refundQb);

      await service.handleMoyasar({
        id: 'e1',
        type: 'payment_refunded',
        created_at: freshCreatedAt(),
        data: { id: 'gw1', refunded: 10000 },
      } as any);

      expect(emitter.emit).not.toHaveBeenCalledWith(
        'refund.recorded',
        expect.anything(),
      );
    });

    it('does NOT emit for a de-duplicated (replayed) webhook event', async () => {
      transactions.recordWebhookOnce.mockResolvedValueOnce({ created: false });
      payments.findOne.mockResolvedValueOnce(ownerPayment());
      paymentRepo().findOne.mockResolvedValueOnce(lockedPayment());

      const res = await service.handleMoyasar({
        id: 'e1',
        type: 'payment_refunded',
        created_at: freshCreatedAt(),
        data: { id: 'gw1', refunded: 10000 },
      } as any);

      expect(res.deduplicated).toBe(true);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  it('does not append a refund when the gateway total already matches the ledger (no delta)', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    paymentRepo().findOne.mockResolvedValueOnce({
      ...lockedPayment(),
      status: PaymentStatus.REFUNDED,
    });

    const refundQb = createMockQueryBuilder();
    refundQb.getRawOne
      .mockResolvedValueOnce({ sum: '100' }) // baseline already 10000c
      .mockResolvedValueOnce({ sum: '100' }); // succeeded 10000c
    manager.createQueryBuilder.mockReturnValue(refundQb);

    await service.handleMoyasar({
      id: 'e1',
      type: 'payment_refunded',
      created_at: freshCreatedAt(),
      data: { id: 'gw1', refunded: 10000 },
    } as any);

    expect(manager.getRepository(Refund).save).not.toHaveBeenCalled();
    expect(adjustments.recordClawbackIfSettled).not.toHaveBeenCalled();
  });

  it('logs the raw event (no dedup) when the webhook carries no event id', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      type: 'payment_paid',
      created_at: freshCreatedAt(),
      data: { id: 'gw1', status: 'paid', amount: 10000, currency: 'SAR' },
    } as any);

    expect(transactions.record).toHaveBeenCalled();
    expect(transactions.recordWebhookOnce).not.toHaveBeenCalled();
    expect(res.status).toBe(PaymentStatus.PAID);
  });

  // T083 (spec 014, US5) — the subscription-invoice half of this same
  // webhook stream, reached only when no one-time Payment matches. A PAID event
  // is handed to the ONE settle path (Tap migration, Phase 3); a failed event
  // stays evidence-only here.
  describe('subscription invoice events (T083)', () => {
    const invoiceRepo = () =>
      manager.getRepository(SubscriptionInvoice) as unknown as MockRepository;

    const ownerInvoice = () => ({
      id: 'inv-1',
      tenant_id: 't1',
      status: InvoiceStatus.OPEN,
    });
    const lockedInvoice = () => ({
      id: 'inv-1',
      tenant_id: 't1',
      amount: '100.00',
      currency: 'SAR',
      status: InvoiceStatus.OPEN,
      webhook_event_id: null as string | null,
      provider_reference: undefined as string | undefined,
      checkout_charge_id: null as string | null,
      checkout_started_at: null as Date | null,
      failure_reason: null as string | null,
      failure_class: null as string | null,
      retry_count: 0,
      next_retry_at: null as Date | null,
    });

    const paidEvent = (overrides: Record<string, unknown> = {}) =>
      ({
        id: 'e1',
        type: 'payment_paid',
        created_at: freshCreatedAt(),
        data: {
          id: 'gw-sub-1',
          status: 'paid',
          amount: 10000,
          currency: 'SAR',
          metadata: { subscriptionInvoiceId: 'inv-1' },
          ...overrides,
        },
      }) as any;

    beforeEach(() => {
      // No one-time Payment ever matches these events.
      payments.findOne.mockResolvedValue(null);
    });

    it('correlates via the metadata BillingService.payInvoice attaches, not just provider_reference', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'settled',
        invoice: { ...lockedInvoice(), status: InvoiceStatus.PAID },
      });

      await service.handleMoyasar(paidEvent());

      expect(invoices.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv-1' } }),
      );
    });

    it('hands a PAID event to the single settle path with the captured figures and its dedupe key', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'settled',
        invoice: { ...lockedInvoice(), status: InvoiceStatus.PAID },
      });

      const res = await service.handleMoyasar(paidEvent());

      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(
        'inv-1',
        expect.objectContaining({
          source: 'webhook',
          provider: 'moyasar',
          reference: 'gw-sub-1',
          webhookEventId: 'e1',
          capturedMinorUnits: 10000,
          capturedCurrency: 'SAR',
        }),
      );
      expect(res).toEqual(
        expect.objectContaining({
          accepted: true,
          matched: true,
          status: InvoiceStatus.PAID,
          deduplicated: false,
        }),
      );
    });

    it('reports an already-paid / rejected settle outcome as deduplicated (retrying cannot change it) and never throws', async () => {
      for (const outcome of ['already_paid', 'rejected']) {
        invoices.findOne.mockResolvedValueOnce(ownerInvoice());
        settlement.settleInvoicePaid.mockResolvedValueOnce({
          outcome,
          invoice: { ...lockedInvoice(), status: InvoiceStatus.OPEN },
        });
        const res = await service.handleMoyasar(paidEvent());
        expect(res.deduplicated).toBe(true);
      }
    });

    it('lets a transient settle failure propagate so the gateway retries the webhook', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      settlement.settleInvoicePaid.mockRejectedValueOnce(new Error('db down'));

      await expect(service.handleMoyasar(paidEvent())).rejects.toThrow(
        'db down',
      );
    });

    it("records a decline without touching retry_count/next_retry_at — that stays RenewalService's own schedule", async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      const invoice = {
        ...lockedInvoice(),
        retry_count: 1,
        next_retry_at: new Date('2026-09-01'),
      };
      invoiceRepo().findOne.mockResolvedValueOnce(invoice);

      await service.handleMoyasar({
        id: 'e1',
        type: 'payment_failed',
        created_at: freshCreatedAt(),
        data: {
          id: 'gw-sub-1',
          status: 'failed',
          metadata: { subscriptionInvoiceId: 'inv-1' },
        },
      } as any);

      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
      expect(invoice.status).toBe(InvoiceStatus.OPEN); // unchanged — decline doesn't move status
      expect(invoice.failure_reason).toBeTruthy();
      expect(invoice.retry_count).toBe(1); // untouched
      expect(invoice.next_retry_at).toEqual(new Date('2026-09-01')); // untouched
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_DECLINED,
        }),
      );
    });

    it("a failed event on the invoice's own hosted checkout frees it for a new one at once", async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      const invoice = {
        ...lockedInvoice(),
        checkout_charge_id: 'gw-sub-1',
        checkout_started_at: new Date(),
      };
      invoiceRepo().findOne.mockResolvedValueOnce(invoice);

      await service.handleMoyasar({
        id: 'e1',
        type: 'payment_failed',
        created_at: freshCreatedAt(),
        data: {
          id: 'gw-sub-1',
          status: 'failed',
          metadata: { subscriptionInvoiceId: 'inv-1' },
        },
      } as any);

      expect(invoice.checkout_started_at).toBeNull();
    });

    it('a failed event for a DIFFERENT charge leaves the open checkout alone', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      const started = new Date();
      const invoice = {
        ...lockedInvoice(),
        checkout_charge_id: 'some-other-charge',
        checkout_started_at: started,
      };
      invoiceRepo().findOne.mockResolvedValueOnce(invoice);

      await service.handleMoyasar({
        id: 'e1',
        type: 'payment_failed',
        created_at: freshCreatedAt(),
        data: {
          id: 'gw-sub-1',
          status: 'failed',
          metadata: { subscriptionInvoiceId: 'inv-1' },
        },
      } as any);

      expect(invoice.checkout_started_at).toBe(started);
    });

    it('never moves a terminal invoice backward — a late "failed" after PAID is a no-op dedup', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      const invoice = { ...lockedInvoice(), status: InvoiceStatus.PAID };
      invoiceRepo().findOne.mockResolvedValueOnce(invoice);

      const res = await service.handleMoyasar({
        id: 'e1',
        type: 'payment_failed',
        created_at: freshCreatedAt(),
        data: {
          id: 'gw-sub-1',
          status: 'failed',
          metadata: { subscriptionInvoiceId: 'inv-1' },
        },
      } as any);

      expect(invoice.status).toBe(InvoiceStatus.PAID); // never regresses
      expect(res.deduplicated).toBe(true);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('deduplicates a redelivered FAILED subscription webhook (same event id)', async () => {
      invoices.findOne.mockResolvedValueOnce(ownerInvoice());
      const invoice = { ...lockedInvoice(), webhook_event_id: 'e1' };
      invoiceRepo().findOne.mockResolvedValueOnce(invoice);

      const res = await service.handleMoyasar({
        id: 'e1',
        type: 'payment_failed',
        created_at: freshCreatedAt(),
        data: {
          id: 'gw-sub-1',
          status: 'failed',
          metadata: { subscriptionInvoiceId: 'inv-1' },
        },
      } as any);

      expect(res.deduplicated).toBe(true);
      expect(invoiceRepo().save).not.toHaveBeenCalled();
    });

    it('falls through to the unmatched-event outcome when neither a Payment nor an invoice correlates', async () => {
      invoices.findOne.mockResolvedValueOnce(null);

      const res = await service.handleMoyasar({
        id: 'e1',
        type: 'payment_paid',
        created_at: freshCreatedAt(),
        data: { id: 'gw-totally-unknown', status: 'paid' },
      } as any);

      expect(res).toEqual({ accepted: true, matched: false });
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });
  });
});
