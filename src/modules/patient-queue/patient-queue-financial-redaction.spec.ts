import {
  redactQueueEntryFinancials,
  redactQueueListFinancials,
} from './patient-queue-financial-redaction';
import { QueueEntryView, QueueListResult } from './patient-queue.service';
import { AppointmentStatus, QueueState } from '../../entities/enums';

function makeEntry(): QueueEntryView {
  return {
    id: 'q-1',
    position: 1,
    state: QueueState.WAITING,
    arrivedAt: new Date(),
    waitingMinutes: 5,
    customer: { id: 'c-1', fullName: 'Jane Doe' },
    staff: { id: 's-1', name: 'Dr Ali' },
    appointment: {
      id: 'a-1',
      startAt: new Date(),
      status: AppointmentStatus.CONFIRMED,
      paymentStatus: 'PAID',
    },
  };
}

describe('redactQueueEntryFinancials', () => {
  it('leaves paymentStatus when the caller can view financials', () => {
    const view = makeEntry();
    expect(redactQueueEntryFinancials(view, true).appointment.paymentStatus).toBe(
      'PAID',
    );
  });

  it('removes appointment.paymentStatus, keeping every other field, when the caller cannot', () => {
    const view = makeEntry();
    const result = redactQueueEntryFinancials(view, false);
    expect(result.appointment).not.toHaveProperty('paymentStatus');
    expect(result.appointment.id).toBe('a-1');
    expect(result.appointment.status).toBe(AppointmentStatus.CONFIRMED);
    expect(result.customer.fullName).toBe('Jane Doe');
  });
});

describe('redactQueueListFinancials', () => {
  it('redacts every entry in the list when the caller cannot view financials', () => {
    const result: QueueListResult = {
      data: [makeEntry(), makeEntry()],
      total: 2,
      page: 1,
      limit: 20,
      asOf: new Date().toISOString(),
      scope: { staff: 'ALL' },
    };
    redactQueueListFinancials(result, false);
    for (const entry of result.data) {
      expect(entry.appointment).not.toHaveProperty('paymentStatus');
    }
  });

  it('leaves the list untouched when the caller can view financials', () => {
    const result: QueueListResult = {
      data: [makeEntry()],
      total: 1,
      page: 1,
      limit: 20,
      asOf: new Date().toISOString(),
      scope: { staff: 'ALL' },
    };
    redactQueueListFinancials(result, true);
    expect(result.data[0].appointment.paymentStatus).toBe('PAID');
  });
});
