import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentService } from './payment.service';
import { Payment } from '../../entities/Payments/Payment';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { PaymentStatus } from '../../entities/enums';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { MerchantAccountService } from './merchant-account.service';
import { PaymentsConfig } from './payments.config';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * Gateway-neutral seams of PaymentService.create introduced for the Tap
 * integration (Phase 1): the SERVER decides gateway + return URL, payer
 * identity is loaded only for gateways that ask, and a charge whose bookkeeping
 * failed after the gateway call (REL-002) is never reported as payable.
 */
describe('PaymentService.create — gateway seams (Tap Phase 1)', () => {
  let service: PaymentService;
  let payments: MockRepository;
  let customers: MockRepository;
  let tenants: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let resolve: jest.Mock;
  let gateway: {
    name: string;
    requiresPayerDetails?: boolean;
    createPayment: jest.Mock;
    verifyPayment: jest.Mock;
  };
  let financials: {
    applyOnPaid: jest.Mock;
    extractFromRaw: jest.Mock;
    platformFeeFor: jest.Mock;
  };

  beforeEach(async () => {
    payments = createMockRepository();
    customers = createMockRepository();
    tenants = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    dataSource.getRepository.mockImplementation((entity: unknown) =>
      entity === Customer
        ? customers
        : entity === Tenant
          ? tenants
          : createMockRepository(),
    );
    gateway = {
      name: 'tap',
      requiresPayerDetails: true,
      createPayment: jest.fn().mockResolvedValue({
        success: true,
        gatewayPaymentId: 'chg_1',
        status: 'pending',
        redirectUrl: 'https://checkout.tap/x',
        raw: {},
      }),
      verifyPayment: jest.fn(),
    };
    resolve = jest.fn().mockReturnValue(gateway);
    financials = {
      applyOnPaid: jest.fn(),
      extractFromRaw: jest.fn().mockReturnValue({ gatewayFee: 99 }),
      platformFeeFor: jest.fn().mockReturnValue(0),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentGatewayFactory, useValue: { resolve } },
        { provide: TransactionService, useValue: { record: jest.fn() } },
        { provide: PaymentFinancialsService, useValue: financials },
        {
          provide: MerchantAccountService,
          useValue: {
            assertChargeable: jest.fn().mockResolvedValue(undefined),
            splitContext: jest.fn().mockResolvedValue(null),
            routingContext: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: PaymentsConfig,
          useValue: {
            paymentReturnUrl: jest.fn((platform: boolean) =>
              platform
                ? 'https://app.test/app/billing?checkout=return'
                : 'https://app.test/pay/return',
            ),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(PaymentService);
  });

  afterEach(() => jest.clearAllMocks());

  const manual = (extra: Record<string, unknown> = {}) =>
    ({ amount: 50, currency: 'SAR', customerId: 'cust-1', ...extra }) as any;

  describe('the SERVER chooses gateway and return URL', () => {
    it('ignores a client-supplied gateway — resolve() is called with no argument', async () => {
      await service.create(TENANT, manual({ gateway: 'attacker-gateway' }));
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith();
    });

    it('never forwards a client callbackUrl; sends the server-built returnUrl instead', async () => {
      await service.create(
        TENANT,
        manual({ callbackUrl: 'https://evil.example/steal' }),
      );
      const req = gateway.createPayment.mock.calls[0][0];
      expect(req.callbackUrl).toBeUndefined();
      expect(req.returnUrl).toBe('https://app.test/pay/return');
      expect(JSON.stringify(req)).not.toContain('evil.example');
    });

    it('uses the billing return URL for platform-revenue payments', async () => {
      await service.create(TENANT, manual(), { purpose: 'ADDON' });
      expect(gateway.createPayment.mock.calls[0][0].returnUrl).toBe(
        'https://app.test/app/billing?checkout=return',
      );
    });
  });

  describe('payee (who the money is for)', () => {
    it('marks a normal payment as clinic money', async () => {
      await service.create(TENANT, manual());
      expect(gateway.createPayment.mock.calls[0][0].payee).toBe('clinic');
    });

    it('marks a platform-revenue payment as platform money', async () => {
      await service.create(TENANT, manual(), { purpose: 'BILLING_UPGRADE' });
      expect(gateway.createPayment.mock.calls[0][0].payee).toBe('platform');
    });
  });

  describe('payer identity (only for gateways that require it)', () => {
    it('loads the patient for a clinic payment and drops a WhatsApp placeholder email', async () => {
      customers.findOne.mockResolvedValueOnce({
        id: 'cust-1',
        full_name: 'Amina Hassan Ali',
        email: 'whatsapp+t1-966501234567@bot.internal',
        phone: '966501234567',
      });
      await service.create(TENANT, manual());
      const { customer } = gateway.createPayment.mock.calls[0][0];
      expect(customer).toEqual({
        firstName: 'Amina',
        lastName: 'Hassan Ali',
        email: undefined, // placeholder never reaches the gateway
        phone: { countryCode: '966', number: '501234567' },
      });
    });

    it("scopes the customer lookup to the caller's tenant (no cross-tenant read)", async () => {
      customers.findOne.mockResolvedValueOnce(null);
      await service.create(TENANT, manual());
      expect(customers.findOne).toHaveBeenCalledWith({
        where: { id: 'cust-1', tenant: { id: TENANT } },
      });
    });

    it('identifies a tenant paying the platform by its contact details', async () => {
      tenants.findOne.mockResolvedValueOnce({
        id: TENANT,
        name: 'Noor Clinic',
        legal_name: 'Noor Medical Co',
        contact_email: 'owner@noor.test',
        contact_phone: '0501234567',
      });
      await service.create(TENANT, manual({ customerId: undefined }), {
        purpose: 'ADDON',
      });
      const { customer } = gateway.createPayment.mock.calls[0][0];
      expect(customer).toMatchObject({
        firstName: 'Noor',
        lastName: 'Medical Co',
        email: 'owner@noor.test',
        phone: { countryCode: '966', number: '501234567' },
      });
      expect(customers.findOne).not.toHaveBeenCalled();
    });

    it('does NOT read the customer for a gateway that does not need payer details', async () => {
      gateway.requiresPayerDetails = false;
      await service.create(TENANT, manual());
      expect(customers.findOne).not.toHaveBeenCalled();
      expect(tenants.findOne).not.toHaveBeenCalled();
      expect(gateway.createPayment.mock.calls[0][0].customer).toBeUndefined();
    });
  });

  describe('fees come from the adapter when it reports them', () => {
    it('prefers result.fees over the legacy Moyasar-shaped parser on an immediate capture', async () => {
      gateway.createPayment.mockResolvedValueOnce({
        success: true,
        gatewayPaymentId: 'chg_2',
        status: 'paid',
        fees: { paymentMethod: 'mada' },
        raw: { fee: 1 },
      });
      await service.create(TENANT, manual());
      expect(financials.applyOnPaid).toHaveBeenCalledWith(expect.anything(), {
        paymentMethod: 'mada',
      });
      expect(financials.extractFromRaw).not.toHaveBeenCalled();
    });
  });

  describe('REL-002 — gateway call succeeded but our bookkeeping did not commit', () => {
    it('never returns a redirect URL for a payment we are not tracking, and reports PENDING', async () => {
      dataSource.transaction.mockRejectedValueOnce(
        new Error('connection reset'),
      );
      const res = await service.create(TENANT, manual());
      expect(res.redirectUrl).toBeUndefined();
      expect(res.status).toBe(PaymentStatus.PENDING);
      expect(res.payment.status).toBe(PaymentStatus.PENDING);
    });

    it('reports PENDING even when the gateway said "paid" (that outcome never committed)', async () => {
      gateway.createPayment.mockResolvedValueOnce({
        success: true,
        gatewayPaymentId: 'chg_3',
        status: 'paid',
        raw: {},
      });
      dataSource.transaction.mockRejectedValueOnce(new Error('deadlock'));
      const res = await service.create(TENANT, manual());
      expect(res.status).toBe(PaymentStatus.PENDING);
      expect(res.payment.paid_at).toBeUndefined();
    });

    it('persists the gateway id and a create_uncertain flag (without the URL) so the sweep and webhook can find it', async () => {
      dataSource.transaction.mockRejectedValueOnce(
        new Error('connection reset'),
      );
      await service.create(TENANT, manual());
      expect(payments.update).toHaveBeenCalledTimes(1);
      const [, patch] = payments.update.mock.calls[0];
      expect(patch.gateway_payment_id).toBe('chg_1');
      expect(patch.metadata).toEqual({ create_uncertain: true });
      expect(patch.metadata).not.toHaveProperty('redirect_url');
    });

    it('still flags the payment when the gateway call itself threw (no id to persist)', async () => {
      gateway.createPayment.mockRejectedValueOnce(new Error('socket hang up'));
      const res = await service.create(TENANT, manual());
      expect(res.redirectUrl).toBeUndefined();
      const [, patch] = payments.update.mock.calls[0];
      expect(patch).not.toHaveProperty('gateway_payment_id');
      expect(patch.metadata).toEqual({ create_uncertain: true });
    });

    it('a failed best-effort flag never throws out of create() (caller is already on the error path)', async () => {
      dataSource.transaction.mockRejectedValueOnce(new Error('db down'));
      payments.update.mockRejectedValueOnce(new Error('db still down'));
      await expect(service.create(TENANT, manual())).resolves.toMatchObject({
        status: PaymentStatus.PENDING,
      });
    });
  });

  describe('a definitive gateway failure', () => {
    it('is booked FAILED with the adapter\x27s user-safe reason, so staff can see why', async () => {
      gateway.createPayment.mockResolvedValueOnce({
        success: false,
        status: 'failed',
        failureReason: 'Online payment is not enabled for this clinic yet',
        failureCode: 'TAP_CLINIC_ROUTING_REQUIRED',
      });
      const res = await service.create(TENANT, manual());
      expect(res.status).toBe(PaymentStatus.FAILED);
      expect(res.payment.failure_reason).toBe(
        'Online payment is not enabled for this clinic yet',
      );
    });
  });

  describe('an "unknown" gateway result is not a failure', () => {
    it('leaves the payment PENDING and offers no redirect', async () => {
      gateway.createPayment.mockResolvedValueOnce({
        success: false,
        status: 'unknown',
        failureReason: 'Payment gateway is temporarily unavailable',
        failureCode: 'TIMEOUT',
      });
      const res = await service.create(TENANT, manual());
      expect(res.status).toBe(PaymentStatus.PENDING);
      expect(res.redirectUrl).toBeUndefined();
    });
  });
});
