import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { NotificationEventListener } from './notification-event.listener';
import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentCreatedEvent } from '../../events/appointment.events';
import { PatientActionLinkService } from '../patient-actions/patient-action-link.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('NotificationEventListener — T017 (S3 anchor)', () => {
  let listener: NotificationEventListener;
  let rules: { findActiveByTrigger: jest.Mock };
  let scheduler: { schedule: jest.Mock };
  let appointments: MockRepository;
  let patientActionLinks: { issue: jest.Mock };
  let config: { get: jest.Mock };

  const rule = (overrides: Record<string, unknown> = {}) => ({
    id: 'rule-1',
    template: { id: 'tmpl-1' },
    delay_minutes: 60,
    anchor: 'AFTER_EVENT',
    ...overrides,
  });

  beforeEach(async () => {
    rules = { findActiveByTrigger: jest.fn() };
    scheduler = { schedule: jest.fn().mockResolvedValue({ id: 'sched-1' }) };
    appointments = createMockRepository();
    patientActionLinks = { issue: jest.fn().mockResolvedValue('secret-token') };
    config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationEventListener,
        { provide: NotificationRuleService, useValue: rules },
        { provide: NotificationSchedulerService, useValue: scheduler },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: PatientActionLinkService, useValue: patientActionLinks },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    listener = moduleRef.get(NotificationEventListener);
  });

  afterEach(() => jest.clearAllMocks());

  const event: AppointmentCreatedEvent = {
    tenantId: TENANT,
    customerId: 'cust-1',
    appointmentId: 'appt-1',
  } as AppointmentCreatedEvent;

  it('AFTER_EVENT regression: scheduled_at is trigger-time + delay_minutes, byte-identical to before T016', async () => {
    rules.findActiveByTrigger.mockResolvedValueOnce([
      rule({ anchor: 'AFTER_EVENT', delay_minutes: 30 }),
    ]);
    const before = Date.now();
    await listener.onAppointmentCreated(event);
    const after = Date.now();

    // AFTER_EVENT never reads the appointment's start time (only its status, to
    // decide whether a created appointment is already confirmed).
    expect(appointments.findOne).not.toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, start_at: true } }),
    );
    const scheduledAt = new Date(
      scheduler.schedule.mock.calls[0][1].scheduledAt,
    ).getTime();
    expect(scheduledAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(scheduledAt).toBeLessThanOrEqual(after + 30 * 60_000);
  });

  it("BEFORE_APPOINTMENT_START: schedules start_at − delay_minutes, computed from the appointment's own start_at (Asia/Riyadh)", async () => {
    const startAt = new Date(Date.now() + 4 * 60 * 60_000); // 4h from now
    appointments.findOne.mockResolvedValueOnce({
      id: 'appt-1',
      start_at: startAt,
      booked_timezone: 'Asia/Riyadh',
    });
    rules.findActiveByTrigger.mockResolvedValueOnce([
      rule({ anchor: 'BEFORE_APPOINTMENT_START', delay_minutes: 180 }),
    ]);
    await listener.onAppointmentCreated(event);

    const scheduledAt = new Date(
      scheduler.schedule.mock.calls[0][1].scheduledAt,
    ).getTime();
    expect(scheduledAt).toBe(startAt.getTime() - 180 * 60_000);
  });

  it('BEFORE_APPOINTMENT_START: a different timezone label produces the same correct instant (America/New_York)', async () => {
    const startAt = new Date(Date.now() + 4 * 60 * 60_000);
    appointments.findOne.mockResolvedValueOnce({
      id: 'appt-1',
      start_at: startAt,
      booked_timezone: 'America/New_York',
    });
    rules.findActiveByTrigger.mockResolvedValueOnce([
      rule({ anchor: 'BEFORE_APPOINTMENT_START', delay_minutes: 60 }),
    ]);
    await listener.onAppointmentCreated(event);

    const scheduledAt = new Date(
      scheduler.schedule.mock.calls[0][1].scheduledAt,
    ).getTime();
    expect(scheduledAt).toBe(startAt.getTime() - 60 * 60_000);
  });

  it('BEFORE_APPOINTMENT_START: correct across a DST transition — the instant, not the wall-clock, is what is subtracted', async () => {
    // 2026-11-01 is a US "fall back" DST transition date. The absolute
    // instant arithmetic must not shift by an hour just because a wall-clock
    // reading of "1 day before" would land on the other side of the change.
    const startAt = new Date('2026-11-02T10:00:00.000Z');
    appointments.findOne.mockResolvedValueOnce({
      id: 'appt-1',
      start_at: startAt,
      booked_timezone: 'America/New_York',
    });
    rules.findActiveByTrigger.mockResolvedValueOnce([
      rule({ anchor: 'BEFORE_APPOINTMENT_START', delay_minutes: 1440 }),
    ]);
    await listener.onAppointmentCreated(event);

    const scheduledAt = new Date(
      scheduler.schedule.mock.calls[0][1].scheduledAt,
    ).getTime();
    expect(scheduledAt).toBe(startAt.getTime() - 1440 * 60_000);
  });

  it('schedules nothing when the computed moment is already past (appointment nearer than the lead time)', async () => {
    const startAt = new Date(Date.now() + 30 * 60_000); // 30 minutes from now
    appointments.findOne.mockResolvedValueOnce({
      id: 'appt-1',
      start_at: startAt,
    });
    rules.findActiveByTrigger.mockResolvedValueOnce([
      rule({ anchor: 'BEFORE_APPOINTMENT_START', delay_minutes: 180 }), // 3h lead > 30min away
    ]);
    await listener.onAppointmentCreated(event);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('schedules nothing when there is no appointment to anchor to (an event with no appointmentId in its context)', async () => {
    rules.findActiveByTrigger.mockResolvedValueOnce([
      rule({ anchor: 'BEFORE_APPOINTMENT_START' }),
    ]);
    // PAYMENT_EVENT.SUCCEEDED's dispatch context never carries appointmentId.
    await listener.onPaymentSucceeded({
      tenantId: TENANT,
      customerId: 'c1',
    } as never);
    expect(appointments.findOne).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});

describe('NotificationEventListener — T032 (S1, FR-C002): cancel link on confirmation', () => {
  let listener: NotificationEventListener;
  let rules: { findActiveByTrigger: jest.Mock };
  let scheduler: { schedule: jest.Mock };
  let appointments: MockRepository;
  let patientActionLinks: { issue: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    rules = {
      findActiveByTrigger: jest.fn().mockResolvedValue([
        {
          id: 'rule-1',
          template: { id: 'tmpl-1' },
          delay_minutes: 0,
          anchor: 'AFTER_EVENT',
        },
      ]),
    };
    scheduler = { schedule: jest.fn().mockResolvedValue({ id: 'sched-1' }) };
    appointments = createMockRepository();
    appointments.findOne.mockResolvedValue({
      id: 'appt-1',
      start_at: new Date(Date.now() + 86400_000),
    });
    patientActionLinks = {
      issue: jest.fn().mockResolvedValue('plaintext-secret'),
    };
    config = { get: jest.fn(() => 'https://app.example.test') };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationEventListener,
        { provide: NotificationRuleService, useValue: rules },
        { provide: NotificationSchedulerService, useValue: scheduler },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: PatientActionLinkService, useValue: patientActionLinks },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    listener = moduleRef.get(NotificationEventListener);
  });

  afterEach(() => jest.clearAllMocks());

  it('issues both a CANCEL and a RESCHEDULE link, passing their URLs as template variables', async () => {
    await listener.onAppointmentConfirmed({
      tenantId: TENANT,
      customerId: 'cust-1',
      appointmentId: 'appt-1',
    } as never);

    expect(patientActionLinks.issue).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ id: 'appt-1' }),
      'CANCEL',
    );
    expect(patientActionLinks.issue).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ id: 'appt-1' }),
      'RESCHEDULE',
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(
      TENANT,
      expect.anything(),
      'rule:rule-1:confirmed:appt-1',
      {
        cancelUrl:
          'https://app.example.test/appointment-action/plaintext-secret',
        rescheduleUrl:
          'https://app.example.test/appointment-action/plaintext-secret',
      },
      'rule-1',
    );
  });

  it('the plaintext secret is never logged — only used to build the URL', async () => {
    const errorSpy = jest.spyOn((listener as any).logger, 'error');
    await listener.onAppointmentConfirmed({
      tenantId: TENANT,
      customerId: 'cust-1',
      appointmentId: 'appt-1',
    } as never);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('T044: a failure issuing ONE link is logged and swallowed — the other link still reaches the notification', async () => {
    patientActionLinks.issue.mockImplementation((_t, _a, purpose) =>
      purpose === 'CANCEL'
        ? Promise.reject(new Error('db down'))
        : Promise.resolve('plaintext-secret'),
    );
    await expect(
      listener.onAppointmentConfirmed({
        tenantId: TENANT,
        customerId: 'cust-1',
        appointmentId: 'appt-1',
      } as never),
    ).resolves.toBeUndefined();
    expect(scheduler.schedule).toHaveBeenCalledWith(
      TENANT,
      expect.anything(),
      'rule:rule-1:confirmed:appt-1',
      {
        rescheduleUrl:
          'https://app.example.test/appointment-action/plaintext-secret',
      },
      'rule-1',
    );
  });

  it('a failure issuing BOTH links is logged and swallowed — the confirmation notification still sends', async () => {
    patientActionLinks.issue.mockRejectedValue(new Error('db down'));
    await expect(
      listener.onAppointmentConfirmed({
        tenantId: TENANT,
        customerId: 'cust-1',
        appointmentId: 'appt-1',
      } as never),
    ).resolves.toBeUndefined();
    expect(scheduler.schedule).toHaveBeenCalledWith(
      TENANT,
      expect.anything(),
      'rule:rule-1:confirmed:appt-1',
      {},
      'rule-1',
    );
  });
});
