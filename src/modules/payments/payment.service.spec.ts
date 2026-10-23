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
import { PaymentsConfig } from './payments.config';
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
    routingContext: jest.Mock;
  };

  beforeEach(async () => {
    payments = createMockRepository();
    appointments = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    // Appointment lookups go through dataSource.getRepository(Appointment).
    dataSource.getRepository.mockImplementation((entity: unknown) =>
      entity === Appointment ? appointments : (() => {
            // FIN-006: the tenant-ownership check counts rows; default to "owned".
            const r = createMockRepository();
            r.count.mockResolvedValue(1);
            return r;
          })(),
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
      routingContext: jest.fn().mockResolvedValue(null),
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
            platformFeeFor: jest.fn().mockReturnValue(0),
          },
        },
        { provide: MerchantAccountService, useValue: merchants },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: PaymentsConfig,
          useValue: { paymentReturnUrl: jest.fn().mockReturnValue('https://app.test/pay/return') },
        },
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

  // Phase 1.5 (plan §12) — the platform purposes are a service-only option,
  // never a DTO field: `payment.controller.ts` calls `create(tenantId, dto)`
  // with exactly two arguments, so nothing over HTTP can ever reach this branch.
  // (Tap Phase 2: the `platformRevenue` boolean became `purpose`.)
  describe('platform purposes (ADDON / BILLING_UPGRADE — Phase 1.5 plan §12, Tap Phase 2)', () => {
    it('a platform purpose bypasses the marketplace entirely — no merchant gate', async () => {
      const res = await service.create(
        TENANT,
        { amount: 50 } as any,
        { purpose: 'ADDON' },
      );

      expect(merchants.assertChargeable).not.toHaveBeenCalled();
      expect(res.payment.sub_merchant_id).toBeUndefined();
    });

    it('WITHOUT a platform purpose (default), the merchant gate runs — the negative case', async () => {
      await service.create(TENANT, { amount: 50 } as any);

      expect(merchants.assertChargeable).toHaveBeenCalledWith(TENANT);
    });

    it('a platform purpose still proceeds even when the clinic\'s OWN merchant account would fail the gate', async () => {
      merchants.assertChargeable.mockRejectedValueOnce(
        Object.assign(new Error('not eligible'), { code: ErrorCode.UNPROCESSABLE_ENTITY }),
      );

      await expect(
        service.create(TENANT, { amount: 50 } as any, { purpose: 'BILLING_UPGRADE' }),
      ).resolves.toMatchObject({ status: expect.any(String) });
      expect(gateway.createPayment).toHaveBeenCalled();
    });
  });

  // Tap Phase 4 — a clinic charge settles to the CLINIC's own merchant.
  describe('clinic routing (Tap Platform, Phase 4)', () => {
    it('passes the clinic\'s merchant to the gateway for a clinic payment', async () => {
      merchants.routingContext.mockResolvedValueOnce({ settlementMerchantId: 'merchant_abc123' });
      appointments.findOne.mockResolvedValueOnce(bookedAppointment());

      await service.create(TENANT, { appointmentId: 'appt-1' } as any);

      expect(merchants.routingContext).toHaveBeenCalledWith(TENANT);
      expect(gateway.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ payee: 'clinic', settlementMerchantId: 'merchant_abc123' }),
      );
    });

    it('records WHEN the payer was handed the hosted-page URL (an ISO instant), so age is never read from the tz-less created_at', async () => {
      appointments.findOne.mockResolvedValueOnce(bookedAppointment());
      const before = Date.now();
      const res = await service.create(TENANT, { appointmentId: 'appt-1' } as any);
      const meta = res.payment.metadata as Record<string, string>;
      expect(meta.redirect_url).toBe('https://pay');
      const issued = Date.parse(meta.redirect_issued_at);
      expect(Number.isFinite(issued)).toBe(true);
      expect(issued).toBeGreaterThanOrEqual(before);
      expect(issued).toBeLessThanOrEqual(Date.now());
      expect(meta.redirect_issued_at).toBe(new Date(issued).toISOString());
    });

    it('sends NO routing when the provider does not route by merchant (null) — unchanged legacy behaviour', async () => {
      appointments.findOne.mockResolvedValueOnce(bookedAppointment());
      await service.create(TENANT, { appointmentId: 'appt-1' } as any);
      expect(gateway.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ settlementMerchantId: undefined }),
      );
    });

    it('NEVER routes a platform charge (add-on / upgrade) to a clinic merchant — and does not even look one up', async () => {
      merchants.routingContext.mockResolvedValue({ settlementMerchantId: 'merchant_abc123' });
      await service.create(TENANT, { amount: 50 } as any, { purpose: 'ADDON' });
      expect(merchants.routingContext).not.toHaveBeenCalled();
      expect(gateway.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ payee: 'platform', settlementMerchantId: undefined }),
      );
    });

    it('a clinic that fails the gate never reaches routing or the gateway', async () => {
      merchants.assertChargeable.mockRejectedValueOnce(
        Object.assign(new Error('not approved'), { code: ErrorCode.UNPROCESSABLE_ENTITY }),
      );
      appointments.findOne.mockResolvedValueOnce(bookedAppointment());
      await expect(service.create(TENANT, { appointmentId: 'appt-1' } as any)).rejects.toBeDefined();
      expect(merchants.routingContext).not.toHaveBeenCalled();
      expect(gateway.createPayment).not.toHaveBeenCalled();
    });
  });

  // Tap Phase 4 — closing an abandoned attempt so a fresh one can replace it.
  describe('supersedePending', () => {
    const locked = (over: Record<string, unknown> = {}) => ({
      id: 'pay-1',
      status: PaymentStatus.PENDING,
      amount: 200,
      gateway_payment_id: 'chg_abc12345',
      ...over,
    });

    it('moves a PENDING payment to FAILED under the row lock and writes the ledger row in the SAME transaction', async () => {
      const repo = manager.getRepository(Payment) as unknown as MockRepository;
      repo.findOne.mockResolvedValueOnce(locked());

      expect(await service.supersedePending(TENANT, 'pay-1')).toBe(true);

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'pay-1', tenant: { id: TENANT } },
        lock: { mode: 'pessimistic_write', tables: ['payments'] },
      });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentStatus.FAILED, failure_reason: 'Superseded by a new payment attempt' }),
      );
      const txns = (service as any).transactions.record as jest.Mock;
      expect(txns).toHaveBeenCalledWith(
        TENANT,
        'pay-1',
        expect.objectContaining({ status: 'failed', gatewayTransactionId: 'chg_abc12345' }),
        manager,
      );
    });

    it.each([PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED, PaymentStatus.FAILED])(
      'NEVER touches a %s payment — a captured payment is not "abandoned" (a webhook may have settled it while the caller decided)',
      async (status) => {
        const repo = manager.getRepository(Payment) as unknown as MockRepository;
        repo.findOne.mockResolvedValueOnce(locked({ status }));
        expect(await service.supersedePending(TENANT, 'pay-1')).toBe(false);
        expect(repo.save).not.toHaveBeenCalled();
      },
    );

    it('returns false for a payment that does not exist in this tenant', async () => {
      const repo = manager.getRepository(Payment) as unknown as MockRepository;
      repo.findOne.mockResolvedValueOnce(null);
      expect(await service.supersedePending(TENANT, 'nope')).toBe(false);
    });
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

  // VER-011 (REQ-PAY-042, P1) — confirm() is the "server-side status query"
  // FR-B012 requires as an authoritative source alongside the webhook. Had
  // ZERO prior test coverage (confirmed: no `confirm(` reference anywhere in
  // this file before this block). `ConfirmPaymentDto` accepts only an
  // optional `gatewayPaymentId` (a REFERENCE for client-side-created flows)
  // — never a status — so the client structurally cannot supply the
  // resulting state; every transition here is driven by
  // `gateways.resolve().verifyPayment()`, a real server-to-server call.
  describe('FIN-006 — customer / branch must belong to the tenant', () => {
    const notOwned = () => {
      const r = createMockRepository();
      r.count.mockResolvedValue(0);
      dataSource.getRepository.mockImplementation(() => r);
    };

    it('rejects a foreign-tenant customerId with 404 before anything is persisted', async () => {
      notOwned();
      await expect(
        service.create(TENANT, {
          amount: 10,
          currency: 'SAR',
          customerId: '00000000-0000-4000-8000-000000000001',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(payments.save).not.toHaveBeenCalled();
      expect(gateway.createPayment).not.toHaveBeenCalled();
    });

    it('rejects a foreign branchId with 404', async () => {
      notOwned();
      await expect(
        service.create(TENANT, {
          amount: 10,
          currency: 'SAR',
          branchId: '00000000-0000-4000-8000-000000000002',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(payments.save).not.toHaveBeenCalled();
    });
  });

  describe('confirm (VER-011 — server-side status verification, FR-B012)', () => {
    function pendingPayment(overrides: Record<string, unknown> = {}) {
      return {
        id: 'pay-1', status: PaymentStatus.PENDING, amount: 100, currency: 'SAR',
        gateway: 'tap', gateway_payment_id: 'gw-1', ...overrides,
      };
    }

    it('PENDING → PAID: books PAID only once the gateway independently verifies "paid", never from the caller\'s claim alone', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment());
      paymentRepo.save.mockImplementation(async (p: any) => p);
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });

      const result = await service.confirm(TENANT, 'pay-1', {});

      expect(gateway.verifyPayment).toHaveBeenCalledWith('gw-1');
      expect(result.status).toBe(PaymentStatus.PAID);
      expect(result.paid_at).toBeInstanceOf(Date);
    });

    it('ANTI-TAMPERING: a gateway-verified "paid" with a MISMATCHED captured amount is REJECTED (422), never booked PAID', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ amount: 100 }));
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', capturedMinorUnits: 5000, raw: {} }); // 50.00, not 100.00

      await expect(service.confirm(TENANT, 'pay-1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(paymentRepo.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: PaymentStatus.PAID }));
    });

    it('ANTI-TAMPERING: a mismatched captured CURRENCY is also rejected', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ currency: 'SAR' }));
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', capturedCurrency: 'USD', raw: {} });

      await expect(service.confirm(TENANT, 'pay-1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('FIN-008: a REAL gateway that reports no captured amount is rejected, never booked PAID', async () => {
      gateway.name = 'tap';
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment());
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });

      await expect(service.confirm(TENANT, 'pay-1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(paymentRepo.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentStatus.PAID }),
      );
    });

    it('FIN-003: a caller-supplied gatewayPaymentId is NOT linked to a payment of a real gateway', async () => {
      gateway.name = 'tap';
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ gateway_payment_id: null }));

      await expect(
        service.confirm(TENANT, 'pay-1', { gatewayPaymentId: 'chg_foreign' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(gateway.verifyPayment).not.toHaveBeenCalled();
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });

    it('FIN-003: the Noop simulator (dev/test) still accepts a caller-supplied id', async () => {
      gateway.name = 'noop';
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ gateway_payment_id: null }));
      paymentRepo.save.mockImplementation(async (p: any) => p);
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'pending', raw: {} });

      await service.confirm(TENANT, 'pay-1', { gatewayPaymentId: 'sim-1' });
      expect(gateway.verifyPayment).toHaveBeenCalledWith('sim-1');
    });

    it('PENDING → FAILED: books FAILED when the gateway verifies failure', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment());
      paymentRepo.save.mockImplementation(async (p: any) => p);
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'failed', raw: {} });

      const result = await service.confirm(TENANT, 'pay-1', {});
      expect(result.status).toBe(PaymentStatus.FAILED);
    });

    it('IDEMPOTENT: an already-PAID payment short-circuits WITHOUT calling the gateway at all', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ status: PaymentStatus.PAID }));

      const result = await service.confirm(TENANT, 'pay-1', {});

      expect(result.status).toBe(PaymentStatus.PAID);
      expect(gateway.verifyPayment).not.toHaveBeenCalled();
    });

    it('REFUSES (422) to confirm a REFUNDED payment — a terminal refund state is never reopened via this path', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ status: PaymentStatus.REFUNDED }));

      await expect(service.confirm(TENANT, 'pay-1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(gateway.verifyPayment).not.toHaveBeenCalled();
    });

    it('REFUSES (422) to confirm a PARTIALLY_REFUNDED payment for the same reason', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ status: PaymentStatus.PARTIALLY_REFUNDED }));

      await expect(service.confirm(TENANT, 'pay-1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('REFUSES (422) when there is no gateway payment id to verify at all', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ gateway_payment_id: null }));

      await expect(service.confirm(TENANT, 'pay-1', {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(gateway.verifyPayment).not.toHaveBeenCalled();
    });

    it('links a client-side-created gatewayPaymentId when the row has none yet, THEN verifies it — never trusts the client\'s status, only the reference id', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ gateway_payment_id: null }));
      paymentRepo.save.mockImplementation(async (p: any) => p);
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });

      await service.confirm(TENANT, 'pay-1', { gatewayPaymentId: 'client-supplied-gw-id' });

      expect(gateway.verifyPayment).toHaveBeenCalledWith('client-supplied-gw-id');
    });

    it('RACE GUARD: a webhook settles the payment to PAID between phase 1 and phase 3 — confirm() never regresses or double-processes it', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      // Phase 1 sees PENDING (still has a gateway id to verify)...
      paymentRepo.findOne
        .mockResolvedValueOnce(pendingPayment())
        // ...but by phase 3's re-lock, a concurrent webhook already booked it PAID.
        .mockResolvedValueOnce(pendingPayment({ status: PaymentStatus.PAID }));
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });

      const result = await service.confirm(TENANT, 'pay-1', {});

      expect(result.status).toBe(PaymentStatus.PAID);
      // Financials/paid_at must not be reapplied — the webhook path already owns that.
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });

    it('a genuinely missing payment is NOT_FOUND', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(null);
      await expect(service.confirm(TENANT, 'nonexistent', {})).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('FAILED → PAID: a previously-failed attempt that the gateway now reports as paid (e.g. a delayed capture) IS transitioned — still gated by the same amount/currency anti-tampering check, never trusted blindly', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment({ status: PaymentStatus.FAILED }));
      paymentRepo.save.mockImplementation(async (p: any) => p);
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });

      const result = await service.confirm(TENANT, 'pay-1', {});
      expect(result.status).toBe(PaymentStatus.PAID);
    });

    it('a "pending"/unresolved gateway status leaves the payment untouched (no premature transition)', async () => {
      const paymentRepo = manager.getRepository(Payment) as MockRepository;
      paymentRepo.findOne.mockResolvedValue(pendingPayment());
      paymentRepo.save.mockImplementation(async (p: any) => p);
      gateway.verifyPayment.mockResolvedValueOnce({ status: 'pending', raw: {} });

      const result = await service.confirm(TENANT, 'pay-1', {});
      expect(result.status).toBe(PaymentStatus.PENDING);
    });
  });

  // ── Tap Phase 2 — finance classification + durable outcomes ──────────────
  describe('finance classification (purpose / settlement_mode — Tap Phase 2)', () => {
    /** The row handed to `payments.create(...)` — what is persisted. */
    const created = () => payments.create.mock.calls[0][0];

    it('an appointment payment is BOOKING / INTERNAL', async () => {
      appointments.findOne.mockResolvedValueOnce(bookedAppointment());
      await service.create(TENANT, { appointmentId: 'appt-1' } as any);
      expect(created()).toMatchObject({ purpose: 'BOOKING', settlement_mode: 'INTERNAL' });
    });

    it('a payment with no appointment is MANUAL / INTERNAL — still the clinic\'s money', async () => {
      await service.create(TENANT, { amount: 50 } as any);
      expect(created()).toMatchObject({ purpose: 'MANUAL', settlement_mode: 'INTERNAL' });
    });

    it.each(['ADDON', 'BILLING_UPGRADE'] as const)(
      '%s is persisted as platform revenue: settlement_mode NONE',
      async (purpose) => {
        await service.create(TENANT, { amount: 50 } as any, { purpose });
        expect(created()).toMatchObject({ purpose, settlement_mode: 'NONE' });
      },
    );

    it('a gateway that settles straight to the clinic (Tap Platform) records a clinic payment as PROVIDER', async () => {
      (gateway as any).settlesDirectlyToPayee = true;
      appointments.findOne.mockResolvedValueOnce(bookedAppointment());
      await service.create(TENANT, { appointmentId: 'appt-1' } as any);
      expect(created()).toMatchObject({ purpose: 'BOOKING', settlement_mode: 'PROVIDER' });
    });

    it('platform revenue is NONE even on a provider-settling gateway — the clinic is the payer, nothing is owed on', async () => {
      (gateway as any).settlesDirectlyToPayee = true;
      await service.create(TENANT, { amount: 50 } as any, { purpose: 'ADDON' });
      expect(created()).toMatchObject({ purpose: 'ADDON', settlement_mode: 'NONE' });
    });

    it('a gateway that does not declare provider settlement defaults to INTERNAL (never silently PROVIDER)', async () => {
      await service.create(TENANT, { amount: 50 } as any);
      expect((gateway as any).settlesDirectlyToPayee).toBeUndefined();
      expect(created().settlement_mode).toBe('INTERNAL');
    });

    it('an explicit clinic purpose is honoured over the appointment default', async () => {
      await service.create(TENANT, { amount: 50 } as any, { purpose: 'BOOKING' });
      expect(created().purpose).toBe('BOOKING');
    });
  });

  describe('REL-005 — outcome rows written in the payment transaction', () => {
    /** Outbox rows inserted through the transaction manager. */
    const outboxRows = (): Array<Record<string, any>> =>
      (manager.createQueryBuilder as jest.Mock).mock.results
        .map((r) => r.value as { values: jest.Mock })
        .flatMap((qb) => qb.values.mock.calls.map(([row]) => row))
        .filter((row) => row?.job_name === 'payments.outcome');

    describe('create — an outcome reached at create time', () => {
      it('a synchronous capture writes a paid row, with the add-on or upgrade waiting on it', async () => {
        gateway.createPayment.mockResolvedValueOnce({
          success: true,
          gatewayPaymentId: 'gw-1',
          status: 'paid',
          raw: {},
        });
        const res = await service.create(TENANT, { amount: 50 } as any, { purpose: 'ADDON' });
        expect(res.status).toBe(PaymentStatus.PAID);
        expect(outboxRows()).toEqual([
          expect.objectContaining({
            dedupe_key: expect.stringMatching(/^payment-outcome-paid-/),
            payload: expect.objectContaining({ tenantId: TENANT, outcome: 'paid' }),
          }),
        ]);
      });

      it('a gateway that rejects the request outright writes a failed row (the purchase must not sit in payment_processing forever)', async () => {
        gateway.createPayment.mockResolvedValueOnce({
          success: false,
          status: 'failed',
          failureReason: 'Payment was declined by the card issuer',
          raw: {},
        });
        const res = await service.create(TENANT, { amount: 50 } as any, { purpose: 'ADDON' });
        expect(res.status).toBe(PaymentStatus.FAILED);
        expect(outboxRows()).toEqual([
          expect.objectContaining({
            dedupe_key: expect.stringMatching(/^payment-outcome-failed-/),
            payload: expect.objectContaining({ outcome: 'failed' }),
          }),
        ]);
      });

      it('the normal hosted-page flow (pending) writes NO row', async () => {
        await service.create(TENANT, { amount: 50 } as any);
        expect(outboxRows()).toEqual([]);
      });

      it('writes NO row when the create bookkeeping itself fails (the payment stays PENDING, create_uncertain)', async () => {
        gateway.createPayment.mockResolvedValueOnce({
          success: true,
          gatewayPaymentId: 'gw-1',
          status: 'paid',
          raw: {},
        });
        dataSource.transaction.mockRejectedValueOnce(new Error('db down'));
        const res = await service.create(TENANT, { amount: 50 } as any);
        expect(res.status).toBe(PaymentStatus.PENDING);
        expect(outboxRows()).toEqual([]);
      });
    });

    describe('confirm', () => {
      const pendingPayment = (over: Record<string, unknown> = {}) => ({
        id: 'pay-1',
        status: PaymentStatus.PENDING,
        amount: 100,
        currency: 'SAR',
        gateway: 'tap',
        gateway_payment_id: 'gw-1',
        ...over,
      });
      const paymentRepo = () => manager.getRepository(Payment) as MockRepository;

      it('PENDING → PAID writes a paid row in the SAME transaction (before the in-process event)', async () => {
        paymentRepo().findOne.mockResolvedValue(pendingPayment());
        paymentRepo().save.mockImplementation(async (p: any) => p);
        gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });

        await service.confirm(TENANT, 'pay-1', {});

        expect(outboxRows()).toEqual([
          expect.objectContaining({
            dedupe_key: 'payment-outcome-paid-pay-1',
            payload: { tenantId: TENANT, paymentId: 'pay-1', outcome: 'paid' },
          }),
        ]);
        expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
      });

      it('PENDING → FAILED now writes a failed row (confirm used to announce nothing at all)', async () => {
        paymentRepo().findOne.mockResolvedValue(pendingPayment());
        paymentRepo().save.mockImplementation(async (p: any) => p);
        gateway.verifyPayment.mockResolvedValueOnce({ status: 'failed', raw: {} });

        await service.confirm(TENANT, 'pay-1', {});

        expect(outboxRows()).toEqual([
          expect.objectContaining({
            dedupe_key: 'payment-outcome-failed-pay-1',
            payload: { tenantId: TENANT, paymentId: 'pay-1', outcome: 'failed' },
          }),
        ]);
      });

      it.each(['pending', 'unknown'] as const)(
        'a gateway that says "%s" changes nothing and writes NO row',
        async (status) => {
          paymentRepo().findOne.mockResolvedValue(pendingPayment());
          paymentRepo().save.mockImplementation(async (p: any) => p);
          gateway.verifyPayment.mockResolvedValueOnce({ status, raw: {} });

          const result = await service.confirm(TENANT, 'pay-1', {});

          expect(result.status).toBe(PaymentStatus.PENDING);
          expect(outboxRows()).toEqual([]);
        },
      );

      it('an amount mismatch is refused and writes NO row', async () => {
        paymentRepo().findOne.mockResolvedValue(pendingPayment({ amount: 100 }));
        gateway.verifyPayment.mockResolvedValueOnce({
          status: 'paid',
          capturedMinorUnits: 5000,
          raw: {},
        });
        await expect(service.confirm(TENANT, 'pay-1', {})).rejects.toBeDefined();
        expect(outboxRows()).toEqual([]);
      });

      it('an already-PAID payment short-circuits and writes NO second row', async () => {
        paymentRepo().findOne.mockResolvedValue(
          pendingPayment({ status: PaymentStatus.PAID }),
        );
        await service.confirm(TENANT, 'pay-1', {});
        expect(outboxRows()).toEqual([]);
      });

      it.each([PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED])(
        'a refund that landed between the phases (%s) is never moved back to PAID, and writes NO row',
        async (status) => {
          paymentRepo().findOne
            .mockResolvedValueOnce(pendingPayment()) // phase 1
            .mockResolvedValueOnce(pendingPayment({ status })); // phase 3 re-lock
          gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });

          const result = await service.confirm(TENANT, 'pay-1', {});

          expect(result.status).toBe(status);
          expect(paymentRepo().save).not.toHaveBeenCalled();
          expect(outboxRows()).toEqual([]);
        },
      );

      it('a webhook that settled the payment between the phases yields NO duplicate row', async () => {
        paymentRepo().findOne
          .mockResolvedValueOnce(pendingPayment()) // phase 1
          .mockResolvedValueOnce(pendingPayment({ status: PaymentStatus.PAID })); // phase 3
        gateway.verifyPayment.mockResolvedValueOnce({ status: 'paid', raw: {} });
        await service.confirm(TENANT, 'pay-1', {});
        expect(outboxRows()).toEqual([]);
      });
    });
  });

  describe('list — the clinic payments page shows the clinic\'s own money', () => {
    const whereOf = () => payments.findAndCount.mock.calls[0][0].where;

    it('defaults to BOOKING + MANUAL only, so add-on and billing-upgrade payments to the platform are not mixed in', async () => {
      payments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.list(TENANT, { page: 1, limit: 20 } as any);
      const purpose = whereOf().purpose;
      // TypeORM FindOperator("in", [...])
      expect(purpose.type).toBe('in');
      expect(purpose.value.sort()).toEqual(['BOOKING', 'MANUAL']);
    });

    it('an explicit purpose returns exactly that purpose (the add-on history is still reachable by name)', async () => {
      payments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.list(TENANT, { page: 1, limit: 20, purpose: 'ADDON' } as any);
      expect(whereOf().purpose).toBe('ADDON');
    });

    it('stays tenant-scoped', async () => {
      payments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.list(TENANT, { page: 1, limit: 20 } as any);
      expect(whereOf().tenant).toEqual({ id: TENANT });
    });

    it("feeStatus separates captured money by whether the provider's fee has been reported", async () => {
      payments.findAndCount.mockResolvedValue([[], 0]);
      await service.list(TENANT, {
        page: 1,
        limit: 20,
        feeStatus: 'PROVISIONAL',
      } as any);
      const provisional = payments.findAndCount.mock.calls.at(-1)[0].where;
      expect(provisional.fees_reconciled_at.type).toBe('isNull');
      // a fee only exists for captured money, so the filter implies it
      expect(provisional.status.value.sort()).toEqual([
        'PAID',
        'PARTIALLY_REFUNDED',
        'REFUNDED',
      ]);

      await service.list(TENANT, {
        page: 1,
        limit: 20,
        feeStatus: 'RECONCILED',
      } as any);
      const reconciled = payments.findAndCount.mock.calls.at(-1)[0].where;
      expect(reconciled.fees_reconciled_at.type).toBe('not');
      expect(reconciled.fees_reconciled_at.child.type).toBe('isNull');
    });

    it('an explicit status is kept, not widened, when a fee status is also asked for', async () => {
      payments.findAndCount.mockResolvedValue([[], 0]);
      await service.list(TENANT, {
        page: 1,
        limit: 20,
        status: 'PENDING',
        feeStatus: 'PROVISIONAL',
      } as any);
      expect(payments.findAndCount.mock.calls.at(-1)[0].where.status).toBe(
        'PENDING',
      );
    });

    it('search matches a charge id or the start of a payment id — inside the tenant, and literally', async () => {
      payments.findAndCount.mockResolvedValue([[], 0]);
      await service.list(TENANT, {
        page: 1,
        limit: 20,
        search: '  chg_1%_\\x ',
      } as any);
      const where = payments.findAndCount.mock.calls.at(-1)[0].where;
      expect(Array.isArray(where)).toBe(true);
      expect(where).toHaveLength(2);
      // every alternative is still scoped to the tenant: an OR must never widen it
      for (const w of where) expect(w.tenant).toEqual({ id: TENANT });
      // `%`, `_` and `\` are escaped, so they match themselves instead of acting as wildcards
      expect(where[0].gateway_payment_id.type).toBe('ilike');
      expect(where[0].gateway_payment_id.value).toBe('%chg\\_1\\%\\_\\\\x%');
      expect(where[1].id.type).toBe('raw');
    });

    it('a blank search is no search', async () => {
      payments.findAndCount.mockResolvedValue([[], 0]);
      await service.list(TENANT, { page: 1, limit: 20, search: '   ' } as any);
      expect(
        Array.isArray(payments.findAndCount.mock.calls.at(-1)[0].where),
      ).toBe(false);
    });

    describe('the payer', () => {
      const card = {
        id: 'cus-1',
        full_name: 'Amina Ali',
        whatsapp_name: 'amina wa',
        phone: '+966501110001',
        email: 'amina@patient.test',
      };

      it('loads the customer, so the page can name who paid', async () => {
        payments.findAndCount.mockResolvedValueOnce([[], 0]);
        await service.list(TENANT, { page: 1, limit: 20 } as any);
        expect(payments.findAndCount.mock.calls[0][0].relations).toEqual({
          customer: true,
        });
      });

      it('sends on the id and display name only — never the patient\'s phone or e-mail', async () => {
        payments.findAndCount.mockResolvedValueOnce([
          [{ id: 'pay-1', status: PaymentStatus.PAID, customer: card }],
          1,
        ]);
        const { data } = await service.list(TENANT, { page: 1, limit: 20 } as any);
        expect(data[0].customer).toEqual({ id: 'cus-1', full_name: 'Amina Ali' });
        expect(JSON.stringify(data[0])).not.toContain('+966501110001');
        expect(JSON.stringify(data[0])).not.toContain('amina@patient.test');
      });

      it('falls back to the WhatsApp name, and a payment with no customer stays without one', async () => {
        payments.findAndCount.mockResolvedValueOnce([
          [
            {
              id: 'pay-1',
              status: PaymentStatus.PAID,
              customer: { ...card, full_name: null },
            },
            { id: 'pay-2', status: PaymentStatus.PAID },
          ],
          2,
        ]);
        const { data } = await service.list(TENANT, { page: 1, limit: 20 } as any);
        expect(data[0].customer?.full_name).toBe('amina wa');
        expect(data[1].customer).toBeUndefined();
      });
    });
  });
});
