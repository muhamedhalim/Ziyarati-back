import {
  redactAppointmentFinancials,
  redactAppointmentListFinancials,
  redactTimelineFinancials,
} from './appointment-financial-redaction';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { TimelineEntry } from './appointment.service';

/** Minimal shape exercising every field the redaction functions touch. */
function makeAppointment(): Appointment {
  return {
    id: 'appt-1',
    total_amount: 150,
    payment_status: 'PAID',
    currency: 'SAR',
    services: [
      {
        id: 'as-1',
        price: 150,
        service: { id: 'svc-1', base_price: 150, pricing_type: 'FIXED' },
      },
    ],
  } as unknown as Appointment;
}

describe('redactAppointmentFinancials', () => {
  it('leaves the appointment untouched when the caller can view financials', () => {
    const appt = makeAppointment();
    const result = redactAppointmentFinancials(appt, true);
    expect(result).toBe(appt);
    expect(result.total_amount).toBe(150);
    expect(result.services[0].price).toBe(150);
  });

  it('removes total_amount/payment_status/currency and per-line price/base_price/pricing_type when the caller cannot', () => {
    const appt = makeAppointment();
    const result = redactAppointmentFinancials(appt, false);
    expect(result).not.toHaveProperty('total_amount');
    expect(result).not.toHaveProperty('payment_status');
    expect(result).not.toHaveProperty('currency');
    expect(result.services[0]).not.toHaveProperty('price');
    expect((result.services[0] as any).service).not.toHaveProperty(
      'base_price',
    );
    expect((result.services[0] as any).service).not.toHaveProperty(
      'pricing_type',
    );
    // Non-financial fields survive.
    expect(result.id).toBe('appt-1');
    expect((result.services[0] as any).service.id).toBe('svc-1');
  });

  it('is a no-op on a null/undefined appointment (never throws)', () => {
    expect(redactAppointmentFinancials(null as any, false)).toBeNull();
  });

  it('tolerates an appointment with no services array', () => {
    const appt = { id: 'appt-2', total_amount: 10 } as unknown as Appointment;
    expect(() => redactAppointmentFinancials(appt, false)).not.toThrow();
    expect(appt).not.toHaveProperty('total_amount');
  });
});

describe('redactAppointmentListFinancials', () => {
  it('redacts every row when the caller cannot view financials', () => {
    const list = [makeAppointment(), makeAppointment()];
    const result = redactAppointmentListFinancials(list, false);
    for (const appt of result) {
      expect(appt).not.toHaveProperty('total_amount');
    }
  });

  it('leaves every row untouched when the caller can', () => {
    const list = [makeAppointment()];
    expect(redactAppointmentListFinancials(list, true)[0].total_amount).toBe(
      150,
    );
  });
});

describe('redactTimelineFinancials', () => {
  const entries: TimelineEntry[] = [
    { type: 'note', at: new Date(), data: { content: 'hi' } },
    {
      type: 'cancellation',
      at: new Date(),
      data: { reason: 'no-show', by: 'u1', refundAmount: 50 },
    },
  ];

  it('leaves entries untouched when the caller can view financials', () => {
    expect(redactTimelineFinancials(entries, true)).toBe(entries);
  });

  it('strips refundAmount from a cancellation entry, keeping the rest', () => {
    const result = redactTimelineFinancials(entries, false);
    expect(result[0]).toEqual(entries[0]); // untouched, non-cancellation entry
    expect(result[1].data).not.toHaveProperty('refundAmount');
    expect(result[1].data).toMatchObject({ reason: 'no-show', by: 'u1' });
    // Original array/object are not mutated — new objects only.
    expect(entries[1].data).toHaveProperty('refundAmount');
  });
});
