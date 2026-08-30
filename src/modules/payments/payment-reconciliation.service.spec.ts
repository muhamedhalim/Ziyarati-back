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
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
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
  let subscriptionProvider: { verifyCharge: jest.Mock };
  let audit: { record: jest.Mock };

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
      verifyCharge: jest.fn().mockResolvedValue({ status: 'unknown' }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

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
        {
          provide: PaymentFinancialsService,
          useValue: {
            applyOnPaid: jest.fn(),
            extractFromRaw: jest.fn().mockReturnValue({}),
          },
        },
        {
          provide: PaymentsConfig,
          useValue: new PaymentsConfig(
            createMockConfigService() as unknown as ConfigService,
          ),
        },
        { provide: EventEmitter2, useValue: emitter },
        { provide: PAYMENT_PROVIDER, useValue: subscriptionProvider },
        { provide: PlatformAdminAuditService, useValue: audit },
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
  describe('reconcileStaleSubscriptionInvoices (T084)', () => {
    const invoiceRepo = () =>
      manager.getRepository(SubscriptionInvoice) as unknown as MockRepository;

    const staleClaimedInvoice = () => ({
      id: 'inv-1',
      tenant_id: 't1',
      amount: '100.00',
      currency: 'SAR',
      status: InvoiceStatus.OPEN,
      charge_started_at: new Date(Date.now() - 60 * 60_000),
      provider_reference: undefined as string | undefined,
      failure_reason: null as string | null,
      failure_class: null as string | null,
    });

    it('settles the invoice PAID when the provider confirms it, and audits it', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'paid',
        reference: 'real-ref-1',
        capturedMinorUnits: 10000,
        capturedCurrency: 'SAR',
      });
      const locked = staleClaimedInvoice();
      invoiceRepo().findOne.mockResolvedValueOnce(locked);

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(locked.status).toBe(InvoiceStatus.PAID);
      expect(locked.provider_reference).toBe('real-ref-1');
      expect(summary.settled).toBe(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'inv-1', tenantId: 't1' }),
      );
    });

    it('leaves it claimed for manual review when the provider reports a mismatched amount (anti-tampering)', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'paid',
        capturedMinorUnits: 5000, // half the expected amount
      });
      const locked = staleClaimedInvoice();
      invoiceRepo().findOne.mockResolvedValueOnce(locked);

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(locked.status).toBe(InvoiceStatus.OPEN); // unchanged
      expect(summary.stillClaimed).toBe(1);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('releases the stale claim (no charge attempted) when the provider says failed', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'failed',
        failureReason: 'Card declined at the provider',
      });
      const locked = staleClaimedInvoice();
      invoiceRepo().findOne.mockResolvedValueOnce(locked);

      const summary = await service.reconcileStaleSubscriptionInvoices();

      expect(locked.status).toBe(InvoiceStatus.OPEN); // status untouched — RenewalService's own retry owns this
      expect(locked.charge_started_at).toBeNull(); // claim released
      expect(summary.released).toBe(1);
    });

    it('releases the stale claim on "unknown" (both bound providers today) — never guesses paid or failed', async () => {
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
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('leaves it claimed when the provider reports pending', async () => {
      invoices.find.mockResolvedValueOnce([staleClaimedInvoice()]);
      subscriptionProvider.verifyCharge.mockResolvedValueOnce({
        status: 'pending',
      });
      const locked = staleClaimedInvoice();
      invoiceRepo().findOne.mockResolvedValueOnce(locked);

      const summary = await service.reconcileStaleSubscriptionInvoices();
      expect(summary.stillClaimed).toBe(1);
    });

    it('never reconciles a terminal invoice (PAID/VOID/REFUNDED) — filtered before scanning and re-checked under lock', async () => {
      invoices.find.mockResolvedValueOnce([]);
      const summary = await service.reconcileStaleSubscriptionInvoices();
      expect(invoices.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: expect.anything() }),
        }),
      );
      expect(summary.scanned).toBe(0);
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
});
