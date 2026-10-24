import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { NotificationEventListener } from './notification-event.listener';
import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationRuleLibraryService } from './rule-library/rule-library.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { PatientActionLinkService } from '../patient-actions/patient-action-link.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * How ready-made rules turn appointment events into scheduled messages:
 * the auto-confirmed booking (D1), the idempotency key (D2), and cancel / move
 * (D3), plus quiet hours.
 */
describe('NotificationEventListener — rule scheduling', () => {
  let listener: NotificationEventListener;
  let rules: { findActiveByTrigger: jest.Mock };
  let scheduler: { schedule: jest.Mock; cancelRuleRows: jest.Mock };
  let appointments: MockRepository;
  let library: { recordRun: jest.Mock; timezoneOf: jest.Mock };

  /** Appointment 3 days ahead, in the clinic's morning. */
  const START = new Date(Date.now() + 3 * 24 * 3_600_000);

  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'rule-1',
    template: { id: 'tmpl-1' },
    delay_minutes: 0,
    anchor: 'AFTER_EVENT',
    rule_key: null,
    conditions: null,
    ...over,
  });

  const created = {
    tenantId: TENANT,
    customerId: 'cust-1',
    appointmentId: 'appt-1',
  } as never;

  /** The appointment row as the listener reads it: status check, start time, link issue. */
  const appointmentIs = (status: string, start = START) =>
    appointments.findOne.mockImplementation(
      ({ select }: { select?: Record<string, boolean> }) =>
        Promise.resolve(
          select?.status
            ? { id: 'appt-1', status }
            : { id: 'appt-1', start_at: start, status },
        ),
    );

  beforeEach(async () => {
    rules = { findActiveByTrigger: jest.fn().mockResolvedValue([]) };
    scheduler = {
      schedule: jest.fn().mockResolvedValue({ id: 's1' }),
      cancelRuleRows: jest.fn().mockResolvedValue(0),
    };
    appointments = createMockRepository();
    library = {
      recordRun: jest.fn().mockResolvedValue(undefined),
      timezoneOf: jest.fn().mockResolvedValue('Asia/Riyadh'),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationEventListener,
        { provide: NotificationRuleService, useValue: rules },
        { provide: NotificationSchedulerService, useValue: scheduler },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        {
          provide: PatientActionLinkService,
          useValue: { issue: jest.fn().mockResolvedValue('tok') },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => 'https://app.test') },
        },
        { provide: NotificationRuleLibraryService, useValue: library },
      ],
    }).compile();
    listener = moduleRef.get(NotificationEventListener);
  });

  afterEach(() => jest.clearAllMocks());

  /** Rules by trigger name. */
  const rulesFor = (map: Record<string, unknown[]>) =>
    rules.findActiveByTrigger.mockImplementation(
      (_t: string, trigger: string) => Promise.resolve(map[trigger] ?? []),
    );

  // ── D1 ───────────────────────────────────────────────────────────────────

  describe('an appointment created already CONFIRMED (D1)', () => {
    it('fires the confirmation rule even though no `confirmed` event is ever emitted', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({ 'appointment.confirmed': [rule()] });

      await listener.onAppointmentCreated(created);

      expect(scheduler.schedule).toHaveBeenCalledTimes(1);
      expect(scheduler.schedule.mock.calls[0][3]).toEqual(
        expect.objectContaining({
          rescheduleUrl: 'https://app.test/appointment-action/tok',
        }),
      );
    });

    it('uses the status carried on the event — no extra read straight after the booking transaction', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({ 'appointment.confirmed': [rule()] });

      await listener.onAppointmentCreated({
        ...(created as object),
        status: 'CONFIRMED',
      } as never);

      expect(scheduler.schedule).toHaveBeenCalledTimes(1);
      const statusReads = appointments.findOne.mock.calls.filter(
        ([q]) => (q as { select?: Record<string, boolean> }).select?.status,
      );
      expect(statusReads).toHaveLength(0);
    });

    it('trusts the status on the event: PENDING_PAYMENT on the event fires nothing', async () => {
      appointmentIs('CONFIRMED'); // would say CONFIRMED if it were (wrongly) re-read
      rulesFor({ 'appointment.confirmed': [rule()] });

      await listener.onAppointmentCreated({
        ...(created as object),
        status: 'PENDING_PAYMENT',
      } as never);

      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('does NOT fire it for an appointment still waiting for payment', async () => {
      appointmentIs('PENDING_PAYMENT');
      rulesFor({ 'appointment.confirmed': [rule()] });

      await listener.onAppointmentCreated(created);

      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('still fires `appointment.created` rules exactly as before', async () => {
      appointmentIs('PENDING_PAYMENT');
      rulesFor({ 'appointment.created': [rule({ id: 'rule-created' })] });

      await listener.onAppointmentCreated(created);

      expect(scheduler.schedule).toHaveBeenCalledTimes(1);
      expect(scheduler.schedule.mock.calls[0][2]).toBe(
        'rule:rule-created:created:appt-1',
      );
    });

    it('a later real `confirmed` event produces the SAME key, so it cannot double-send', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({ 'appointment.confirmed': [rule()] });

      await listener.onAppointmentCreated(created);
      await listener.onAppointmentConfirmed(created);

      const refs = scheduler.schedule.mock.calls.map((c) => c[2]);
      expect(refs).toEqual([
        'rule:rule-1:confirmed:appt-1',
        'rule:rule-1:confirmed:appt-1',
      ]);
    });
  });

  // ── D2 ───────────────────────────────────────────────────────────────────

  describe('idempotency key (D2)', () => {
    it('every rule-scheduled row carries a deterministic source_ref and its rule id', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({ 'appointment.confirmed': [rule()] });

      await listener.onAppointmentConfirmed(created);

      const call = scheduler.schedule.mock.calls[0];
      expect(call[2]).toBe('rule:rule-1:confirmed:appt-1');
      expect(call[4]).toBe('rule-1');
    });

    it('two rules on the same event get different keys', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({
        'appointment.confirmed': [rule({ id: 'a' }), rule({ id: 'b' })],
      });

      await listener.onAppointmentConfirmed(created);

      const refs = scheduler.schedule.mock.calls.map((c) => c[2]);
      expect(new Set(refs).size).toBe(2);
    });

    it('a BEFORE rule is pinned to the appointment time it was computed for', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({
        'appointment.confirmed': [
          rule({ anchor: 'BEFORE_APPOINTMENT_START', delay_minutes: 1440 }),
        ],
      });

      await listener.onAppointmentConfirmed(created);

      expect(scheduler.schedule.mock.calls[0][2]).toBe(
        `rule:rule-1:before:appt-1:${START.getTime()}`,
      );
    });

    it('a "your appointment moved" message is keyed by the NEW time, so a second move still sends', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({ 'appointment.rescheduled': [rule()] });
      const move = (t: Date) =>
        ({
          tenantId: TENANT,
          customerId: 'cust-1',
          appointmentId: 'appt-1',
          newStartAt: t,
        }) as never;

      await listener.onAppointmentRescheduled(
        move(new Date(START.getTime() + 1000)),
      );
      await listener.onAppointmentRescheduled(
        move(new Date(START.getTime() + 2000)),
      );

      const refs = scheduler.schedule.mock.calls
        .map((c) => c[2])
        .filter((r: string) => r.includes(':rescheduled:'));
      expect(new Set(refs).size).toBe(2);
    });

    it('events with no appointment (payments, handovers) get no key — they are legitimately repeatable', async () => {
      rulesFor({ 'payment.succeeded': [rule()] });
      await (
        listener as unknown as {
          onPaymentSucceeded: (e: unknown) => Promise<void>;
        }
      ).onPaymentSucceeded({ tenantId: TENANT, customerId: 'cust-1' });
      expect(scheduler.schedule.mock.calls[0][2]).toBeUndefined();
    });

    it('records the run on the rule, and the scrubbed error when scheduling fails', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({ 'appointment.confirmed': [rule()] });
      await listener.onAppointmentConfirmed(created);
      expect(library.recordRun).toHaveBeenCalledWith('rule-1');

      scheduler.schedule.mockRejectedValueOnce(new Error('queue down'));
      await listener.onAppointmentConfirmed(created);
      expect(library.recordRun).toHaveBeenCalledWith('rule-1', 'queue down');
    });

    it('one failing rule does not stop the next', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({
        'appointment.confirmed': [rule({ id: 'a' }), rule({ id: 'b' })],
      });
      scheduler.schedule.mockRejectedValueOnce(new Error('boom'));

      await listener.onAppointmentConfirmed(created);

      expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    });
  });

  // ── D3 ───────────────────────────────────────────────────────────────────

  describe('cancel / complete / no-show / move (D3)', () => {
    it.each([
      ['onAppointmentCancelled', {}],
      ['onAppointmentCompleted', {}],
      ['onAppointmentNoShow', {}],
    ])(
      '%s cancels the pending "before" rows of that appointment',
      async (handler, extra) => {
        await (
          listener as unknown as Record<string, (e: unknown) => Promise<void>>
        )[handler]({
          tenantId: TENANT,
          customerId: 'cust-1',
          appointmentId: 'appt-1',
          ...extra,
        });
        expect(scheduler.cancelRuleRows).toHaveBeenCalledWith(
          TENANT,
          'rule:%:before:appt-1:%',
        );
      },
    );

    it('completing a visit schedules the post-visit rule AND stops its reminders', async () => {
      rulesFor({
        'appointment.completed': [rule({ id: 'post', delay_minutes: 120 })],
      });
      await listener.onAppointmentCompleted(created);
      expect(scheduler.cancelRuleRows).toHaveBeenCalled();
      expect(scheduler.schedule.mock.calls[0][2]).toBe(
        'rule:post:completed:appt-1',
      );
    });

    it('a cancel failure is logged and never blocks the rest', async () => {
      scheduler.cancelRuleRows.mockRejectedValueOnce(new Error('db'));
      rulesFor({ 'appointment.cancelled': [rule()] });
      await expect(
        listener.onAppointmentCancelled(created),
      ).resolves.toBeUndefined();
      expect(scheduler.schedule).toHaveBeenCalled();
    });

    it('moving a confirmed appointment cancels the old rows and re-schedules ONLY the "before" rules', async () => {
      const newStart = new Date(START.getTime() + 2 * 3_600_000);
      appointmentIs('CONFIRMED', newStart);
      const reminder = rule({
        id: 'reminder',
        anchor: 'BEFORE_APPOINTMENT_START',
        delay_minutes: 1440,
      });
      const confirmation = rule({ id: 'confirm' }); // AFTER_EVENT: must NOT be sent again
      rulesFor({ 'appointment.confirmed': [reminder, confirmation] });

      await listener.onAppointmentRescheduled({
        tenantId: TENANT,
        customerId: 'cust-1',
        appointmentId: 'appt-1',
        newStartAt: newStart,
      } as never);

      expect(scheduler.cancelRuleRows).toHaveBeenCalledWith(
        TENANT,
        'rule:%:before:appt-1:%',
      );
      const refs = scheduler.schedule.mock.calls.map((c) => c[2]);
      expect(refs).toContain(
        `rule:reminder:before:appt-1:${newStart.getTime()}`,
      );
      expect(refs.some((r: string) => r.startsWith('rule:confirm:'))).toBe(
        false,
      );
    });

    it('moving an appointment that is not confirmed does not schedule new reminders', async () => {
      appointmentIs('PENDING_PAYMENT');
      rulesFor({
        'appointment.confirmed': [
          rule({ anchor: 'BEFORE_APPOINTMENT_START', delay_minutes: 1440 }),
        ],
      });
      await listener.onAppointmentRescheduled({
        tenantId: TENANT,
        customerId: 'cust-1',
        appointmentId: 'appt-1',
        newStartAt: START,
      } as never);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });
  });

  // ── Quiet hours ──────────────────────────────────────────────────────────

  describe('send window', () => {
    it('moves a night-time reminder into the clinic window; the key still uses the appointment time', async () => {
      // Appointment 3 days ahead at 14:00 Riyadh → the 24h reminder lands at 14:00: inside.
      // Use an appointment at 04:00 Riyadh instead → reminder at 04:00: outside, moved to 09:00.
      const ridayh4 = new Date(START);
      ridayh4.setUTCHours(1, 0, 0, 0); // 01:00Z = 04:00 Riyadh
      appointmentIs('CONFIRMED', ridayh4);
      rulesFor({
        'appointment.confirmed': [
          rule({
            rule_key: 'reminder_24h',
            anchor: 'BEFORE_APPOINTMENT_START',
            delay_minutes: 1440,
            conditions: { sendWindow: { startHour: 9, endHour: 21 } },
          }),
        ],
      });

      await listener.onAppointmentConfirmed(created);

      const at = new Date(scheduler.schedule.mock.calls[0][1].scheduledAt);
      // 04:00 the day before is outside 09–21; the nearest allowed time is 09:00 that day.
      expect(at.getUTCHours()).toBe(6); // 09:00 Riyadh = 06:00Z
      expect(at.getTime()).toBeLessThan(ridayh4.getTime());
      expect(scheduler.schedule.mock.calls[0][2]).toBe(
        `rule:rule-1:before:appt-1:${ridayh4.getTime()}`,
      );
    });

    it('a hand-made rule (no rule_key) is never shifted', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({ 'appointment.confirmed': [rule({ delay_minutes: 0 })] });
      const before = Date.now();
      await listener.onAppointmentConfirmed(created);
      const at = new Date(
        scheduler.schedule.mock.calls[0][1].scheduledAt,
      ).getTime();
      expect(at).toBeGreaterThanOrEqual(before);
      expect(library.timezoneOf).not.toHaveBeenCalled();
    });

    it('the booking confirmation (no window) goes out at any hour', async () => {
      appointmentIs('CONFIRMED');
      rulesFor({
        'appointment.confirmed': [
          rule({ rule_key: 'booking_confirmation', conditions: {} }),
        ],
      });
      await listener.onAppointmentConfirmed(created);
      expect(library.timezoneOf).not.toHaveBeenCalled();
      expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    });
  });
});
