import { UnrecoverableError } from 'bullmq';

import { PaymentOutcomeService } from './payment-outcome.service';
import { Payment } from '../entities/Payments/Payment';
import { PaymentStatus } from '../entities/enums';
import { PaymentsOutcomeJob } from '../queue/job-data.interface';
import {
  createMockDataSource,
  createMockRepository,
  type MockDataSource,
  type MockRepository,
} from '../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const PAYMENT_ID = 'pay-1';
const APPOINTMENT = 'appt-1';

type PaymentShape = Partial<Payment> & {
  status: PaymentStatus;
  purpose: string;
};

describe('PaymentOutcomeService (REL-005)', () => {
  let service: PaymentOutcomeService;
  let payments: MockRepository;
  let dataSource: MockDataSource;
  let appointments: { applyPaymentOutcome: jest.Mock };
  let paymentLinks: { markUsedForAppointment: jest.Mock };
  let billing: { applyPaid: jest.Mock; applyFailed: jest.Mock };
  let resources: {
    applyPaid: jest.Mock;
    applyFailed: jest.Mock;
    applyRefund: jest.Mock;
  };
  let exceptions: { checkDuplicateBookingCapture: jest.Mock; raiseQuietly?: jest.Mock };

  const withPayment = (over: Partial<PaymentShape> = {}) => {
    payments.findOne.mockResolvedValueOnce({
      id: PAYMENT_ID,
      tenant: { id: TENANT },
      appointment: { id: APPOINTMENT },
      status: PaymentStatus.PAID,
      purpose: 'BOOKING',
      ...over,
    });
  };

  const job = (over: Partial<PaymentsOutcomeJob> = {}): PaymentsOutcomeJob => ({
    tenantId: TENANT,
    paymentId: PAYMENT_ID,
    outcome: 'paid',
    ...over,
  });

  beforeEach(() => {
    payments = createMockRepository();
    dataSource = createMockDataSource();
    dataSource.getRepository.mockImplementation((entity: unknown) =>
      entity === Payment ? payments : createMockRepository(),
    );
    appointments = {
      applyPaymentOutcome: jest.fn().mockResolvedValue(undefined),
    };
    paymentLinks = { markUsedForAppointment: jest.fn().mockResolvedValue(1) };
    billing = {
      applyPaid: jest.fn().mockResolvedValue(undefined),
      applyFailed: jest.fn().mockResolvedValue(undefined),
    };
    resources = {
      applyPaid: jest.fn().mockResolvedValue(undefined),
      applyFailed: jest.fn().mockResolvedValue(undefined),
      applyRefund: jest.fn().mockResolvedValue(undefined),
    };
    exceptions = {
      checkDuplicateBookingCapture: jest.fn().mockResolvedValue(0),
    };
    service = new PaymentOutcomeService(
      dataSource as never,
      appointments as never,
      billing as never,
      resources as never,
      paymentLinks as never,
      exceptions as never,
    );
  });

  describe('trust', () => {
    it('skips (does not retry) a payment that does not exist', async () => {
      payments.findOne.mockResolvedValueOnce(null);
      await expect(service.process(job())).resolves.toEqual({
        applied: false,
        reason: 'payment_not_found',
      });
      expect(appointments.applyPaymentOutcome).not.toHaveBeenCalled();
    });

    it('skips a payment that belongs to a DIFFERENT tenant than the payload claims', async () => {
      withPayment({ tenant: { id: 'someone-else' } as never });
      const res = await service.process(job());
      expect(res).toEqual({ applied: false, reason: 'payment_not_found' });
      expect(appointments.applyPaymentOutcome).not.toHaveBeenCalled();
      expect(resources.applyPaid).not.toHaveBeenCalled();
      expect(billing.applyPaid).not.toHaveBeenCalled();
    });

    it('rejects an unknown outcome permanently', async () => {
      withPayment();
      await expect(
        service.process(job({ outcome: 'mystery' as never })),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });

  describe('paid — routed by purpose', () => {
    it('BOOKING → confirms the appointment, and touches no entitlement', async () => {
      withPayment({ purpose: 'BOOKING' });
      const res = await service.process(job());
      expect(appointments.applyPaymentOutcome).toHaveBeenCalledWith(
        TENANT,
        APPOINTMENT,
        'paid',
      );
      expect(resources.applyPaid).not.toHaveBeenCalled();
      expect(billing.applyPaid).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        applied: true,
        consumers: ['appointment', 'payment-link'],
      });
    });

    it('D-2: a payment that lands on an already-CANCELLED booking raises a reconciliation exception and does NOT spend the link or count as applied', async () => {
      withPayment({
        purpose: 'BOOKING',
        gateway: 'tap',
        gateway_payment_id: 'chg_late',
        amount: 250,
        currency: 'SAR',
      } as never);
      appointments.applyPaymentOutcome.mockResolvedValueOnce('booking_closed');
      exceptions.raiseQuietly = jest.fn().mockResolvedValue(undefined);

      const res = await service.process(job());

      expect(exceptions.raiseQuietly).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'STATUS_MISMATCH',
          provider: 'tap',
          objectId: 'chg_late',
          tenantId: TENANT,
          paymentId: PAYMENT_ID,
          details: expect.objectContaining({
            reason: 'paid_on_cancelled_booking',
            appointmentId: APPOINTMENT,
          }),
        }),
      );
      expect(paymentLinks.markUsedForAppointment).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        consumers: ['reconciliation-exception'],
      });
    });

    it('BOOKING → also spends the booking’s pay link (tenant-scoped), so re-opening it says "already paid"', async () => {
      withPayment({ purpose: 'BOOKING' });
      await service.process(job());
      expect(paymentLinks.markUsedForAppointment).toHaveBeenCalledWith(
        TENANT,
        APPOINTMENT,
      );
    });

    it('does NOT touch a pay link for add-on / billing-upgrade payments, or when nothing was captured', async () => {
      withPayment({ purpose: 'ADDON' });
      await service.process(job());
      withPayment({ purpose: 'BILLING_UPGRADE' });
      await service.process(job());
      withPayment({ purpose: 'BOOKING', status: PaymentStatus.PENDING });
      await service.process(job());
      expect(paymentLinks.markUsedForAppointment).not.toHaveBeenCalled();
    });

    it('a pay-link failure fails the job (so BullMQ retries) — the booking is already confirmed, the retry is a cheap no-op', async () => {
      withPayment({ purpose: 'BOOKING' });
      paymentLinks.markUsedForAppointment.mockRejectedValueOnce(
        new Error('db down'),
      );
      await expect(service.process(job())).rejects.toThrow('db down');
    });

    it('MANUAL with an appointment is treated like a booking; without one it is a no-op', async () => {
      withPayment({ purpose: 'MANUAL', appointment: undefined });
      const res = await service.process(job());
      expect(appointments.applyPaymentOutcome).not.toHaveBeenCalled();
      expect(res).toMatchObject({ applied: true, consumers: [] });
    });

    it('ADDON → grants the purchase only', async () => {
      withPayment({ purpose: 'ADDON', appointment: undefined });
      const res = await service.process(job());
      expect(resources.applyPaid).toHaveBeenCalledWith(PAYMENT_ID);
      expect(billing.applyPaid).not.toHaveBeenCalled();
      expect(appointments.applyPaymentOutcome).not.toHaveBeenCalled();
      expect(res).toMatchObject({ consumers: ['resource-entitlement'] });
    });

    it('BILLING_UPGRADE → applies the upgrade only', async () => {
      withPayment({ purpose: 'BILLING_UPGRADE', appointment: undefined });
      const res = await service.process(job());
      expect(billing.applyPaid).toHaveBeenCalledWith(PAYMENT_ID);
      expect(resources.applyPaid).not.toHaveBeenCalled();
      expect(res).toMatchObject({ consumers: ['billing-upgrade-entitlement'] });
    });

    it.each([PaymentStatus.PENDING, PaymentStatus.FAILED])(
      'does nothing for a payment that is %s — a paid job never books a row that is not captured',
      async (status) => {
        withPayment({ status, purpose: 'ADDON' });
        const res = await service.process(job());
        expect(resources.applyPaid).not.toHaveBeenCalled();
        expect(res).toMatchObject({ applied: true, consumers: [] });
      },
    );

    it('replays history in order when a refund already landed before the paid job ran', async () => {
      withPayment({ status: PaymentStatus.PARTIALLY_REFUNDED });
      await service.process(job());
      expect(
        appointments.applyPaymentOutcome.mock.calls.map((c) => c[2]),
      ).toEqual(['paid', 'partially_refunded']);
    });

    it('a fully refunded payment replays paid then refunded', async () => {
      withPayment({ status: PaymentStatus.REFUNDED });
      await service.process(job());
      expect(
        appointments.applyPaymentOutcome.mock.calls.map((c) => c[2]),
      ).toEqual(['paid', 'refunded']);
    });

    it('still grants an add-on whose payment was refunded before the job ran (the refund job reverses it)', async () => {
      withPayment({ status: PaymentStatus.REFUNDED, purpose: 'ADDON' });
      await service.process(job());
      expect(resources.applyPaid).toHaveBeenCalledWith(PAYMENT_ID);
    });
  });

  describe('failed', () => {
    it('ADDON → marks the purchase payment_failed', async () => {
      withPayment({ status: PaymentStatus.FAILED, purpose: 'ADDON' });
      const res = await service.process(job({ outcome: 'failed' }));
      expect(resources.applyFailed).toHaveBeenCalledWith(PAYMENT_ID);
      expect(res).toMatchObject({ consumers: ['resource-entitlement'] });
    });

    it('BILLING_UPGRADE → marks the request payment_failed', async () => {
      withPayment({ status: PaymentStatus.FAILED, purpose: 'BILLING_UPGRADE' });
      await service.process(job({ outcome: 'failed' }));
      expect(billing.applyFailed).toHaveBeenCalledWith(PAYMENT_ID);
    });

    it('BOOKING has no failed-payment consumer today — nothing is called', async () => {
      withPayment({ status: PaymentStatus.FAILED, purpose: 'BOOKING' });
      const res = await service.process(job({ outcome: 'failed' }));
      expect(appointments.applyPaymentOutcome).not.toHaveBeenCalled();
      expect(res).toMatchObject({ applied: true, consumers: [] });
    });

    it('NEVER regresses a late success: a failed job for a payment that is now PAID is a no-op', async () => {
      withPayment({ status: PaymentStatus.PAID, purpose: 'ADDON' });
      const res = await service.process(job({ outcome: 'failed' }));
      expect(resources.applyFailed).not.toHaveBeenCalled();
      expect(res).toMatchObject({ applied: true, consumers: [] });
    });
  });

  describe('refunded (the payment’s refunded state changed)', () => {
    it('reflects a full refund on the appointment', async () => {
      withPayment({ status: PaymentStatus.REFUNDED });
      const res = await service.process(job({ outcome: 'refunded' }));
      expect(appointments.applyPaymentOutcome).toHaveBeenCalledWith(
        TENANT,
        APPOINTMENT,
        'refunded',
      );
      expect(res).toMatchObject({ consumers: ['appointment'] });
    });

    it('reflects a partial refund on the appointment', async () => {
      withPayment({ status: PaymentStatus.PARTIALLY_REFUNDED });
      await service.process(job({ outcome: 'refunded' }));
      expect(appointments.applyPaymentOutcome).toHaveBeenCalledWith(
        TENANT,
        APPOINTMENT,
        'partially_refunded',
      );
    });

    it('is a no-op when the payment is not (or no longer) refunded, or has no appointment', async () => {
      withPayment({ status: PaymentStatus.PAID });
      await service.process(job({ outcome: 'refunded' }));
      withPayment({ status: PaymentStatus.REFUNDED, appointment: undefined });
      await service.process(job({ outcome: 'refunded' }));
      expect(appointments.applyPaymentOutcome).not.toHaveBeenCalled();
    });
  });

  describe('refund_recorded (entitlement reversal)', () => {
    it('reverses an ADDON in proportion to the CUMULATIVE succeeded total read NOW', async () => {
      withPayment({
        status: PaymentStatus.PARTIALLY_REFUNDED,
        purpose: 'ADDON',
      });
      dataSource.query.mockResolvedValueOnce([{ sum: '25.00' }]);

      const res = await service.process(
        job({ outcome: 'refund_recorded', refundId: 'refund-1' }),
      );

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(`status = 'SUCCEEDED'`),
        [PAYMENT_ID],
      );
      expect(resources.applyRefund).toHaveBeenCalledWith(
        PAYMENT_ID,
        'refund-1',
        2500,
      );
      expect(res).toMatchObject({ consumers: ['resource-entitlement'] });
    });

    it('rounds the cumulative total to whole minor units', async () => {
      withPayment({ purpose: 'ADDON' });
      dataSource.query.mockResolvedValueOnce([{ sum: '12.345' }]);
      await service.process(
        job({ outcome: 'refund_recorded', refundId: 'refund-1' }),
      );
      expect(resources.applyRefund).toHaveBeenCalledWith(
        PAYMENT_ID,
        'refund-1',
        1235,
      );
    });

    it('does nothing for a non-ADDON payment (only add-ons carry an entitlement)', async () => {
      withPayment({ purpose: 'BOOKING' });
      const res = await service.process(
        job({ outcome: 'refund_recorded', refundId: 'refund-1' }),
      );
      expect(resources.applyRefund).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(res).toMatchObject({ applied: true, consumers: [] });
    });

    it('rejects permanently when the refund id is missing', async () => {
      withPayment({ purpose: 'ADDON' });
      await expect(
        service.process(job({ outcome: 'refund_recorded' })),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });

  describe('failure handling', () => {
    it('PROPAGATES a consumer failure so BullMQ retries — it is never swallowed', async () => {
      withPayment({ purpose: 'ADDON' });
      resources.applyPaid.mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(service.process(job())).rejects.toThrow('deadlock detected');
    });

    it('propagates an appointment failure too', async () => {
      withPayment({ purpose: 'BOOKING' });
      appointments.applyPaymentOutcome.mockRejectedValueOnce(
        new Error('db down'),
      );
      await expect(service.process(job())).rejects.toThrow('db down');
    });

    it('is idempotent at this layer: running the same job twice calls the (idempotent) consumers twice, harmlessly', async () => {
      withPayment({ purpose: 'ADDON' });
      withPayment({ purpose: 'ADDON' });
      await service.process(job());
      await service.process(job());
      expect(resources.applyPaid).toHaveBeenCalledTimes(2);
    });
  });

  describe('duplicate-capture check (Tap Phase 5)', () => {
    it('after a BOOKING payment is applied, asks whether the booking now has two live captures', async () => {
      withPayment();
      await service.process(job());
      expect(exceptions.checkDuplicateBookingCapture).toHaveBeenCalledWith(
        PAYMENT_ID,
      );
    });

    it('not for a failed payment, a refund outcome, or an add-on', async () => {
      withPayment({ status: PaymentStatus.FAILED });
      await service.process(job({ outcome: 'failed' }));
      withPayment({ status: PaymentStatus.REFUNDED });
      await service.process(job({ outcome: 'refunded' }));
      withPayment({ purpose: 'ADDON', appointment: undefined });
      await service.process(job());
      expect(exceptions.checkDuplicateBookingCapture).not.toHaveBeenCalled();
    });

    it('a check that blows up never fails the outcome it rides on (the booking is already confirmed)', async () => {
      exceptions.checkDuplicateBookingCapture.mockRejectedValue(
        new Error('db hiccup'),
      );
      withPayment();

      await expect(service.process(job())).resolves.toMatchObject({
        applied: true,
      });
      expect(appointments.applyPaymentOutcome).toHaveBeenCalledWith(
        TENANT,
        APPOINTMENT,
        'paid',
      );
    });

    it('is optional: a consumer built without the exception service still applies the outcome', async () => {
      const bare = new PaymentOutcomeService(
        dataSource as never,
        appointments as never,
        billing as never,
        resources as never,
        paymentLinks as never,
      );
      withPayment();
      await expect(bare.process(job())).resolves.toMatchObject({
        applied: true,
      });
    });
  });
});
