import { Test, TestingModule } from '@nestjs/testing';

import { WebhookEventListener } from './webhook-event.listener';
import { WebhookDeliveryService } from './webhook-delivery.service';
import {
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentConfirmedEvent,
  AppointmentCreatedEvent,
  AppointmentNoShowEvent,
  AppointmentRescheduledEvent,
} from '../../events/appointment.events';
import { PaymentFailedEvent, PaymentRefundedEvent, PaymentSucceededEvent } from '../../events/payment.events';

describe('WebhookEventListener', () => {
  let listener: WebhookEventListener;
  let delivery: { dispatchEvent: jest.Mock };

  beforeEach(async () => {
    delivery = { dispatchEvent: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [WebhookEventListener, { provide: WebhookDeliveryService, useValue: delivery }],
    }).compile();
    listener = moduleRef.get(WebhookEventListener);
  });

  it('appointment.created carries ids + startAt only (payload policy)', async () => {
    const startAt = new Date('2026-01-01T10:00:00Z');
    await listener.onAppointmentCreated(
      new AppointmentCreatedEvent('t1', 'a1', 'c1', 's1', 'b1', startAt),
    );
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'appointment.created', {
      appointmentId: 'a1',
      customerId: 'c1',
      staffId: 's1',
      branchId: 'b1',
      startAt,
    });
  });

  it('appointment.confirmed', async () => {
    const startAt = new Date();
    await listener.onAppointmentConfirmed(new AppointmentConfirmedEvent('t1', 'a1', 'c1', startAt));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'appointment.confirmed', {
      appointmentId: 'a1',
      customerId: 'c1',
      startAt,
    });
  });

  it('appointment.cancelled includes the reason', async () => {
    await listener.onAppointmentCancelled(new AppointmentCancelledEvent('t1', 'a1', 'c1', 'patient request'));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'appointment.cancelled', {
      appointmentId: 'a1',
      customerId: 'c1',
      reason: 'patient request',
    });
  });

  it('appointment.completed', async () => {
    await listener.onAppointmentCompleted(new AppointmentCompletedEvent('t1', 'a1', 'c1'));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'appointment.completed', {
      appointmentId: 'a1',
      customerId: 'c1',
    });
  });

  it('appointment.rescheduled includes newStartAt', async () => {
    const newStartAt = new Date('2026-02-02T10:00:00Z');
    await listener.onAppointmentRescheduled(new AppointmentRescheduledEvent('t1', 'a1', 'c1', newStartAt));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'appointment.rescheduled', {
      appointmentId: 'a1',
      customerId: 'c1',
      newStartAt,
    });
  });

  it('appointment.no_show', async () => {
    await listener.onAppointmentNoShow(new AppointmentNoShowEvent('t1', 'a1', 'c1'));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'appointment.no_show', {
      appointmentId: 'a1',
      customerId: 'c1',
    });
  });

  it('payment.succeeded includes amount/currency', async () => {
    await listener.onPaymentSucceeded(new PaymentSucceededEvent('t1', 'p1', 5000, 'SAR', 'c1', 'a1'));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'payment.succeeded', {
      paymentId: 'p1',
      amount: 5000,
      currency: 'SAR',
      customerId: 'c1',
      appointmentId: 'a1',
    });
  });

  it('payment.refunded includes isPartial', async () => {
    await listener.onPaymentRefunded(new PaymentRefundedEvent('t1', 'p1', 2500, 'SAR', 'c1', true, 'a1'));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'payment.refunded', {
      paymentId: 'p1',
      amount: 2500,
      currency: 'SAR',
      customerId: 'c1',
      isPartial: true,
      appointmentId: 'a1',
    });
  });

  it('payment.failed', async () => {
    await listener.onPaymentFailed(new PaymentFailedEvent('t1', 'p1', 'c1', 'a1'));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'payment.failed', {
      paymentId: 'p1',
      customerId: 'c1',
      appointmentId: 'a1',
    });
  });

  it('handles an undefined customerId/appointmentId as null (not crashing on optional fields)', async () => {
    await listener.onPaymentFailed(new PaymentFailedEvent('t1', 'p1', undefined, undefined));
    expect(delivery.dispatchEvent).toHaveBeenCalledWith('t1', 'payment.failed', {
      paymentId: 'p1',
      customerId: null,
      appointmentId: null,
    });
  });
});
