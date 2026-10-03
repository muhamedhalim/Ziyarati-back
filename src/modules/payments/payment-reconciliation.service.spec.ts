import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentReconciliationService } from './payment-reconciliation.service';
import { Payment } from '../../entities/Payments/Payment';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, PaymentStatus } from '../../entities/enums';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { PaymentsConfig } from './payments.config';
import { PaymentSucceededEvent } from '../../events/payment.events';
import { PAYMENT_PROVIDER } from '../subscription-billing/payment/payment-provider.interface';
import { InvoiceSettlementService } from '../subscription-billing/invoice-settlement.service';
import {
  createMockConfigService,
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

describe('PaymentReconciliationService (webhook-loss recovery)', () => {
  let service: PaymentReconciliationService;
  let payments: MockRepository;
  let invoices: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let gateway: { verifyPayment: jest.Mock };
  let emitter: { emit: jest.Mock };
  let subscriptionProvider: { verifyCharge: jest.Mock; name: string };
  let settlement: { settleInvoicePaid: jest.Mock };
  let financials: { applyOnPaid: jest.Mock; extractFromRaw: jest.Mock };

  const stalePending = () => ({
    id: 'pay-1',
    amount: 100,
    currency: 'SAR',
    status: PaymentStatus.PENDING,
    gateway: 'moyasar',
    gateway_payment_id: 'gw-1',
    created_at: new Date(Date.now() - 60 * 60_000),
    tenant: { id: 't1' },
    customer: { id: 'cust-1' },
    appointment: { id: 'appt-1' },
  });

  const lockedRepo = () =>
    manager.getRepository(Payment) as unknown as MockRepository;

  beforeEach(async () => {
    payments = createMockRepository();
    invoices = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    gateway = { verifyPayment: jest.fn() };
    emitter = { emit: jest.fn() };
    subscriptionProvider = {
      name: 'tap',
      verifyCharge: jest.fn().mockResolvedValue({ status: 'unknown' }),
    };
    settlement = {
      settleInvoicePaid: jest.fn().mockResolvedValue({
        outcome: 'settled',
        invoice: { id: 'inv-1', status: InvoiceStatus.PAID },
      }),
    };
    financials = {
      applyOnPaid: jest.fn(),
      extractFromRaw: jest.fn().mockReturnValue({}),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentReconciliationService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        {
          provide: getRepositoryToken(SubscriptionInvoice),
          useValue: invoices,
        },
        { provide: DataSource, useValue: dataSource },
        {
          provide: PaymentGatewayFactory,
          useValue: { resolve: jest.fn().mockReturnValue(gateway) },
        },
        { provide: TransactionService, useValue: { record: jest.fn() } },
        { provide: PaymentFinancialsService, useValue: financials },
        {
          provide: PaymentsConfig,
          useValue: new PaymentsConfig(
            createMockConfigService() as unknown as ConfigService,
          ),
        },
        { provide: EventEmitter2, useValue: emitter },
        { provide: PAYMENT_PROVIDER, useValue: subscriptionProvider },
        { provide: InvoiceSettlementService, useValue: settlement },
      ],
    }).compile();
    service = moduleRef.get(PaymentReconciliationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('recovers a missing "paid" webhook: books PAID and emits the succeeded event', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 10000,
      capturedCurrency: 'SAR',
      raw: {},
    });
    const locked = { ...stalePending() };
    lockedRepo().findOne.mockResolvedValueOnce(locked);

    const summary = await service.reconcileStalePending();
    expect(summary).toMatchObject({ scanned: 1, markedPaid: 1, mismatches: 0 });
    expect(locked.status).toBe(PaymentStatus.PAID);
    expect(emitter.emit).toHaveBeenCalledWith(
      PaymentSucceededEvent.eventName,
      expect.objectContaining({ paymentId: 'pay-1', appointmentId: 'appt-1' }),
    );
  });

  it('marks FAILED when the gateway positively reports failure', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'failed',
      failureReason: 'expired',
      raw: {},
    });
    const locked = { ...stalePending() };
    lockedRepo().findOne.mockResolvedValueOnce(locked);

    const summary = await service.reconcileStalePending();
    expect(summary.markedFailed).toBe(1);
    expect(locked.status).toBe(PaymentStatus.FAILED);
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('NEVER auto-books an amount mismatch — counts it for manual review', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 9000, // underpaid
      capturedCurrency: 'SAR',
      raw: {},
    });

    const summary = await service.reconcileStalePending();
    expect(summary.mismatches).toBe(1);
    expect(summary.markedPaid).toBe(0);
    expect(dataSource.transaction).not.toHaveBeenCalled(); // left PENDING untouched
  });

  it('NEVER auto-books a currency mismatch', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 10000,
      capturedCurrency: 'USD',
      raw: {},
    });

    const summary = await service.reconcileStalePending();
    expect(summary.mismatches).toBe(1);
    expect(summary.markedPaid).toBe(0);
  });

  it('leaves a still-pending gateway state for the next run', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'pending',
      raw: {},
    });

    const summary = await service.reconcileStalePending();
    expect(summary.stillPending).toBe(1);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  // The gateway COULD NOT SAY (outage, 5xx, 429, unmapped status). Treating that
  // as a failure would mark a possibly-captured payment FAILED, drop the
  // one-PENDING-per-appointment guard and allow a second charge.
  it('NEVER marks a payment FAILED when the gateway status is "unknown" — left pending for the next run', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: false,
      status: 'unknown',
      failureReason: 'Payment gateway is temporarily unavailable',
      raw: undefined,
    });

    const summary = await service.reconcileStalePending();

    expect(summary.stillPending).toBe(1);
    expect(summary.markedFailed).toBe(0);
    expect(summary.markedPaid).toBe(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('books PAID using the ADAPTER-parsed fees, not the legacy Moyasar-shaped parser', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 10000,
      capturedCurrency: 'SAR',
      fees: { paymentMethod: 'mada' },
      raw: { fee: 1 },
    });
    const locked = { ...stalePending() };
    lockedRepo().findOne.mockResolvedValueOnce(locked);

    await service.reconcileStalePending();

    expect(financials.applyOnPaid).toHaveBeenCalledWith(locked, {
      paymentMethod: 'mada',
    });
    expect(financials.extractFromRaw).not.toHaveBeenCalled();
  });

  it('no-ops when a webhook resolved the payment between phases (never regresses)', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 10000,
      capturedCurrency: 'SAR',
      raw: {},
    });
    lockedRepo().findOne.mockResolvedValueOnce({
      ...stalePending(),
      status: PaymentStatus.PAID,
    });

    const summary = await service.reconcileStalePending();
    expect(summary.markedPaid).toBe(0);
    expect(lockedRepo().save).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('survives a gateway error on one payment and keeps sweeping', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockRejectedValueOnce(
      new Error('gateway unreachable'),
    );
    const summary = await service.reconcileStalePending();
    expect(summary.stillPending).toBe(1);
  });

  // T084 (spec 014, US5) — the subscription-invoice half of the same sweep.
  // Tap migration: a PAID verdict goes through the ONE settle path, and a hosted
  // checkout whose webhook AND return were both missed is recovered too.
  describe('reconcileStaleSubscriptionInvoices (T084)', () => {
    const invoiceRepo = () =>
      manager.getRepository(SubscriptionInvoice) as unknown as MockRepository;

    const staleClaimedInvoice = () => ({
      id: 'inv-1',
      tenant_id: 't1',
      amount: '100.00',
      currency: 'SAR',
      status: InvoiceStatus.OPEN,
      charge_started_at: new Date(Date.now() - 60 * 60_000) as Date | null,
      checkout_charge_id: null as string | null,
      checkout_started_at: null as Date | null,
      provider_reference: undefined as string | undefined,
      failure_reason: null as string | null,
      failure_class: null as string | null,
    });
    const staleCheckoutInvoice = () => ({
      ...staleClaimedInvoice(),
      charge_started_at: null,
      checkout_charge_id: 'chg_checkout_1',
      checkout_started_at: new Date(Date.now() - 60 * 60_000) as Date | null,
    });

    it('settles through the single settle path when the provider confirms it', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'paid',
        reference: 'real-ref-1',
        capturedMinorUnits: 10000,
        capturedCurrency: 'SAR',
      });

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith('inv-1', {
        source: 'reconciliation',
        provider: 'tap',
        reference: 'real-ref-1',
        capturedMinorUnits: 10000,
        capturedCurrency: 'SAR',
        savedPaymentMethod: undefined,
      });
      expect(summary.settled).toBe(1);
    });

    it('verifies by the charge id on file — the hosted checkout, else the recorded reference', async () => {
      invoices.find.mockResolvedValueOnce([
        staleCheckoutInvoice(),
        {
          ...staleClaimedInvoice(),
          id: 'inv-2',
          provider_reference: 'chg_ref_2',
        },
      ]);
      subscriptionProvider.verifyCharge.mockResolvedValue({
        status: 'pending',
      });

      await service.reconcileStaleSubscriptionInvoices();

      expect(subscriptionProvider.verifyCharge).toHaveBeenNthCalledWith(
        1,
        'inv-1',
        'chg_checkout_1',
      );
      expect(subscriptionProvider.verifyCharge).toHaveBeenNthCalledWith(
        2,
        'inv-2',
        'chg_ref_2',
      );
    });

    it('recovers a hosted checkout whose webhook and return were both missed, saving the card', async () => {
      invoices.find.mockResolvedValueOnce([staleCheckoutInvoice()]);
      const savedPaymentMethod = {
        provider: 'tap',
        customerId: 'cus_1',
        cardId: 'card_1',
        agreementId: 'agr_1',
        recurringCapable: true,
      };
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'paid',
        reference: 'chg_checkout_1',
        capturedMinorUnits: 10000,
        capturedCurrency: 'SAR',
        savedPaymentMethod,
      });

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(settlement.settleInvoicePaid).toHaveBeenCalledWith(
        'inv-1',
        expect.objectContaining({ savedPaymentMethod }),
      );
      expect(summary.settled).toBe(1);
    });

    it('also scans OPEN invoices with a recent hosted checkout (bounded window), not only stale claims', async () => {
      invoices.find.mockResolvedValueOnce([]);
      await service.reconcileStaleSubscriptionInvoices();
      const where = (invoices.find.mock.calls[0][0] as { where: unknown[] })
        .where;
      expect(Array.isArray(where)).toBe(true);
      expect(where).toHaveLength(2);
      expect(where[1]).toEqual(
        expect.objectContaining({
          status: InvoiceStatus.OPEN,
          checkout_charge_id: expect.anything(),
          checkout_started_at: expect.anything(),
        }),
      );
    });

    it('leaves it claimed for manual review when the settle path refuses the capture (anti-tampering)', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'paid',
        capturedMinorUnits: 5000, // half the expected amount
      });
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'rejected',
        reason: 'amount_mismatch',
        invoice: staleClaimedInvoice(),
      });

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(summary.stillClaimed).toBe(1);
      expect(summary.settled).toBe(0);
    });

    it('counts an already-paid verdict as skipped, not settled', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'paid',
      });
      settlement.settleInvoicePaid.mockResolvedValueOnce({
        outcome: 'already_paid',
        invoice: staleClaimedInvoice(),
      });
      const summary = await service.reconcileStaleSubscriptionInvoices();
      expect(summary.settled).toBe(0);
      expect(summary.released).toBe(0);
      expect(summary.stillClaimed).toBe(0);
    });

    it('releases the stale claim and closes the dead hosted checkout when the provider says failed', async () => {
      invoices.find.mockResolvedValueOnce([
        { ...staleClaimedInvoice(), checkout_charge_id: 'chg_dead' },
      ]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'failed',
        failureReason: 'Card declined at the provider',
      });
      const locked = {
        ...staleClaimedInvoice(),
        checkout_charge_id: 'chg_dead',
        checkout_started_at: new Date() as Date | null,
      };
      invoiceRepo().findOne.mockResolvedValueOnce(locked);

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(locked.status).toBe(InvoiceStatus.OPEN); // status untouched — RenewalService's own retry owns this
      expect(locked.charge_started_at).toBeNull(); // claim released
      expect(locked.checkout_started_at).toBeNull(); // the hosted checkout is dead
      expect(locked.failure_reason).toBe('Card declined at the provider');
      expect(summary.released).toBe(1);
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('releases a stale merchant-initiated claim on "unknown" — never guesses paid or failed', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'unknown',
      });
      const locked = staleClaimedInvoice();
      invoiceRepo().findOne.mockResolvedValueOnce(locked);

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(locked.status).toBe(InvoiceStatus.OPEN);
      expect(locked.charge_started_at).toBeNull();
      expect(summary.released).toBe(1);
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('does NOT close a hosted checkout when the provider is merely unreachable (unknown)', async () => {
      invoices.find.mockResolvedValueOnce([staleCheckoutInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'unknown',
      });
      const locked = staleCheckoutInvoice();
      const started = locked.checkout_started_at;
      invoiceRepo().findOne.mockResolvedValueOnce(locked);

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(locked.checkout_started_at).toBe(started); // the clinic may still be paying
      expect(invoiceRepo().save).not.toHaveBeenCalled();
      expect(summary.stillClaimed).toBe(1);
      expect(summary.released).toBe(0);
    });

    it('leaves it claimed when the provider reports pending', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'pending',
      });

      const summary = await service.reconcileStaleSubscriptionInvoices();
      expect(summary.stillClaimed).toBe(1);
      expect(settlement.settleInvoicePaid).not.toHaveBeenCalled();
    });

    it('never reconciles a terminal invoice — filtered before scanning, skipped in the loop, re-checked under lock', async () => {
      invoices.find.mockResolvedValueOnce([
        { ...staleClaimedInvoice(), status: InvoiceStatus.PAID },
      ]);
      const summary = await service.reconcileStaleSubscriptionInvoices();
      expect(subscriptionProvider.verifyCharge).not.toHaveBeenCalled();
      expect(summary.scanned).toBe(1);

      // …and a row that turned terminal between the two phases is skipped under the lock.
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'failed',
      });
      invoiceRepo().findOne.mockResolvedValueOnce({
        ...staleClaimedInvoice(),
        status: InvoiceStatus.PAID,
      });
      const second = await service.reconcileStaleSubscriptionInvoices();
      expect(second.released).toBe(0);
      expect(invoiceRepo().save).not.toHaveBeenCalled();
    });

    it('survives a provider error on one invoice and keeps sweeping', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockRejectedValueOnce(
        new Error('provider unreachable'),
      );

      const summary = await service.reconcileStaleSubscriptionInvoices();
      expect(summary.stillClaimed).toBe(1);
    });
  });

  // REL-005 — the sweep that recovers a lost webhook runs in the WORKER, where the
  // in-process event reaches only the listeners that process happens to load. The
  // durable row is what guarantees the consequences either way.
  describe('REL-005 — durable outcome rows', () => {
    const outboxRows = () =>
      (manager.createQueryBuilder as jest.Mock).mock.results
        .map((r) => r.value as { values: jest.Mock })
        .flatMap((qb) => qb.values.mock.calls.map(([row]) => row))
        .filter((row) => row?.job_name === 'payments.outcome');

    it('a recovered PAID payment writes a paid row through the transaction manager', async () => {
      payments.find.mockResolvedValueOnce([stalePending()]);
      gateway.verifyPayment.mockResolvedValueOnce({
        success: true,
        status: 'paid',
        capturedMinorUnits: 10000,
        capturedCurrency: 'SAR',
        raw: {},
      });
      lockedRepo().findOne.mockResolvedValueOnce({ ...stalePending() });

      await service.reconcileStalePending();

      expect(outboxRows()).toEqual([
        expect.objectContaining({
          queue: 'payments',
          dedupe_key: 'payment-outcome-paid-pay-1',
          payload: { tenantId: 't1', paymentId: 'pay-1', outcome: 'paid' },
        }),
      ]);
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('a recovered FAILED payment writes a failed row', async () => {
      payments.find.mockResolvedValueOnce([stalePending()]);
      gateway.verifyPayment.mockResolvedValueOnce({
        success: true,
        status: 'failed',
        failureReason: 'expired',
        raw: {},
      });
      lockedRepo().findOne.mockResolvedValueOnce({ ...stalePending() });

      await service.reconcileStalePending();

      expect(outboxRows()).toEqual([
        expect.objectContaining({
          dedupe_key: 'payment-outcome-failed-pay-1',
          payload: { tenantId: 't1', paymentId: 'pay-1', outcome: 'failed' },
        }),
      ]);
    });

    it.each([
      [
        'an amount mismatch',
        { status: 'paid', capturedMinorUnits: 9000, capturedCurrency: 'SAR' },
      ],
      ['a still-pending gateway state', { status: 'pending' }],
      ['an UNKNOWN gateway state (outage)', { status: 'unknown' }],
    ])('writes NO row for %s', async (_label, verify) => {
      payments.find.mockResolvedValueOnce([stalePending()]);
      gateway.verifyPayment.mockResolvedValueOnce({
        success: true,
        raw: {},
        ...verify,
      });

      await service.reconcileStalePending();

      expect(outboxRows()).toEqual([]);
    });

    it('writes NO row when a webhook resolved the payment between the two phases', async () => {
      payments.find.mockResolvedValueOnce([stalePending()]);
      gateway.verifyPayment.mockResolvedValueOnce({
        success: true,
        status: 'paid',
        capturedMinorUnits: 10000,
        capturedCurrency: 'SAR',
        raw: {},
      });
      lockedRepo().findOne.mockResolvedValueOnce({
        ...stalePending(),
        status: PaymentStatus.PAID,
      });

      await service.reconcileStalePending();

      expect(outboxRows()).toEqual([]);
    });
  });
});
