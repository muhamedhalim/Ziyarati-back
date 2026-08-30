import { Test, TestingModule } from '@nestjs/testing';

import { WaitlistListener } from './waitlist.listener';
import { QueueService } from '../../queue/queue.service';

describe('WaitlistListener (T159, US9, FR-W005)', () => {
  let listener: WaitlistListener;
  let queue: { enqueueWaitlistEvaluate: jest.Mock };

  beforeEach(async () => {
    queue = { enqueueWaitlistEvaluate: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [WaitlistListener, { provide: QueueService, useValue: queue }],
    }).compile();
    listener = moduleRef.get(WaitlistListener);
  });

  afterEach(() => jest.clearAllMocks());

  it('a cancellation enqueues EXACTLY ONE evaluation, with just tenantId + appointmentId', async () => {
    await listener.onAppointmentCancelled({
      tenantId: 't1',
      appointmentId: 'appt-1',
    } as never);

    expect(queue.enqueueWaitlistEvaluate).toHaveBeenCalledTimes(1);
    expect(queue.enqueueWaitlistEvaluate).toHaveBeenCalledWith({
      tenantId: 't1',
      appointmentId: 'appt-1',
    });
  });

  it('a reschedule enqueues evaluation carrying the FREED (old) slot snapshot, not the new one', async () => {
    await listener.onAppointmentRescheduled({
      tenantId: 't1',
      appointmentId: 'appt-1',
      newStartAt: new Date('2031-02-01T00:00:00.000Z'),
      oldStartAt: new Date('2031-01-01T09:00:00.000Z'),
      oldEndAt: new Date('2031-01-01T10:00:00.000Z'),
      branchId: 'b1',
      staffId: 's1',
    } as never);

    expect(queue.enqueueWaitlistEvaluate).toHaveBeenCalledWith({
      tenantId: 't1',
      appointmentId: 'appt-1',
      freedStartAt: '2031-01-01T09:00:00.000Z',
      freedEndAt: '2031-01-01T10:00:00.000Z',
      freedBranchId: 'b1',
      freedStaffId: 's1',
    });
  });

  it('a reschedule event missing its freed-slot snapshot is skipped defensively (never enqueues with the wrong/new time)', async () => {
    await listener.onAppointmentRescheduled({
      tenantId: 't1',
      appointmentId: 'appt-1',
      newStartAt: new Date('2031-02-01T00:00:00.000Z'),
    } as never);

    expect(queue.enqueueWaitlistEvaluate).not.toHaveBeenCalled();
  });

  it('a queue failure is logged and swallowed, never thrown — never rolls back the cancellation/reschedule that triggered it', async () => {
    queue.enqueueWaitlistEvaluate.mockRejectedValueOnce(
      new Error('redis down'),
    );
    await expect(
      listener.onAppointmentCancelled({
        tenantId: 't1',
        appointmentId: 'appt-1',
      } as never),
    ).resolves.toBeUndefined();
  });
});
