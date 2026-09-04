import { Test, TestingModule } from '@nestjs/testing';

import { ReminderListener } from './reminder.listener';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { NotificationSchedulerService } from './notification-scheduler.service';

const TENANT = 't1';
const APPT = 'appt-1';

/**
 * T052 (US3, FR-M006/FR-M007) — the lifecycle bridge from appointment
 * events to `ReminderSchedulerService`/`NotificationSchedulerService`.
 */
describe('ReminderListener (T052, S3)', () => {
  let listener: ReminderListener;
  let reminders: { scheduleFor: jest.Mock; findActiveReminders: jest.Mock };
  let scheduler: { cancel: jest.Mock; reschedule: jest.Mock };

  beforeEach(async () => {
    reminders = {
      scheduleFor: jest.fn().mockResolvedValue(undefined),
      findActiveReminders: jest.fn().mockResolvedValue([]),
    };
    scheduler = {
      cancel: jest.fn().mockResolvedValue(undefined),
      reschedule: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReminderListener,
        { provide: ReminderSchedulerService, useValue: reminders },
        { provide: NotificationSchedulerService, useValue: scheduler },
      ],
    }).compile();
    listener = moduleRef.get(ReminderListener);
  });

  afterEach(() => jest.clearAllMocks());

  // P1.5 (MS-007): CREATED is deliberately NOT wired to this listener any
  // more — the auto-confirm path now schedules reminders via a
  // transactional outbox row written inside `AppointmentsService.create`'s
  // own transaction (see `notifications.processor.spec.ts`'s
  // `reminders.schedule` coverage for that path). This pins the absence:
  // if a future change accidentally reintroduces an `onCreated` handler,
  // this test fails loudly instead of the reminder silently double-firing.
  it('CREATED is not handled by this listener (moved to the outbox — P1.5)', () => {
    expect(
      (listener as unknown as { onCreated?: unknown }).onCreated,
    ).toBeUndefined();
  });

  it('CONFIRMED: schedules reminders too (the manual-confirm path)', async () => {
    await listener.onConfirmed({
      tenantId: TENANT,
      appointmentId: APPT,
    } as never);
    expect(reminders.scheduleFor).toHaveBeenCalledWith(TENANT, APPT);
  });

  it.each(['onCancelled', 'onCompleted', 'onNoShow'] as const)(
    'FR-M006: %s cancels every active reminder for the appointment',
    async (method) => {
      reminders.findActiveReminders.mockResolvedValueOnce([
        { id: 'sched-1', source_ref: `appointment-reminder:${APPT}:1440` },
        { id: 'sched-2', source_ref: `appointment-reminder:${APPT}:60` },
      ]);
      await listener[method]({
        tenantId: TENANT,
        appointmentId: APPT,
      } as never);
      expect(scheduler.cancel).toHaveBeenCalledWith(TENANT, 'sched-1');
      expect(scheduler.cancel).toHaveBeenCalledWith(TENANT, 'sched-2');
      expect(scheduler.reschedule).not.toHaveBeenCalled();
    },
  );

  it('a failure cancelling one reminder does not prevent cancelling the others', async () => {
    reminders.findActiveReminders.mockResolvedValueOnce([
      { id: 'sched-1', source_ref: `appointment-reminder:${APPT}:1440` },
      { id: 'sched-2', source_ref: `appointment-reminder:${APPT}:60` },
    ]);
    scheduler.cancel.mockRejectedValueOnce(new Error('already sent'));
    await listener.onCancelled({
      tenantId: TENANT,
      appointmentId: APPT,
    } as never);
    expect(scheduler.cancel).toHaveBeenCalledTimes(2);
  });

  describe('RESCHEDULED', () => {
    it('FR-M007: re-anchors a still-future reminder to the new start time', async () => {
      const newStartAt = new Date(Date.now() + 48 * 3600_000);
      reminders.findActiveReminders.mockResolvedValueOnce([
        { id: 'sched-1', source_ref: `appointment-reminder:${APPT}:1440` }, // 24h lead
      ]);
      await listener.onRescheduled({
        tenantId: TENANT,
        appointmentId: APPT,
        newStartAt,
      } as never);

      expect(scheduler.reschedule).toHaveBeenCalledWith(TENANT, 'sched-1', {
        scheduledAt: new Date(
          newStartAt.getTime() - 1440 * 60_000,
        ).toISOString(),
      });
      expect(scheduler.cancel).not.toHaveBeenCalled();
      // A lead time never scheduled against the OLD time gets a fresh
      // chance against the NEW one.
      expect(reminders.scheduleFor).toHaveBeenCalledWith(TENANT, APPT);
    });

    it('FR-M005: cancels (rather than sends late) when the new anchor for a lead time is already past', async () => {
      const newStartAt = new Date(Date.now() + 30 * 60_000); // 30 min away
      reminders.findActiveReminders.mockResolvedValueOnce([
        { id: 'sched-1', source_ref: `appointment-reminder:${APPT}:1440` }, // 24h lead — now unreachable
      ]);
      await listener.onRescheduled({
        tenantId: TENANT,
        appointmentId: APPT,
        newStartAt,
      } as never);

      expect(scheduler.cancel).toHaveBeenCalledWith(TENANT, 'sched-1');
      expect(scheduler.reschedule).not.toHaveBeenCalled();
    });

    it('ignores a row whose source_ref cannot be parsed for a lead time', async () => {
      reminders.findActiveReminders.mockResolvedValueOnce([
        { id: 'sched-1', source_ref: 'not-a-reminder-ref' },
      ]);
      await listener.onRescheduled({
        tenantId: TENANT,
        appointmentId: APPT,
        newStartAt: new Date(Date.now() + 48 * 3600_000),
      } as never);
      expect(scheduler.cancel).not.toHaveBeenCalled();
      expect(scheduler.reschedule).not.toHaveBeenCalled();
    });
  });
});
