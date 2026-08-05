import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentService } from './payment.service';
import { Payment } from '../../entities/Payments/Payment';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { PaymentStatus } from '../../entities/enums';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { MerchantAccountService } from './merchant-account.service';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('PaymentService.create (booking payments)', () => {
  let service: PaymentService;
  let payments: MockRepository;
  let appointments: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let gateway: { name: string; createPayment: jest.Mock; verifyPayment: jest.Mock };
  let merchants: {
    assertChargeable: jest.Mock;
    splitContext: jest.Mock;
  };

  beforeEach(async () => {
    payments = createMockRepository();
    appointments = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    // Appointment lookups go through dataSource.getRepository(Appointment).
    dataSource.getRepository.mockImplementation((entity: unknown) =>
      entity === Appointment ? appointments : createMockRepository(),
    );
    gateway = {
      name: 'noop',
      createPayment: jest.fn().mockResolvedValue({
        success: true,
        gatewayPaymentId: 'gw-1',
        status: 'pending',
        redirectUrl: 'https://pay',
        raw: {},
      }),
      verifyPayment: jest.fn(),
    };
    merchants = {
      assertChargeable: jest.fn().mockResolvedValue(undefined),
      splitContext: jest.fn().mockResolvedValue(null),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentGatewayFactory, useValue: { resolve: jest.fn().mockReturnValue(gateway) } },
        { provide: TransactionService, useValue: { record: jest.fn() } },
        {
          provide: PaymentFinancialsService,
          useValue: {
            applyOnPaid: jest.fn(),
            extractFromRaw: jest.fn().mockReturnValue({}),
            platformFeeFor: jest.fn().mockReturnValue(0),
          },
        },
        { provide: MerchantAccountService, useValue: merchants },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(PaymentService);
  });

  afterEach(() => jest.clearAllMocks());

  const bookedAppointment = () => ({
    id: 'appt-1',
    total_amount: 200,
    currency: 'SAR',
    customer: { id: 'cust-1' },
  });

  it('reads the booking price from the DATABASE (client amount not needed)', async () => {
    appointments.findOne.mockResolvedValueOnce(bookedAppointment());

    const res = await service.create(TENANT, { appointmentId: 'appt-1' } as any);
    expect(res.payment.amount).toBe(200);
    expect(res.payment.currency).toBe('SAR');
    expect(gateway.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 200, currency: 'SAR' }),
    );
  });

  it('REJECTS a client amount that differs from the booking price (amount tampering)', async () => {
    appointments.findOne.mockResolvedValueOnce(bookedAppointment());
    await expect(
      service.create(TENANT, { appointmentId: 'appt-1', amount: 1 } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('REJECTS a client currency that differs from the booking currency (currency tampering)', async () => {
    appointments.findOne.mockResolvedValueOnce(bookedAppointment());
    await expect(
      service.create(TENANT, { appointmentId: 'appt-1', currency: 'USD' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('rejects a booking payment for an appointment with no payable total', async () => {
    appointments.findOne.mockResolvedValueOnce({ ...bookedAppointment(), total_amount: 0 });
    await expect(
      service.create(TENANT, { appointmentId: 'appt-1' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });

  it('rejects a second charge for an already-paid booking (409) even after a later FAILED attempt', async () => {
    appointments.findOne.mockResolvedValueOnce(bookedAppointment());
    payments.find.mockResolvedValueOnce([{ id: 'pay-1', status: PaymentStatus.PAID }]);
    await expect(
      service.create(TENANT, { appointmentId: 'appt-1' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('REUSES an in-flight PENDING attempt instead of charging again (refresh/double-click)', async () => {
    appointments.findOne.mockResolvedValueOnce(bookedAppointment());
    const pending = {
      id: 'pay-1',
      status: PaymentStatus.PENDING,
      metadata: { redirect_url: 'https://pay/active' },
    };
    payments.find.mockResolvedValueOnce([pending]);

    const res = await service.create(TENANT, { appointmentId: 'appt-1' } as any);
    expect(res.payment).toBe(pending);
    expect(res.redirectUrl).toBe('https://pay/active');
    expect(gateway.createPayment).not.toHaveBeenCalled();
    expect(payments.save).not.toHaveBeenCalled();
  });

  it('requires an explicit amount for a payment with no appointment', async () => {
    await expect(service.create(TENANT, {} as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('enforces the merchant-eligibility gate before creating anything', async () => {
    merchants.assertChargeable.mockRejectedValueOnce(
      Object.assign(new Error('not eligible'), { code: ErrorCode.UNPROCESSABLE_ENTITY }),
    );
    await expect(service.create(TENANT, { amount: 50 } as any)).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
    expect(payments.save).not.toHaveBeenCalled();
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('replays an idempotency key without touching the gateway', async () => {
    const existing = { id: 'pay-1', status: PaymentStatus.PENDING };
    payments.findOne.mockResolvedValueOnce(existing);
    const res = await service.create(TENANT, { amount: 50, idempotencyKey: 'k1' } as any);
    expect(res.payment).toBe(existing);
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('stamps the split recipient and passes a net split when the marketplace is enabled', async () => {
    merchants.splitContext.mockResolvedValueOnce({ recipientId: 'rcp_1' });
    appointments.findOne.mockResolvedValueOnce(bookedAppointment());

    const res = await service.create(TENANT, { appointmentId: 'appt-1' } as any);
    expect(res.payment.sub_merchant_id).toBe('rcp_1');
    expect(gateway.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        splits: [
          expect.objectContaining({ recipientId: 'rcp_1', amount: 200, refundable: true }),
        ],
      }),
    );
  });

  it('lost one-PENDING-per-appointment race → returns the winner, no second charge', async () => {
    appointments.findOne.mockResolvedValueOnce(bookedAppointment());
    // pre-check saw nothing (find → [] default); the unique index fires on save
    payments.save.mockRejectedValueOnce({ code: '23505' });
    const winner = { id: 'pay-2', status: PaymentStatus.PENDING, metadata: {} };
    payments.findOne.mockResolvedValueOnce(winner);

    const res = await service.create(TENANT, { appointmentId: 'appt-1' } as any);
    expect(res.payment).toBe(winner);
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  // FND-027 / AD-02 — manual (no-appointment) payments get a server-derived
  // idempotency key when the client supplies none. Companion to the real-PG
  // proof in test/payment-idempotency.e2e-spec.ts (VR-001: mocks alone are
  // never evidence for the concurrency property, only for this arithmetic).
  describe('FND-027 — server-derived idempotency key (manual payments)', () => {
    it('derives and stores a key when the client supplies none', async () => {
      await service.create(TENANT, { amount: 75, customerId: 'cust-1' } as any);

      expect(payments.save).toHaveBeenCalledWith(
        expect.objectContaining({ idempotency_key: expect.any(String) }),
      );
      const saved = payments.save.mock.calls[0][0];
      expect(saved.idempotency_key.length).toBeGreaterThan(0);
    });

    it('two DIFFERENT customers at the same amount get DIFFERENT derived keys', async () => {
      await service.create(TENANT, { amount: 75, customerId: 'cust-1' } as any);
      const keyA = payments.save.mock.calls[0][0].idempotency_key;

      await service.create(TENANT, { amount: 75, customerId: 'cust-2' } as any);
      const keyB = payments.save.mock.calls[1][0].idempotency_key;

      expect(keyA).not.toBe(keyB);
    });

    it('the SAME tenant+customer+amount within the same call derives the SAME key (the double-click case)', async () => {
      await service.create(TENANT, { amount: 75, customerId: 'cust-1' } as any);
      const keyA = payments.save.mock.calls[0][0].idempotency_key;

      await service.create(TENANT, { amount: 75, customerId: 'cust-1' } as any);
      const keyB = payments.save.mock.calls[1][0].idempotency_key;

      expect(keyA).toBe(keyB);
    });

    it('the derived key embeds the tenant id (the underlying unique index is GLOBAL, not tenant-scoped)', async () => {
      await service.create('tenant-A', { amount: 75, customerId: 'cust-1' } as any);
      const keyA = payments.save.mock.calls[0][0].idempotency_key;

      await service.create('tenant-B', { amount: 75, customerId: 'cust-1' } as any);
      const keyB = payments.save.mock.calls[1][0].idempotency_key;

      // Same customer+amount, DIFFERENT tenants — must never collide, since
      // `UQ_59dcef70bd19850783c84f840e5` on `payments.idempotency_key` is a
      // plain global unique constraint (no tenant column in it at all).
      expect(keyA).not.toBe(keyB);
    });

    it('does NOT derive a key for a booking (appointmentId) payment — that path has its own floor', async () => {
      appointments.findOne.mockResolvedValueOnce(bookedAppointment());
      await service.create(TENANT, { appointmentId: 'appt-1' } as any);

      const saved = payments.save.mock.calls[0][0];
      expect(saved.idempotency_key).toBeUndefined();
    });

    it('an explicit client-supplied key on a manual payment is honored as-is (never overridden by the derived one)', async () => {
      await service.create(TENANT, { amount: 75, customerId: 'cust-1', idempotencyKey: 'client-key-1' } as any);
      expect(payments.save).toHaveBeenCalledWith(
        expect.objectContaining({ idempotency_key: 'client-key-1' }),
      );
    });

    it('lost the derived-key race (concurrent manual double-submit) → returns the winner, no second charge', async () => {
      payments.save.mockRejectedValueOnce({ code: '23505' });
      const winner = { id: 'pay-2', status: PaymentStatus.PENDING, metadata: {} };
      payments.findOne.mockResolvedValueOnce(winner);

      const res = await service.create(TENANT, { amount: 75, customerId: 'cust-1' } as any);
      expect(res.payment).toBe(winner);
      expect(gateway.createPayment).not.toHaveBeenCalled();
    });
  });

  describe('FND-030 — raw provider decline text sanitized on read', () => {
    const RAW_TEXT = 'do_not_honor: card issuer declined txn ref=4111********1111 code=51';

    it('findOne returns a sanitized failure_reason, not the raw gateway text', async () => {
      payments.findOne.mockResolvedValueOnce({
        id: 'pay-1',
        status: PaymentStatus.FAILED,
        failure_reason: RAW_TEXT,
      });

      const result = await service.findOne(TENANT, 'pay-1');

      expect(result.failure_reason).not.toBe(RAW_TEXT);
      expect(result.failure_reason).toBe('Payment was declined by the provider.');
    });

    it('list sanitizes failure_reason across every row', async () => {
      payments.findAndCount.mockResolvedValueOnce([
        [
          { id: 'pay-1', status: PaymentStatus.FAILED, failure_reason: RAW_TEXT },
          { id: 'pay-2', status: PaymentStatus.PAID, failure_reason: undefined },
        ],
        2,
      ]);

      const result = await service.list(TENANT, { page: 1, limit: 20 } as any);

      expect(result.data[0].failure_reason).toBe('Payment was declined by the provider.');
      expect(result.data[1].failure_reason).toBeUndefined();
    });

    it('a payment with no failure_reason is unaffected', async () => {
      payments.findOne.mockResolvedValueOnce({ id: 'pay-1', status: PaymentStatus.PAID, failure_reason: undefined });
      const result = await service.findOne(TENANT, 'pay-1');
      expect(result.failure_reason).toBeUndefined();
    });
  });
});
