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
});
